// recheck-regression.js — 书源回归复查（验尸+诊断）
// 对比新旧两份健康报告，对异常迁移源做多次完整实测复查：
//   一级：旧可用 → 新确认坏  → 5次连续完整三关实测（搜索→书籍→目录→正文）
//   二级：旧bookList不可测 → 新确认坏 → 3次完整实测
// 判定：4/5以上成功=FLAPPING(抖动禁止删除)；0/N且死因一致=REAL_DEATH_CANDIDATE；
//       决定性样本<3=NET_UNREACHABLE(网络不可达不判死，下轮继续观察)；其余=SUSPECT
// 严格只读：不修改 legado.json、不执行任何删除，只产出 reports/ 下三份报告
// 用法：node recheck-regression.js [旧报告git引用，默认 HEAD~1]
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const { execSync } = require('child_process');
const { checkSource } = require('./aging-test');

const OLD_REF = process.argv[2] || 'HEAD~1';
const BUDGET_MIN = 15, CONC = 5;
const T1_TRIES = 5, T2_TRIES = 3;
const T2_ON = process.env.RECHECK_T2 !== '0';  // 发布保险丝模式置0：跳过二级实测省预算

const norm = u => { try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); } catch (e) { return null; } };

// 死因阶段化：把 reason 映射到失败阶段，用于判断"死在哪"
function stageOf(reason) {
    const r = String(reason || '');
    if (!r) return 'UNKNOWN';
    if (r === '三关全过') return 'PASS';
    if (/反爬|验证/.test(r)) return 'CHALLENGE';
    if (/WebView/.test(r)) return 'WEBVIEW';
    if (/GBK/.test(r)) return 'ENCODING';
    if (/bookList规则不可测/.test(r)) return 'SEARCH_PARSE';
    if (/chapterList规则不可测/.test(r)) return 'CHAPTER_PARSE';
    if (/content规则不可测/.test(r)) return 'CONTENT_PARSE';
    if (/bookUrl/.test(r)) return 'BOOK_URL';
    if (/搜索无结果/.test(r)) return 'SEARCH_EMPTY';
    if (/目录为空/.test(r)) return 'CHAPTER_EMPTY';
    if (/目录无章节链接/.test(r)) return 'CHAPTER_URL';
    if (/正文不足/.test(r)) return 'CONTENT_EMPTY';
    if (/404|410/.test(r)) return 'HTTP_404';
    const hm = /HTTP (\d+)/.exec(r); if (hm) return 'HTTP_' + hm[1];
    if (/请求失败/.test(r)) return 'NETWORK';
    if (/实测异常/.test(r)) return 'TIMEOUT';
    if (/搜索URL无效|选项无法解析|动态语法|槽位/.test(r)) return 'URL_RULE';
    return 'OTHER';
}

// 源状态三态
const st = v => !v ? 'removed' : v.health === null ? 'untestable' : v.content ? 'available' : 'broken';

// N 次尝试 → 结论（skip=不可测/豁免，属"不确定"，不计入成败；只有真 pass/fail 是决定性尝试）
function verdictOf(attempts) {
    const decisive = attempts.filter(a => a.kind !== 'skip');
    if (!decisive.length) return { verdict: 'UNTESTABLE_RULE', pass: 0, n: attempts.length };
    const n = decisive.length;
    const pass = decisive.filter(a => a.pass).length;
    if (pass === n) return { verdict: 'RECOVERED', pass, n };
    if (n >= 5 ? pass >= n - 1 : pass >= 2) return { verdict: 'FLAPPING', pass, n }; // 抖动：仅偶发失败
    if (pass === 0) {
        if (n < 3) return { verdict: 'NET_UNREACHABLE', pass, n }; // 决定性样本<3：多为网络不可达，不能判死，下轮继续观察
        const stages = [...new Set(decisive.map(a => a.stage))];
        return { verdict: stages.length === 1 ? 'REAL_DEATH_CANDIDATE' : 'MIXED_DEATH', pass, n, stages };
    }
    return { verdict: 'SUSPECT', pass, n };
}

