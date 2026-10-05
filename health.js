// health.js — 源级健康检查：对 legado.json 里的源做三关真实实测，生成 health/source_health.json
// 实测复用 aging-test.js（搜索出书→目录≥1章→正文≥200字），GitHub 端定期体检，手机端只看结果
// 带时间预算：超时未测的源沿用上一轮健康数据（每轮优先测最久没测的，最终全库都会轮到）
const fs = require('fs');
const { checkSource } = require('./aging-test');

const BUDGET_MIN = 20;  // 单轮实测时间预算（分钟）
const CONC = 10;        // 并发数

function norm(u) {
    try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); }
    catch (e) { return null; }
}

// 由实测结果推导各关通过情况（reason 含失败关卡信息）
function gatesOf(r) {
    const ok = r.usable === true;
    const reason = r.reason || '';
    return {
        search: ok || /^(目录|书籍页|正文)/.test(reason),
        toc: ok || /^正文/.test(reason),
        content: ok
    };
}

// 评分（GitHub端可测部分，满分100）：搜索出书30 + 目录30 + 正文25 + 响应速度0~15
// 不可测（js规则/反爬/网络失败）→ null，不给分也不判死
function scoreOf(r, g, ms) {
    if (r.usable === 'skip') return null;
    const base = (g.search ? 30 : 0) + (g.toc ? 30 : 0) + (g.content ? 25 : 0);
    const bonus = ms < 1000 ? 15 : ms < 2000 ? 12 : ms < 3500 ? 8 : 3;
    return Math.min(100, base + bonus);
}

(async () => {
    const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
    if (!fs.existsSync('health')) fs.mkdirSync('health');
    const HFILE = 'health/source_health.json';
    let old = { sources: {} };
    try { old = JSON.parse(fs.readFileSync(HFILE, 'utf8')); } catch (e) {}
    const oldMap = old.sources || {};

    // 优先实测：从没测过 / 最久没测的源
    const targets = list.slice().sort((a, b) =>
        ((oldMap[norm(a.bookSourceUrl)] || {}).checkedAt || 0) - ((oldMap[norm(b.bookSourceUrl)] || {}).checkedAt || 0));
    const t0 = Date.now();
    const tested = [];
    let i = 0;
    async function worker() {
        while (i < targets.length && Date.now() - t0 < BUDGET_MIN * 60000) {
            const s = targets[i++]; const t1 = Date.now();
            tested.push([s, await checkSource(s), Date.now() - t1]);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    const now = Date.now();
    const sources = {};
    const testedKeys = new Set();
    let usable = 0, dead = 0, untestable = 0, scoreSum = 0, scoreN = 0;
    for (const [s, r, ms] of tested) {
        const k = norm(s.bookSourceUrl); if (!k) continue;
        testedKeys.add(k);
        const g = gatesOf(r);
        const h = scoreOf(r, g, ms);
        if (h === null) untestable++;
        else if (g.content) { usable++; scoreSum += h; scoreN++; }
        else dead++;
        sources[k] = {
            name: String(s.bookSourceName || '').slice(0, 30),
            health: h, search: g.search, toc: g.toc, content: g.content,
            chapters: r.chapters || 0, contentLen: r.contentLen || 0,
            responseTime: ms, note: String(r.reason || '').slice(0, 30), checkedAt: now
        };
    }
    // 未实测的源沿用上一轮数据；已不在库里的源丢弃
    const inLib = new Set(list.map(s => norm(s.bookSourceUrl)).filter(Boolean));
    let carried = 0;
    for (const [k, v] of Object.entries(oldMap)) {
        if (!testedKeys.has(k) && inLib.has(k)) { sources[k] = v; carried++; }
    }

    const out = {
        updatedAt: now,
        summary: { total: list.length, tested: tested.length, usable, broken: dead, untestable, carried },
        sources
    };
    fs.writeFileSync(HFILE, JSON.stringify(out));
    const avg = scoreN ? Math.round(scoreSum / scoreN) : 0;
    console.log('健康检查: 实测 ' + tested.length + '/' + list.length + ' 个（预算' + BUDGET_MIN + '分钟）→ 可用 ' + usable + ' / 确认坏 ' + dead + ' / 不可测 ' + untestable);
    console.log('健康检查: 全库平均健康分 ' + avg + '，沿用上轮数据 ' + carried + ' 个，已写入 ' + HFILE);
})().catch(e => { console.log('健康检查异常(不影响主流程): ' + e.message); process.exit(0); });
