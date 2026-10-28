/**
 * quarantine.js — 隔离池（P0-1：稳定死亡源移出成品，不再下发给手机）
 *
 * 背景：score.js 会把「连续 3 次 content=false」的源判成 dead 层、weight=5，
 * 但 weight 只是排序权重 —— 阅读 App 不会因为 weight 低就跳过它。结果是
 * 手机里躺着几百个已知必死的源：搜一次书要并发打几百个死站，慢、耗电、被封 IP。
 *
 * 本脚本做三件事（只做这一件事，不碰规则/签名/评分逻辑）：
 *   1) 收：legado.json 里 weight<=5 的源 → 写入 quarantine.json，并从 legado.json 移除
 *   2) 放：quarantine.json 里已被健康报告证明复活（content===true）的源 → 解除隔离
 *   3) 拦：quarantine.json 由 filter.js 每轮读取，防止上游合并 / extra-sources 策展 /
 *          扩容池 / upstream 复活把这批源重新带进成品（实测 264 个隔离源里有 196 个
 *          同时躺在 extra-sources.json，不做这层拦截会隔天全部复活）
 *
 * 运行点：update.yml 里 fuse.js 之后、成品校验/签名之前。
 * 安全性：
 *   - 单轮新增隔离数 > 总量 30% → 拒绝（防评分逻辑被改坏时批量清库），exit 1 让 CI 红灯
 *   - 隔离后成品 < 100 个源 → 拒绝发布（防把库清空）
 *   - 读写/解析异常 → exit 1（fail-closed，绝不静默放行）
 *   - 只按 norm() 身份键比对，不会误伤同域不同路径的兄弟源
 *   - 人工加入：直接往 quarantine.json 里追加 {url,name,reason} 即可长期封禁
 *   - 幂等：重复运行不会重复计数，也不会重复删除
 */
'use strict';
const fs = require('fs');
const { norm } = require('./src/source-id');

const LEGADO = 'legado.json';
const HEALTH = 'health/source_health.json';
const QFILE = 'quarantine.json';
const REPORT = 'reports/quarantine.json';
const DEAD_WEIGHT = 5;          // score.js dead 层的权重
const MAX_RATIO = 0.30;         // 单轮新增隔离上限（防批量误杀）
const MIN_KEEP = 100;           // 隔离后成品下限
const NOW = Date.now();

function readJson(p, fallback) {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

try {
    const list = readJson(LEGADO, null);
    if (!Array.isArray(list)) throw new Error(LEGADO + ' 不是数组');

    // 健康报告缺失 → 无法判断复活，只做「收」，不做「放」
    let health = {};
    let healthOk = true;
    try {
        health = (readJson(HEALTH, { sources: {} }).sources) || {};
    } catch (e) {
        healthOk = false;
        console.log('⚠️ 健康报告不可读，本轮只做隔离、不做复活解除: ' + e.message);
    }

    // ── 既有名单：按 norm 建索引，保留原有 since ──
    let oldQ;
    try {
        const a = readJson(QFILE, []);
        oldQ = Array.isArray(a) ? a : [];
    } catch (e) {
        throw new Error('quarantine.json 解析失败（拒绝覆盖已有名单）: ' + e.message);
    }
    const qMap = new Map();
    for (const q of oldQ) {
        const k = norm(typeof q === 'string' ? q : (q && q.url));
        if (k) qMap.set(k, (typeof q === 'string' ? { url: q } : Object.assign({}, q)));
    }

    // ── 1) 收：本轮 dead 层 ──
    const toBan = [];
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        if (!k) continue;
        if (Number(s.weight) <= DEAD_WEIGHT && !qMap.has(k)) toBan.push({ k, s });
    }
    const total = list.length;
    if (toBan.length > 0 && (toBan.length + qMap.size) > total * MAX_RATIO) {
        console.error('× 本轮新增隔离 ' + toBan.length + ' 个，叠加既有名单后超过总量 ' + total +
            ' 的 ' + (MAX_RATIO * 100) + '%（既有 ' + qMap.size + ' 个）——疑似评分逻辑异常，拒绝执行。请人工确认后再跑。');
        process.exit(1);
    }
    for (const { k, s } of toBan) {
        qMap.set(k, {
            url: String(s.bookSourceUrl),
            name: String(s.bookSourceName || '').slice(0, 40),
            reason: 'stable-dead',
            since: NOW,
        });
    }

    // ── 2) 放：健康报告已证明复活的源解除隔离 ──
    const released = [];
    if (healthOk) {
        for (const [k, q] of [...qMap]) {
            const h = health[k];
            if (h && h.content === true) {
                qMap.delete(k);
                released.push(q);
            }
        }
    }

    // ── 3) 从成品剔除（含既有名单，防止 filter 之外的路径残留）──
    const out = [];
    let stripped = 0;
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        if (k && qMap.has(k)) { stripped++; continue; }
        out.push(s);
    }

    // ── 落盘 ──
    const qOut = [...qMap.entries()]
        .sort((a, b) => String(a[1].url || '').localeCompare(String(b[1].url || '')))
        .map(([, v]) => ({
            url: v.url || '',
            name: v.name || '',
            reason: v.reason || 'manual',
            since: v.since || NOW,
        }));
    fs.writeFileSync(QFILE, JSON.stringify(qOut, null, 1));

    const changed = stripped > 0 || released.length > 0 || toBan.length > 0;
    if (stripped > 0) fs.writeFileSync(LEGADO, JSON.stringify(out));

    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({
        generatedAt: NOW,
        totalBefore: total,
        totalAfter: out.length,
        newThisRound: toBan.map(x => ({ url: x.s.bookSourceUrl, name: x.s.bookSourceName || '' })),
        releasedThisRound: released,
        quarantineSize: qOut.length,
        stripped,
        changed,
    }, null, 1));

    console.log('隔离池: 成品 ' + total + ' → ' + out.length +
        '（本轮新增隔离 ' + toBan.length + '，解除 ' + released.length + '，名单共 ' + qOut.length + '，剔除 ' + stripped + '）');
    if (released.length) {
        console.log('  已恢复并解除隔离（下轮 filter 会自动放回成品）: ' +
            released.slice(0, 8).map(x => String(x.name || x.url).slice(0, 18)).join('、') +
            (released.length > 8 ? ' 等 ' + released.length + ' 个' : ''));
    }
    if (out.length < MIN_KEEP) {
        console.error('× 隔离后成品仅剩 ' + out.length + ' 个源（<' + MIN_KEEP + '），拒绝发布，请检查评分/健康报告是否异常');
        process.exit(1);
    }
} catch (e) {
    console.error('× 隔离池脚本异常（拒绝发布）: ' + (e.stack || e.message));
    process.exit(1);
}
