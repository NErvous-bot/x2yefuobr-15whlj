// scripts/pick-books.js — 从番茄实时更新热榜抽取活跃连载书，生成追更诊断题库 books.json
// 只写 books.json（freshness-audit.js 的输入），绝不修改 legado.json / 权重 / 评分
//
// 用法：
//   node scripts/pick-books.js [--count=20] [--out=books.json] [--min-chapters=50] [--polls=4]
//
// 口径：
//   - 书源：番茄官方「最近更新」+「热门推荐」两个稳定接口，天然是在更书，
//     避免用完结书残留数据误判死源（分类榜接口有反爬限流，返回空列表，故不采用）
//   - 最近更新是滚动 feed，单次仅 20 条；多次轮询（默认 4 次，间隔 5s）可累计 ~70 本候选
//   - reference：书页 chapterTotal（官方章节总数，含感言等条目，与各源目录计数同口径）
//   - 仅保留 creationStatus=1（连载中）
//   - 按分类轮询取样，保证题材分散；同 bookId 去重
const fs = require('fs');
const vm = require('vm');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const RECENT_API = 'https://fanqienovel.com/api/rank/recent/update/list';
const RECOMMEND_API = 'https://fanqienovel.com/api/rank/recommend/list';
const arg = (name, def) => {
    const hit = process.argv.find(x => x.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : def;
};
const COUNT = Number(arg('count', 20));
const OUT = arg('out', 'books.json');
const MIN_CHAPTERS = Number(arg('min-chapters', 50));
const POLLS = Number(arg('polls', 4));
const MIN_COUNT = 15;  // 低于此样本量不做诊断，宁可失败也不产出不可信报告

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://fanqienovel.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.json();
}

// 书页 chapterTotal / creationStatus 在 window.__INITIAL_STATE__ 里（非严格 JSON，含 undefined）
async function bookMeta(bookId) {
    const r = await fetch('https://fanqienovel.com/page/' + bookId, { headers: { 'User-Agent': UA, Referer: 'https://fanqienovel.com/' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    const i = t.indexOf('__INITIAL_STATE__={');
    if (i < 0) throw new Error('未找到页面状态');
    const j = t.indexOf('};', i);
    const raw = t.slice(i + '__INITIAL_STATE__='.length, j + 1);
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext('var s=' + raw, ctx);
    const p = (ctx.s && ctx.s.page) || {};
    return {
        title: p.bookName || '',
        chapters: Number(p.chapterTotal) || 0,
        status: Number(p.creationStatus),
        lastChapter: p.lastChapterTitle || '',
        category: p.category || ''
    };
}

(async () => {
    console.log('━━━━ 番茄实时热榜取书 ━━━━');
    const rows = [];
    try {
        const seenPoll = new Set();
        for (let i = 0; i < POLLS; i++) {
            const recent = await getJson(RECENT_API);
            const list = ((recent.data || {}).data) || [];
            for (const x of list) {
                const id = String(x.bookId || '');
                if (!id || seenPoll.has(id)) continue;
                seenPoll.add(id);
                rows.push({ bookId: id, title: x.bookName || '', category: x.category || '未分类' });
            }
            console.log('最近更新第 ' + (i + 1) + '/' + POLLS + ' 轮：' + list.length + ' 条（累计唯一 ' + seenPoll.size + '）');
            if (i < POLLS - 1) await sleep(5000);
        }
    } catch (e) {
        console.log('最近更新接口失败（继续用推荐榜）: ' + e.message);
    }
    try {
        const rec = await getJson(RECOMMEND_API);
        const list = ((rec.data || {}).list) || [];
        for (const x of list) rows.push({ bookId: String(x.bookId || ''), title: x.bookName || '', category: x.category || '未分类' });
        console.log('热门推荐条目 ' + list.length + ' 条');
    } catch (e) {
        console.log('热门推荐接口失败（继续用最近更新）: ' + e.message);
    }

    // 去重 + 按分类分组
    const seen = new Set();
    const groups = new Map();
    for (const x of rows) {
        if (!x.bookId || seen.has(x.bookId)) continue;
        seen.add(x.bookId);
        if (!groups.has(x.category)) groups.set(x.category, []);
        groups.get(x.category).push(x);
    }
    for (const arr of groups.values()) arr.sort(() => Math.random() - 0.5);

    // 分类轮询取样，候选池放大 3 倍以抵消完结/校验失败
    const candidates = [];
    const lists = [...groups.values()];
    let round = 0;
    while (candidates.length < COUNT * 3) {
        let added = 0;
        for (const arr of lists) {
            if (arr[round]) { candidates.push(arr[round]); added++; }
            if (candidates.length >= COUNT * 3) break;
        }
        if (!added) break;
        round++;
    }

    const picked = [];
    const sampledAt = new Date().toLocaleString('zh-CN', { hour12: false });
    for (let i = 0; i < candidates.length && picked.length < COUNT; i += 3) {
        const batch = candidates.slice(i, i + 3);
        const metas = await Promise.all(batch.map(async c => {
            try { return { c, m: await bookMeta(c.bookId) }; }
            catch (e) { console.log('  [跳过] ' + c.title + '：' + e.message); return null; }
        }));
        for (const hit of metas) {
            if (!hit || picked.length >= COUNT) continue;
            const { c, m } = hit;
            if (m.status !== 1) { console.log('  [跳过·非连载] ' + c.title + '（status=' + m.status + '）'); continue; }
            if (m.chapters < MIN_CHAPTERS) { console.log('  [跳过·章节过少] ' + c.title + '（' + m.chapters + '）'); continue; }
            picked.push({
                key: 'fq_' + c.bookId,
                title: c.title || m.title,
                reference: m.chapters,
                source: '番茄实时更新 ' + sampledAt,
                genre: c.category,
                bookId: c.bookId,
                latestChapter: m.lastChapter,
                sampledAt
            });
        }
        if (picked.length < COUNT) await sleep(250);
    }

    // 自检：数量、唯一性、参考章节数
    const bad = [];
    if (picked.length < MIN_COUNT) bad.push('样本不足 ' + picked.length + '/' + COUNT + '（下限 ' + MIN_COUNT + '）');
    if (new Set(picked.map(x => x.key)).size !== picked.length) bad.push('key 重复');
    if (picked.some(x => !(x.reference > 0))) bad.push('存在无效 reference');
    if (bad.length) {
        console.error('× 取样失败：' + bad.join('；') + '（未写入 ' + OUT + '）');
        process.exit(1);
    }
    if (picked.length < COUNT) console.log('⚠ 候选不足，实际取样 ' + picked.length + ' 本（目标 ' + COUNT + '）');

    fs.writeFileSync(OUT, JSON.stringify(picked, null, 2) + '\n');
    const genres = {};
    for (const x of picked) genres[x.genre] = (genres[x.genre] || 0) + 1;
    console.log('\n已写入 ' + OUT + '：' + picked.length + ' 本（' + sampledAt + '）');
    console.log('题材分布: ' + Object.entries(genres).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + '×' + n).join(' / '));
    console.log('章节范围: ' + Math.min(...picked.map(x => x.reference)) + ' ~ ' + Math.max(...picked.map(x => x.reference)));
    picked.slice(0, 6).forEach(x => console.log('  《' + x.title + '》' + x.reference + '章 [' + x.genre + ']'));
})();