// 源特征标签（供二级复查归因）
function traits(s) {
    const su = String(s.searchUrl || '');
    const rules = JSON.stringify([s.ruleSearch, s.ruleBookInfo, s.ruleToc, s.ruleContent] || []);
    const t = [];
    if (/POST/i.test(su)) t.push('POST');
    if (/gb2312|gbk/i.test(su)) t.push('GBK');
    if (/\$\.|\$..|JSON\.parse/.test(rules) && / bookList/.test('')) t.push('');
    if ((s.ruleSearch || {}).bookList && /^\$\./.test(String(s.ruleSearch.bookList).trim())) t.push('JSONPath');
    if (/<js>|@js:/i.test(rules)) t.push('js规则');
    return t.filter(Boolean);
}

(async () => {
    const t0 = Date.now();
    // 1) 取新旧报告（旧报告从 git 历史）
    const oldTxt = execSync(`git show ${OLD_REF}:health/source_health.json`, { maxBuffer: 64e6 }).toString();
    const oldH = JSON.parse(oldTxt);
    const newH = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8'));
    console.log('旧报告: ' + OLD_REF + '（' + oldH.summary.total + ' 源 ' + new Date(oldH.summary.updatedAt || Date.now()).toISOString().slice(0, 10) + '）');
    console.log('新报告: 当前工作区（' + newH.summary.total + ' 源）\n');

    // 2) 完整迁移矩阵
    const matrix = {};
    const oldKeys = Object.keys(oldH.sources), newKeys = new Set(Object.keys(newH.sources));
    const oldKeySet = new Set(oldKeys);
    for (const k of oldKeys) {
        const key = st(oldH.sources[k]) + '->' + (newKeys.has(k) ? st(newH.sources[k]) : 'removed');
        matrix[key] = (matrix[key] || 0) + 1;
    }
    let added = 0;
    for (const k of newKeys) if (!oldKeySet.has(k)) added++;

    // 3) 复查名单
    const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
    const byKey = new Map(list.map(s => [norm(s.bookSourceUrl), s].filter(Boolean)));
    const tier1 = [], tier2 = [];
    for (const [k, ov] of Object.entries(oldH.sources)) {
        const nSt = newKeys.has(k) ? st(newH.sources[k]) : 'removed';
        const s = byKey.get(k);
        if (!s) continue;
        if (st(ov) === 'available' && nSt === 'broken') tier1.push({ k, s, oldNote: ov.note || '', newNote: (newH.sources[k] || {}).note || '' });
        else if (st(ov) === 'untestable' && nSt === 'broken' && /bookList/.test(ov.note || '')) tier2.push({ k, s, oldNote: ov.note || '', newNote: (newH.sources[k] || {}).note || '' });
    }
    console.log('一级复查（旧可用→新确认坏）: ' + tier1.length + ' 个');
    console.log('二级复查（旧BL不可测→新确认坏）: ' + tier2.length + ' 个\n');
    if (!tier1.length && !tier2.length) console.log('无异常迁移，无需实测复查。');

    // 4) 实测复查（带时间预算）
    const jobs = [
        ...tier1.map(x => ({ ...x, tier: 1, tries: T1_TRIES })),
        ...(T2_ON ? tier2.map(x => ({ ...x, tier: 2, tries: T2_TRIES })) : [])
    ];
    let ji = 0;
    async function worker() {
        while (ji < jobs.length && Date.now() - t0 < BUDGET_MIN * 60000) {
            const j = jobs[ji++];
            j.attempts = [];
            for (let i = 0; i < j.tries; i++) {
                const r = await checkSource(j.s);
                const pass = r.usable === true;
                const kind = pass ? 'pass' : r.usable === 'skip' ? 'skip' : 'fail';
                j.attempts.push({ pass, kind, stage: stageOf(r.reason), reason: String(r.reason || '').slice(0, 40) });
                if (!pass) await new Promise(z => setTimeout(z, 1200));
            }
            j.v = verdictOf(j.attempts);
            j.traits = traits(j.s);
        }
    }
    await Promise.all(Array.from({ length: CONC }, worker));
    const untested = jobs.filter(j => !j.attempts).length;

    // 5) 汇总（注意：实测结果写在 jobs 副本上，必须从 jobs 读取）
    const summarize = arr => {
        const c = {};
        for (const j of arr) c[j.v.verdict] = (c[j.v.verdict] || 0) + 1;
        return c;
    };
    const j1 = jobs.filter(j => j.tier === 1), j2 = jobs.filter(j => j.tier === 2);
    const s1 = summarize(j1.filter(j => j.v)), s2 = summarize(j2.filter(j => j.v));
    const realDeath1 = j1.filter(j => j.v && j.v.verdict === 'REAL_DEATH_CANDIDATE').length; // 保险丝只看一级：旧可用→稳定死亡

    // 6) 产出报告
    if (!fs.existsSync('reports')) fs.mkdirSync('reports');
    fs.writeFileSync('reports/recheck-matrix.json', JSON.stringify({ generatedAt: Date.now(), oldRef: OLD_REF, matrix, addedSources: added }, null, 1));
    fs.writeFileSync('reports/recheck-report.json', JSON.stringify({
        generatedAt: Date.now(), oldRef: OLD_REF,
        tier1: j1.map(j => ({ name: String(j.s.bookSourceName || '').slice(0, 30), url: j.s.bookSourceUrl, traits: j.traits, oldNote: j.oldNote, newNote: j.newNote, attempts: j.attempts || null, verdict: (j.v || {}).verdict || 'UNTESTED' })),
        tier2: j2.map(j => ({ name: String(j.s.bookSourceName || '').slice(0, 30), url: j.s.bookSourceUrl, traits: j.traits, oldNote: j.oldNote, newNote: j.newNote, attempts: j.attempts || null, verdict: (j.v || {}).verdict || 'UNTESTED' }))
    }, null, 1));

    // 人读摘要
    const L = [];
    L.push('━━━━━━━━━━━━━━━━━━━━ 书源回归复查 ━━━━━━━━━━━━━━━━━━━━');
    L.push('旧报告 ' + OLD_REF + ' vs 新报告（只读复查，未修改任何书源）');
    L.push('');
    L.push('━━ 迁移矩阵 ━━');
    for (const [k, v] of Object.entries(matrix).sort()) L.push(String(v).padStart(5) + '  ' + k);
    L.push('新增源 ' + added);
    L.push('');
    L.push('━━ 一级复查：旧可用 → 确认坏 ' + tier1.length + ' ━━');
    for (const [verdict, n] of Object.entries(s1)) L.push('  ' + verdict + ' ' + n);
    for (const j of j1) {
        if (!j.v) { L.push('  · 未测 ' + String(j.s.bookSourceName || '').slice(0, 20)); continue; }
        L.push('  [' + j.v.verdict + ' ' + j.v.pass + '/' + j.v.n + '] ' + String(j.s.bookSourceName || '').slice(0, 20) +
            ' | 阶段: ' + j.attempts.map(a => a.stage).join(',') + (j.traits.length ? ' | 特征: ' + j.traits.join('+') : ''));
    }
    L.push('');
    L.push('━━ 二级复查：旧BL不可测 → 确认坏 ' + tier2.length + (T2_ON ? '' : '（保险丝模式：跳过实测）') + ' ━━');
    if (T2_ON) {
        for (const [verdict, n] of Object.entries(s2)) L.push('  ' + verdict + ' ' + n);
        for (const j of j2) {
            if (!j.v) { L.push('  · 未测 ' + String(j.s.bookSourceName || '').slice(0, 20)); continue; }
            L.push('  [' + j.v.verdict + ' ' + j.v.pass + '/' + j.v.n + '] ' + String(j.s.bookSourceName || '').slice(0, 20) +
                ' | 阶段: ' + j.attempts.map(a => a.stage).join(',') + (j.traits.length ? ' | 特征: ' + j.traits.join('+') : ''));
        }
    }
    L.push('');
    const blocked = realDeath1 > 0;
    L.push('━━ 保险丝判定 ━━');
    L.push(blocked ? 'BLOCKED：存在 ' + realDeath1 + ' 个旧可用→稳定死亡，须人工定位 aging-test.js 或确认站点真死' : 'PASS：旧可用 → 确认坏 = ' + tier1.length + (tier1.length ? '（均属抖动/疑似误判，禁止删除即可）' : ''));
    if (untested) L.push('（预算内未测完 ' + untested + ' 个，见 recheck-report.json）');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const summary = L.join('\n');
    fs.writeFileSync('reports/recheck-summary.txt', summary);
    console.log(summary);
})().catch(e => { console.error('复查异常: ' + (e.stack || e)); process.exit(1); });
