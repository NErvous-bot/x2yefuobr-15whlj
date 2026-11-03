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
const STASH = 'quarantine-stash.json';
const DEAD_WEIGHT = 5;          // score.js dead 层的权重
const MAX_RATIO = 0.30;         // 单轮新增隔离上限（防批量误杀）
const MIN_KEEP = 100;           // 隔离后成品下限
// 历史隔离项已不在 legado.json，只沉淀在这些来源池里（实测 extra-sources.json
// 覆盖 303 条名单中的 221 条：72.9%）。复测要拿到完整源对象必须回溯这些池。
const POOL_FILES = ['extra-sources.json', 'legado-cross.json', 'harvested.json'];
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
    // 阈值只约束「本轮新增」：历史隔离项本来就不在成品里，若把它们计入比例，
    // 名单越积越多会让「新增 1 个也超 30%」永久误拦（实证：237 历史 + 23 新增
    // vs 总量 719 → 超限，CI 在第 63 轮被阻断）。防批量误杀看本轮新增，
    // 防把库清空看下面的 MIN_KEEP，历史累积规模只作观察、不阻断。
    if (toBan.length > 0 && toBan.length > total * MAX_RATIO) {
        console.error('× 本轮新增隔离 ' + toBan.length + ' 个，超过总量 ' + total +
            ' 的 ' + (MAX_RATIO * 100) + '%——疑似评分逻辑异常，拒绝执行。请人工确认后再跑。');
        process.exit(1);
    }
    if (qMap.size > total * MAX_RATIO) {
        console.log('  提示：历史隔离名单 ' + qMap.size + ' 个已超过本轮总量 ' + total +
            ' 的 ' + (MAX_RATIO * 100) + '%（正常累积，不阻断发布，仅供参考）');
    }
    for (const { k, s } of toBan) {
        qMap.set(k, {
            url: String(s.bookSourceUrl),
            name: String(s.bookSourceName || '').slice(0, 40),
            reason: 'stable-dead',
            since: NOW,
        });
        // 完整源对象挂在内存里，供本次落 quarantine-stash.json（不写进 qOut）
        qMap.get(k).__src = s;
    }

    // ── 2) 放：由隔离池专属复测报告解除隔离（评审 P1：原实现是死代码）──
    // 原实现读 health[k]，但 k 必须出现在 health/source_health.json 的 sources 里；
    // 而 health.js 只测 legado.json 内的源（L142）、carried 也只沿用 inLib 内的源
    // （L126-128），隔离源恰恰已被踢出 legado.json 且被 filter.js 每轮拦回流
    // ⇒ health[k] 恒为 undefined ⇒ released 恒为空 ⇒ 名单只进不出。
    // 现改为消费 js-eval.yml 产出的 quarantine-release.json（在那份低权限 job 里
    // 以完整规则真实复测，是本仓库唯一允许执行书源 JS 的地方）。
    const released = [];
    let relReport = null;
    try { relReport = JSON.parse(fs.readFileSync('reports/quarantine-release.json', 'utf8')); }
    catch (_) {
        try { relReport = JSON.parse(fs.readFileSync('quarantine-release.json', 'utf8')); } catch (_) {}
    }
    if (relReport && Array.isArray(relReport.release)) {
        const cap = Math.max(1, Math.ceil(qMap.size * MAX_RATIO));
        if (relReport.release.length > cap) {
            console.log('  提示：本轮复测建议解除 ' + relReport.release.length + ' 个，超过名单 ' +
                qMap.size + ' 的 ' + (MAX_RATIO * 100) + '%（= ' + cap + '），按上限截断，防复测异常时批量放生');
        }
        for (const u of relReport.release.slice(0, cap)) {
            const k = norm(u);
            if (k && qMap.has(k)) { released.push(qMap.get(k)); qMap.delete(k); }
        }
    } else {
        console.log('  （本轮无隔离池复测报告，跳过解除；名单只做累积与人工维护）');
    }

    // ── 3) 从成品剔除（含既有名单，防止 filter 之外的路径残留）──
    const out = [];
    let stripped = 0;
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        if (k && qMap.has(k)) { stripped++; continue; }
        out.push(s);
    }

    // ── 先算，再判，最后才落盘 ──
    // 顺序很关键：MIN_KEEP 检查曾经写在 writeFileSync 之后，一旦触发 exit 1，
    // 磁盘上 legado.json / quarantine.json / reports 其实已经被改过了。
    // 结果是「退出码 1」不能推出「文件没动」，对回滚和审计都是隐患。
    // 现在改成：所有硬性检查通过之后才第一次写盘，退出码非 0 时磁盘保证是原样。
    // 隔离条目本身只存 {url,name}，缺 searchRule 等字段无法复测。故另落一份
    // 完整源对象快照 quarantine-stash.json，供 js-eval job 下轮真实复测。
    //
    // ⚠ 关键：历史隔离项早已不在 legado.json 里（实测本仓库 303 条隔离源对
    // legado.json 的覆盖率为 0%，全部沉淀在 extra-sources.json 里，覆盖 221/303）。
    // 若只从 list（= legado.json）取对象，stash 对历史名单恒为空 ⇒ 复测永远拿不到
    // 源 ⇒ 「放」这条回路在真数据上依然是死的。因此顺序是：
    //   ① list 内的（本轮新隔离）——对象最新最全，优先
    //   ② 已有 stash 的（上轮留下的）——保留，避免每轮重建时丢对象
    //   ③ extra-sources.json 等来源池——历史隔离项的唯一可回溯来源
    // 三者按身份键合并，先到先得，绝不覆盖已有完整对象。
    const stash = {};
    const put = (s) => {
        if (!s || typeof s !== 'object') return;
        const k = norm(s.bookSourceUrl);
        if (k && qMap.has(k) && !stash[k]) stash[k] = s;
    };
    // ② 先接上轮快照
    try {
        const prev = readJson(STASH, {});
        if (prev && typeof prev === 'object') {
            for (const [k, v] of Object.entries(prev)) if (qMap.has(k) && !stash[k]) stash[k] = v;
        }
    } catch (_) {}
    // ① 本轮在库的
    for (const s of list) put(s);
    // ③ 历史池回溯（只读，不改这些文件）
    for (const f of POOL_FILES) {
        const arr = readJson(f, null);
        if (!Array.isArray(arr)) continue;
        for (const s of arr) put(s);
    }

    const qOut = [...qMap.entries()]
        .sort((a, b) => String(a[1].url || '').localeCompare(String(b[1].url || '')))
        .map(([, v]) => ({
            // __src 是内存内完整源对象，绝不落盘（quarantine.json 只留元数据）
            url: v.url || '',
            name: v.name || '',
            reason: v.reason || 'manual',
            since: v.since || NOW,
        }));

    // 硬性闸门①：隔离后成品不能少于 MIN_KEEP（防评分/健康报告异常时把库清空）
    if (out.length < MIN_KEEP) {
        console.error('× 隔离后成品仅剩 ' + out.length + ' 个源（<' + MIN_KEEP + '），拒绝发布；'
            + '本轮未改动任何文件（legado.json / quarantine.json / reports 均保持原样），请检查评分与健康报告');
        process.exit(1);
    }

    // ── 落盘（到这里所有闸门都已通过）──
    fs.writeFileSync(QFILE, JSON.stringify(qOut, null, 1));
    // 完整源对象快照（供下轮隔离池复测）。由 update.yml 一并提交。
    try { fs.writeFileSync('quarantine-stash.json', JSON.stringify(stash)); }
    catch (e) {
        console.error('× 隔离池快照写入失败（拒绝发布，避免下轮复测失去依据）: ' + e.message);
        process.exit(1);
    }

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
} catch (e) {
    console.error('× 隔离池脚本异常（拒绝发布）: ' + (e.stack || e.message));
    process.exit(1);
}
