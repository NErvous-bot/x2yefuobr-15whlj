/**
 * quarantine-recheck.js — 隔离池复活复测（只允许在低权限 js-eval job 内运行）
 *
 * 背景（评审 P1）：
 *   quarantine.js 原本的「解除隔离」读 health/source_health.json 的 health[k]，
 *   但 health.js 只测 legado.json 里的源（L142），carried 也只沿用 inLib 内的源
 *   （L126-128）；而隔离源恰恰已被踢出 legado.json、且被 filter.js 每轮拦回流。
 *   ⇒ health[k] 恒为 undefined ⇒ 该分支是死代码，303 条名单只进不出。
 *
 * 本脚本补上那条缺失的回路：
 *   1) 读 quarantine-stash.json（quarantine.js 落盘的「被隔离源的完整对象」快照）
 *   2) 用 aging-test 的完整三关规则真实复测（搜索出书 → 目录≥1章 → 正文≥200字）
 *   3) 只把「本轮确实三关全过」的 URL 写进 quarantine-release.json
 *   4) quarantine.js 下轮读这份报告，按 30% 上限解除隔离
 *
 * 为什么必须跑在这里：
 *   复测会执行书源 <js>/@js: 脚本 = 不可信代码。本 job 是 contents:read、
 *   零 Secrets、persist-credentials:false 的独立 runner，是唯一允许求值的地方。
 *
 * 安全与限额：
 *   - 单轮最多测 MAX_PER_RUN 个（默认 40），按 since 最老的优先
 *   - 复测并发 6，总预算 BUDGET_MS
 *   - 单源异常一律按「不复活」处理（宁可不放，不可误放）
 *   - 产物只含 URL 字符串数组，不含任何源内容
 *   - 报告或快照缺失 → 输出空 release（不阻断本 job 的健康检查主流程）
 */
'use strict';
const fs = require('fs');

const STASH = 'quarantine-stash.json';
const QFILE = 'quarantine.json';
const OUT = 'quarantine-release.json';
const MAX_PER_RUN = Number(process.env.QUAR_MAX || 40);
const CONC = 6;
const BUDGET_MS = 20 * 60 * 1000;

const now = Date.now();

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

function writeOut(release, extra) {
    fs.writeFileSync(OUT, JSON.stringify(Object.assign({
        generatedAt: now,
        release,
    }, extra || {}), null, 1));
    console.log('隔离池复测: 产出 ' + OUT + '，可解除 ' + release.length + ' 个');
}

(async () => {
    const stash = readJson(STASH);
    if (!stash || typeof stash !== 'object') {
        console.log('隔离池复测: 无 ' + STASH + '（首轮或隔离名单为空），跳过');
        writeOut([], { skipped: 'no-stash' });
        return;
    }

    // 顺序：按 quarantine.json 的 since 最老优先，没有 since 的排最后
    const meta = {};
    const ql = readJson(QFILE);
    if (Array.isArray(ql)) {
        for (const q of ql) {
            if (q && typeof q === 'object' && q.url) meta[String(q.url)] = Number(q.since) || 0;
        }
    }

    const keys = Object.keys(stash).filter(k => stash[k] && typeof stash[k] === 'object');
    if (!keys.length) {
        console.log('隔离池复测: stash 为空，跳过');
        writeOut([], { skipped: 'empty-stash' });
        return;
    }
    keys.sort((a, b) => {
        const sa = meta[stash[a].bookSourceUrl] || 0, sb = meta[stash[b].bookSourceUrl] || 0;
        if (sa !== sb) return sa - sb;
        return a.localeCompare(b);
    });
    const todo = keys.slice(0, MAX_PER_RUN);
    console.log('隔离池复测: 名单 ' + keys.length + ' 个，本轮实测 ' + todo.length + ' 个（上限 ' + MAX_PER_RUN + '）');

    let checkSource;
    try {
        // eslint-disable-next-line global-require
        checkSource = require('./aging-test').checkSource;
    } catch (e) {
        console.error('× 无法加载 aging-test（复测不可执行，输出空 release）: ' + e.message);
        writeOut([], { skipped: 'no-aging-test' });
        return;
    }

    const t0 = Date.now();
    const release = [];
    const rows = [];
    let idx = 0;

    async function worker() {
        while (idx < todo.length) {
            if (Date.now() - t0 > BUDGET_MS) return;
            const k = todo[idx++];
            const s = stash[k];
            let r;
            try {
                r = await checkSource(s);
            } catch (e) {
                rows.push({ url: s.bookSourceUrl, ok: false, reason: 'exception:' + (e && e.message ? String(e.message).slice(0, 40) : 'unknown') });
                continue;
            }
            const usable = r && r.usable === true;
            // 只放「三关全过」的源；skip（规则不可测/网络失败）不算复活，绝不解除
            const ok = usable && r.search !== false && r.toc !== false && r.content !== false;
            rows.push({
                url: s.bookSourceUrl,
                ok,
                reason: ok ? '三关全过' : String((r && r.reason) || 'not-usable').slice(0, 60),
                chapters: r && r.chapters,
                contentLen: r && r.contentLen,
            });
            if (ok && !release.includes(s.bookSourceUrl)) release.push(s.bookSourceUrl);
        }
    }

    await Promise.all(Array.from({ length: CONC }, worker));

    // 二次校验：release 里的 URL 必须真实存在于 stash（防脚本异常拼出陌生 URL）
    const safe = release.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && keys.some(k => stash[k].bookSourceUrl === u));

    const revived = rows.filter(x => x.ok);
    console.log('隔离池复测: 实测 ' + rows.length + ' 个 → 复活候选 ' + revived.length +
        (revived.length ? '（' + revived.slice(0, 8).map(x => String(x.url).slice(0, 40)).join('、') +
            (revived.length > 8 ? ' 等' + revived.length + '个' : '') + '）' : ''));

    writeOut(safe, {
        total: keys.length,
        tested: rows.length,
        revived: revived.length,
        droppedBySafety: release.length - safe.length,
        rows,
    });
})().catch(e => {
    console.error('× 隔离池复测异常（输出空 release，不阻断主流程）: ' + (e && e.stack ? e.stack : e));
    try { writeOut([], { error: String(e && e.message ? e.message : e) }); } catch (_) {}
});
