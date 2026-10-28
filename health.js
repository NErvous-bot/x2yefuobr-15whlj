// health.js — 源级健康检查：对 legado.json 里的源做三关真实实测，生成 health/source_health.json
// 实测复用 aging-test.js（搜索出书→目录≥1章→正文≥200字），GitHub 端定期体检，手机端只看结果
// 带时间预算：超时未测的源沿用上一轮健康数据（每轮优先测最久没测的，最终全库都会轮到）
//
// 第④关「发现页」（2026-10-28 补，对齐官方 CheckSource.checkDiscovery 默认开）：
//   只对「三关全过且配了 exploreUrl」的源做探测，结果记进 explore 字段。
//   它不参与 usable 判定——发现页挂了不代表搜索/正文坏了，只作为能力标记，
//   score.js 据此打 `CI-发现失效` 分组，手机端按组筛即可。
const fs = require('fs');
const { checkSource, checkExplore } = require('./aging-test');
const { norm } = require('./src/source-id');

const BUDGET_MIN = 20;  // 单轮实测时间预算（分钟）
const CONC = 10;        // 并发数

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
            const r = await checkSource(s);
            // 第④关：只有三关全过、且确实配了发现入口的源才测发现页
            // （坏源测发现页纯浪费预算；没配 exploreUrl 的没有可测对象）
            let explore = null;
            if (r.usable === true && s.exploreUrl) {
                try {
                    const e = await checkExplore(s);
                    if (e.ok) {
                        explore = true;
                    } else {
                        // 区分「确定失效」与「测不了」：
                        //   确定失效（用户点发现页也一定是空的）→ false，打 CI-发现失效
                        //   测不了（js 生成 / 网络抖动 / 选择器超出测试器能力）→ null，不打标
                        const reason = String(e.reason || '');
                        const definite = /^(无发现入口|exploreRule为空|发现页404|发现页410|发现页HTTP|发现URL非法|发现页无书)/.test(reason);
                        explore = definite ? false : null;
                    }
                    r.exploreReason = e.reason || '';
                } catch (err) {
                    explore = null;
                }
            }
            tested.push([s, r, Date.now() - t1, explore]);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));

    const now = Date.now();
    const sources = {};
    const testedKeys = new Set();
    let usable = 0, dead = 0, untestable = 0, scoreSum = 0, scoreN = 0, flappingN = 0;
    let exploreOk = 0, exploreBad = 0;
    for (const [s, r, ms, explore] of tested) {
        const k = norm(s.bookSourceUrl); if (!k) continue;
        testedKeys.add(k);
        const g = gatesOf(r);
        const h = scoreOf(r, g, ms);
        if (h === null) untestable++;
        else {
            scoreSum += h; scoreN++;          // 坏源分数也计入均分，否则均分虚高
            if (g.content) usable++; else dead++;
        }
        if (explore === true) exploreOk++; else if (explore === false) exploreBad++;
        // 最近结果历史（FLAPPING 观察）：只记有结论的实测（pass/fail），不可测轮次不计入；
        // 窗口内既有 pass 又有 fail → 抖动观察期，不删不新增，下轮继续观察
        const prev = oldMap[k] || {};
        const recent = (Array.isArray(prev.recent) ? prev.recent : []).slice(-4);
        if (h !== null) recent.push(g.content ? 'pass' : 'fail');
        const flapping = recent.includes('pass') && recent.includes('fail');
        if (flapping) flappingN++;
        sources[k] = {
            name: String(s.bookSourceName || '').slice(0, 30),
            health: h, search: g.search, toc: g.toc, content: g.content,
            chapters: r.chapters || 0, contentLen: r.contentLen || 0,
            responseTime: ms, note: String(r.reason || '').slice(0, 30), checkedAt: now,
            recent, flapping,
            // 第④关：发现页能力。null=没测（三关没过或没配 exploreUrl）
            explore, exploreNote: explore === false ? String(r.exploreReason || '').slice(0, 24) : ''
        };
    }
    // 未实测的源沿用上一轮数据；已不在库里的源丢弃
    const inLib = new Set(list.map(s => norm(s.bookSourceUrl)).filter(Boolean));
    let carried = 0;
    let carriedAgeSum = 0;
    let carriedMaxAge = 0;
    for (const [k, v] of Object.entries(oldMap)) {
        if (!testedKeys.has(k) && inLib.has(k)) {
            sources[k] = v;
            carried++;
            const age = Math.max(0, Math.round((now - (v.checkedAt || 0)) / 86400000));
            carriedAgeSum += age;
            if (age > carriedMaxAge) carriedMaxAge = age;
            if (v.flapping) flappingN++;
        }
    }
    const carriedAvgAge = carried > 0 ? (carriedAgeSum / carried).toFixed(1) + '天' : 'N/A';
    const coverage = list.length > 0 ? Math.round(tested.length / list.length * 100) + '%' : 'N/A';

    const out = {
        updatedAt: now,
        summary: { total: list.length, tested: tested.length, usable, broken: dead, untestable, carried, flapping: flappingN, exploreOk, exploreBad },
        sources
    };
    fs.writeFileSync(HFILE, JSON.stringify(out));
    const avg = scoreN ? Math.round(scoreSum / scoreN) : 0;
    console.log('健康检查: 实测 ' + tested.length + '/' + list.length + ' 个（覆盖率 ' + coverage + '，预算 ' + BUDGET_MIN + '分钟）→ 可用 ' + usable + ' / 确认坏 ' + dead + ' / 不可测 ' + untestable + ' / 沿用上轮 ' + carried + '（平均 ' + carriedAvgAge + '，最老 ' + (carriedMaxAge || 'N/A') + '天）');
    console.log('健康检查: 第④关发现页 → 通 ' + exploreOk + ' / 不通 ' + exploreBad + '（只测三关全过且配了 exploreUrl 的源）');
    console.log('健康检查: 全库平均健康分 ' + avg + '，抖动观察期(FLAPPING) ' + flappingN + ' 个，沿用上轮数据 ' + carried + ' 个，已写入 ' + HFILE);
})().catch(e => { console.error('健康检查失败（致命异常，阻断发布）:', e); process.exit(1); });
