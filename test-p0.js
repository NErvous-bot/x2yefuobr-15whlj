// test-p0.js — P0 本地预演：新实测器 vs 首份健康报告基线（271不可测/94坏/28可用）
// 验收标准：①旧不可测源显著转为可判定 ②旧可用源零误杀 ③旧确认坏不得因测试器缺陷虚增
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const { checkSource } = require('./aging-test');

const BUDGET_MIN = 13, CONC = 10;
const CAP = { gbk: 30, bl: 30, opt: 15, cl: 10, ct: 5, nores: 20, usable: 99, dead: 15 };

const norm = u => { try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); } catch (e) { return null; } };

(async () => {
const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
const h = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8'));

// 分类采样（usable 全测防误杀，其余按类限量）
const cats = { gbk: [], bl: [], opt: [], cl: [], ct: [], nores: [], usable: [], dead: [] };
const pick = (cat, n) => { const a = cats[cat]; return a.slice(0, n); };
for (const s of list) {
    const v = h.sources[norm(s.bookSourceUrl)];
    if (!v) continue;
    if (v.health === null) {
        if (v.note === 'GBK请求无法编码') cats.gbk.push(s);
        else if (v.note === 'bookList规则不可测') cats.bl.push(s);
        else if (v.note === 'searchUrl选项无法解析') cats.opt.push(s);
        else if (v.note === 'chapterList规则不可测') cats.cl.push(s);
        else if (v.note === 'content规则不可测') cats.ct.push(s);
    } else if (v.content) cats.usable.push(s);
    else if (v.note === '搜索无结果') cats.nores.push(s);
    else cats.dead.push(s);
}
console.log('基线池: GBK ' + cats.gbk.length + ' / bookList不可测 ' + cats.bl.length + ' / 解析失败 ' + cats.opt.length +
    ' / chapterList不可测 ' + cats.cl.length + ' / content不可测 ' + cats.ct.length +
    ' / 搜索无结果(假死嫌疑) ' + cats.nores.length + ' / 旧可用 ' + cats.usable.length + ' / 旧确认坏 ' + cats.dead.length);

const sample = [];
for (const [c, n] of Object.entries(CAP)) for (const s of pick(c, n)) sample.push([c, s]);
console.log('本轮实测样本: ' + sample.length + ' 个（预算 ' + BUDGET_MIN + ' 分钟）\n');

const t0 = Date.now();
let i = 0;
const results = [];
async function worker() {
    while (i < sample.length && Date.now() - t0 < BUDGET_MIN * 60000) {
        const [c, s] = sample[i++];
        const r = await checkSource(s);
        results.push([c, r.usable, r.reason || '', r.chapters || 0, r.contentLen || 0]);
    }
}
await Promise.all(Array.from({ length: CONC }, worker));
const done = results.length, skipped = sample.length - done;

// 汇总迁移矩阵
const m = {};
for (const [c, u, reason] of results) {
    const st = u === true ? '可用' : u === false ? '确认坏' : '不可测';
    const k = c + ' → ' + st;
    m[k] = (m[k] || 0) + 1;
}
console.log('===== 迁移矩阵 =====');
for (const [k, v] of Object.entries(m).sort()) console.log(String(v).padStart(4), k);
console.log('（超预算未测 ' + skipped + ' 个）');

// 误杀红旗：旧可用 → 确认坏
console.log('\n===== 误杀检查（旧可用→确认坏 = 红旗）=====');
let kill = 0;
for (const [c, u, reason] of results) {
    if (c === 'usable' && u === false) { kill++; console.log('  ✗ ' + reason); }
}
console.log(kill === 0 ? '  ✓ 零误杀' : '  ✗ 误杀 ' + kill + ' 个！');

// 明细：旧不可测 → 新可用（净收益）
console.log('\n===== 净收益明细（旧不可测→新可用）=====');
const idx = { gbk: 'GBK', bl: 'bookList不可测', opt: '选项解析失败', cl: 'chapterList不可测', ct: 'content不可测', nores: '搜索无结果', usable: '旧可用', dead: '旧确认坏' };
for (const [c, u, reason, ch, cl] of results) {
    if (c !== 'usable' && u === true) console.log('  ✓ [' + idx[c] + '] ' + reason + ' 章' + ch + ' 正' + cl);
}
// 旧确认坏复核明细
console.log('\n===== 旧确认坏复核（验证死因真实）=====');
for (const [c, u, reason] of results) {
    if (c === 'dead') console.log('  ' + (u === true ? '✓翻案' : u === false ? '·维持' : '○不可测') + ' ' + reason);
}
})().catch(e => { console.error('预演异常: ' + (e.stack || e)); process.exit(1); });
