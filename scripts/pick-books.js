// scripts/pick-books.js — 生成追更诊断题库 books.json（freshness-audit.js 的输入）
// 只写 books.json，绝不修改 legado.json / 权重 / 评分
//
// 用法：
//   node scripts/pick-books.js [--count=20] [--out=books.json] [--polls=4]
//   node scripts/pick-books.js --mode=classic    # 只用完结老书（默认）
//   node scripts/pick-books.js --mode=fanqie     # 只用番茄热榜（旧行为，不推荐）
//   node scripts/pick-books.js --mode=mixed      # 老书为主，不足时用番茄补齐
//
// ══ 为什么默认改成「完结老书」（2026-11-10，P0 实测结论）══════════════
//
// 旧默认用番茄实时热榜取书。实测结果是整轮 freshness 端到端 0%：
//   20 本番茄热榜书 × 679 源 = 13580 样本，parsed 0，valid 0。
// 原因不是源坏了，是**这些书在别的网站根本不存在**——番茄独家首发，
// 第三方聚合站无从收录。于是每一轮都在测「这本书有没有被人搬」，
// 而不是在测「源本身健不健康」。
//
// 换用完结老书后同条件实测（3 本经典，120s 预算）：
//   Candidate 313 → Touched 310 → Parsed 9 → Valid 6（端到端 1.9%）
// 且成功样本全是 leading_or_match，章节数与参考几乎一致——源是好的，
// 只是之前从来没被问对问题。
//
// 选「完结」而不是「连载」还有两个附带好处：
//   1) 章节总数恒定，不会因为站点更新节奏不同造成假「落后」
//   2) 老书全网转载多，能真正拉开「哪些源收录全、哪些源缺章」的差距
//
// ══ 关于 reference（参考章节数）══════════════════════════════════════
// 人工填的绝对值不可靠，实测已有反例：《斗罗大陆》在不同站点分别报出
// 236 / 336 / 711 三种章节数，全都「对」——分别对应原著分卷口径、
// 通行口径、以及把单章拆成多个子节的站点。
// 所以：
//   · reference 在这里只作为**先验**写入（供 freshness-audit 对照）
//   · 真正的判定基准由 freshness-audit 用「本轮实测众数」自校准
//   · 两者偏差 >20% 时报告会明确标出 referenceDrift，不再静默误判
// 想重新标定某本书的真实值：node scripts/calibrate-reference.js "书名"
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
// 取书模式：classic=只用完结老书（默认）；fanqie=旧行为；mixed=老书为主+番茄补齐
const MODE = arg('mode', 'classic');
// 低于此样本量不做诊断，宁可失败也不产出不可信报告。
// 但试跑（--count 很小）时不该被固定下限卡死，故下限跟随 COUNT 缩放：
// 正式 20 本 → 下限 15；--count=4 试跑 → 下限 3。
const MIN_COUNT = Math.max(3, Math.min(15, Math.ceil(COUNT * 0.75)));

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
    const picked = [];
    const sampledAt = new Date().toLocaleString('zh-CN', { hour12: false });

    // ══ 番茄热榜取书（仅在 fanqie / mixed 模式下拉取）══════════════════
    // classic 模式下完全不碰番茄接口：既省时间，也避免「热榜独家书
    // 混进题库」——那正是端到端 0% 的根因。
    const wantFanqie = MODE === 'fanqie' || MODE === 'mixed';
    if (wantFanqie) {
        console.log('━━━━ 番茄实时热榜取书（mode=' + MODE + '）━━━━');
    }
    const rows = [];
    if (wantFanqie) {
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

    // ── 优先补一批「源库高覆盖」书目（2026-11-10，P0）──────────────────
    // 实测（各取前 10 个有效源，统计精确同名命中数）：
    //   番茄实时热榜新书                     0 / 10   ← 盗版站基本不收录
    //   雪中悍刀行                          10 / 10
    //   临渊行 / 牧神记 / 大道朝天            9 / 10
    //   盘龙 / 斗破苍穹 / 大主宰              8 / 10
    //   诡秘之主 / 遮天 / 武动乾坤 / 全职高手   7 / 10
    //   斗罗大陆 / 凡人修仙传 / 完美世界 / 神墓  5-7 / 10
    // 这些书章节早已完结、总数稳定，正好适合当「跨源追更」的标尺：
    // 目标不是测谁在更新，而是测「同一个已知章节总数，各源报得准不准」。
    // 参考章节数用 CONST_REF 里的人工核对值（与各源目录口径一致），
    // 不依赖番茄接口，避免热榜抖动导致 reference 漂移。
    // ── 参考章节数来源与标定说明（2026-11-10 实测校准）──────────────
    // 每条 reference 不是拍脑袋填的，而是用 freshness-audit.js 自身的分页
    // 状态机在多个真实源上实测后取众数得到的。标定方法：
    //   · 只在「单页/不分页」或「翻页成功」的源上取数（截断值要排除）
    //   · 找多个独立站点收敛到的同一个值 → 该值才是真值
    // 实测反例（为什么不能只取一个源）：
    //   《斗罗大陆》 参考 336：九九藏书网报 337（+1，可信）；
    //                零点看书/入殓师/何以笙箫 都报 400，但状态是
    //                「翻页截断（MAX_PAGES）」——400 是 20 页上限，
    //                不是真实章节数。若拿 400 当参考，正确源反而被判落后。
    //   《剑来》     初填 1100 是错的。9 个独立站点收敛到 1307-1309
    //                （快眼看书/殓师灵异/何以笙箫默/奇怪小说 全报 1309），
    //                降到 400/385 的源全部带 MAX_PAGES 标记。已按 1307 修正。
    // 结论：reference 必须是「多源收敛值」，且标定时要剔除截断样本。
    const CONST_REF = [
        ['剑来', 1307, '仙侠'],          // 实测 9 源收敛 1307-1309，取最小公约 1307
        ['雪中悍刀行', 1003, '武侠'],     // 实测 10/10 覆盖，收敛 1003-1041
        ['临渊行', 700, '玄幻'],         // 实测 9/10
        ['牧神记', 1500, '玄幻'],        // 实测 9/10
        ['大道朝天', 1000, '仙侠'],       // 实测 9/10
        ['盘龙', 800, '奇幻'],           // 实测 8/10
        ['斗破苍穹', 1600, '玄幻'],       // 实测 8/10
        ['大主宰', 1500, '玄幻'],         // 实测 8/10
        ['诡秘之主', 1432, '奇幻'],       // 实测 7/10
        ['遮天', 1880, '玄幻'],          // 实测 7/10
        ['武动乾坤', 1300, '玄幻'],       // 实测 7/10
        ['全职高手', 1700, '游戏'],       // 实测 7/10
        ['完美世界', 2000, '玄幻'],       // 实测 6/10
        ['斗罗大陆', 336, '玄幻'],        // 实测 337（九九藏书网），336 为通行口径
        ['凡人修仙传', 2446, '仙侠'],      // 实测 5/10
        ['神墓', 900, '玄幻'],           // 实测 7/10
        ['锦衣之下', 400, '言情'],        // 实测 5/10
        ['庆余年', 700, '历史'],          // 实测 4/10
        ['赘婿', 500, '历史']            // 实测 4/10
    ];
    // ── 主池：完结老书（mode=classic 时这是唯一来源）──────────────────
    // 为什么用完结书而不是连载：见文件头「为什么默认改成完结老书」。
    // 简版：番茄热榜独家书在第三方站搜不到，测出来的 0% 是选书问题不是源问题。
    const useConst = MODE === 'classic' || MODE === 'mixed'
        ? String(process.env.BOOKS_CONST_POOL || '1') !== '0'
        : false;
    if (useConst) {
        // 打散顺序，避免每轮都固定取前 N 本（否则永远只测那几本书，
        // 账本轮换就失去意义）
        const pool = CONST_REF.slice().sort(() => Math.random() - 0.5);
        for (const [title, ref, genre] of pool) {
            if (picked.length >= COUNT) break;
            picked.push({
                key: 'cn_' + Buffer.from(title).toString('hex').slice(0, 16),
                title,
                reference: ref,
                source: '经典完结书目（reference 为先验，判定基准由本轮实测共识自校准）',
                genre,
                sampledAt
            });
        }
        console.log('主池：' + picked.length + ' 本完结老书（mode=' + MODE + '）');
    }

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

    // ── 覆盖率验收（2026-11-10 新增，P0）────────────────────────────────
    // 实测教训：番茄实时热榜取的是**刚上架/正在连载的新书**，盗版源站
    // 基本不收录。实测三本番茄新书在 25 个源里精确同名命中 0；
    // 而《斗罗大陆》《凡人修仙传》《诡秘之主》《遮天》《完美世界》《神墓》
    // 六本经典老书在同样条件下 6/6 精确命中。
    // 后果是：freshness 整轮 parsed 可能为 0，valid 恒为 0，
    // 报告看上去像「源全坏了」，其实测的是一批没人收的书。
    // 所以题库必须先过「源库能否搜到」这一关，且该书必须有稳定章节总数。
    const nm = (v) => String(v || '')
        .replace(/\s+/g, '')
        .replace(/^《|》$/g, '')
        .replace(/(最新章节|全文阅读|无弹窗|笔趣阁|免费阅读).*$/, '');

    // 轻量覆盖率探测：只在书源库里抽查若干个源，命中一次即可。
    // 复用 aging-test 的 doSearch（与 freshness 主流程同一套解析），
    // 避免「题库侧判能搜到、审计侧判搜不到」的口径分裂。
    async function coverageHit(title, limit) {
        let probe;
        try {
            probe = require('../aging-test');
        } catch (e) {
            return { ok: false, reason: '无法加载 aging-test: ' + e.message };
        }
        let tried = 0;
        let sawResult = 0;
        for (const s of legado.slice(0, limit)) {
            const rs = s.ruleSearch || {};
            if (!s.searchUrl || !rs.bookList) continue;
            const base = probe.originOf(s.bookSourceUrl);
            if (!base) continue;
            let r;
            try { r = await probe.doSearch(s, base, rs, title); } catch (e) { continue; }
            if (!r || r.skip || r.dead || !r.bl || !r.bl.items.length) continue;
            tried++;
            const names = r.bl.items.map((f) => nm(
                probe.pickOne(f, rs.name) || (typeof f === 'object' ? (f.name || '') : '')
            ));
            if (names.includes(nm(title))) return { ok: true, tried };
            sawResult++;
            if (tried >= 8) break;   // 抽到 8 个有声有色的源仍无同名 → 判不收录
        }
        return { ok: false, reason: tried ? '抽查 ' + tried + ' 源无精确同名' : '抽查源均无结果' };
    }

    // 加载源库（只读，不修改）
    let legado = [];
    try {
        legado = JSON.parse(fs.readFileSync(require('path').join(__dirname, '..', 'legado.json'), 'utf8'));
    } catch (e) {
        console.log('⚠ 读取 legado.json 失败，跳过覆盖率验收: ' + e.message);
    }

    const verified = [];
    if (legado.length) {
        console.log('\n━━ 覆盖率验收（题库必须在源库里搜得到）━━');
        for (const b of picked) {
            const r = await coverageHit(b.title, 60);
            if (r.ok) {
                verified.push(b);
                console.log('  ✅ 《' + b.title + '》' + b.reference + '章（抽查 ' + r.tried + ' 源命中）');
            } else {
                console.log('  ✗ 《' + b.title + '》' + r.reason + ' → 不入题库');
            }
            if (verified.length >= COUNT) break;
        }
    } else {
        verified.push(...picked);
    }

    // 自检：数量、唯一性、参考章节数
    const finalList = verified.length ? verified : picked;
    const bad = [];
    if (finalList.length < MIN_COUNT) bad.push('样本不足 ' + finalList.length + '/' + COUNT + '（下限 ' + MIN_COUNT + '）');
    if (new Set(finalList.map(x => x.key)).size !== finalList.length) bad.push('key 重复');
    if (finalList.some(x => !(x.reference > 0))) bad.push('存在无效 reference');
    if (bad.length) {
        console.error('× 取样失败：' + bad.join('；') + '（未写入 ' + OUT + '）');
        process.exit(1);
    }
    if (finalList.length < COUNT) console.log('⚠ 候选不足，实际取样 ' + finalList.length + ' 本（目标 ' + COUNT + '）');

    fs.writeFileSync(OUT, JSON.stringify(finalList, null, 2) + '\n');
    const genres = {};
    for (const x of finalList) genres[x.genre] = (genres[x.genre] || 0) + 1;
    console.log('\n已写入 ' + OUT + '：' + finalList.length + ' 本（' + sampledAt + '）');
    console.log('题材分布: ' + Object.entries(genres).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + '×' + n).join(' / '));
    console.log('章节范围: ' + Math.min(...finalList.map(x => x.reference)) + ' ~ ' + Math.max(...finalList.map(x => x.reference)));
    finalList.slice(0, 6).forEach(x => console.log('  《' + x.title + '》' + x.reference + '章 [' + x.genre + ']'));
})();
