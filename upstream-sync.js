/**
 * upstream-sync.js — 上游自动扒取（增量 + 准入闸门 + 成人分流）
 *
 * 目标：只把「上游还在更新、且当场实测三关全过」的书源收进库，
 *       不再无脑合并大合集（当前 976 源里 857 个是死的/测不了的）。
 *
 * 流水线位置：filter.js 之前。产物 harvested.json 由 filter.js 在
 * 「本地策展源」阶段并入 legado.json（与 extra-sources.json 同等语义），
 * 因此 filter.js 的核心逻辑完全不用改。
 *
 * 四层：
 *   ① 变更检测：每个上游存 ETag，304 直接跳过（零开销）
 *   ② 活跃度：源级 lastUpdateTime 超过 maxAgeDays 的不收（比看仓库 commit 准）
 *   ③ 准入闸门：新源必须过 checkSource 三关（搜索出书 → 目录≥1章 → 正文≥200字）
 *               只有 usable===true 才收；skip/false 一律不收（acceptSkip 可放宽）
 *   ④ 留痕：upstream-state.json 记每个上游的 etag/上次变更/收录数
 *
 * 成人分流：命中 ADULT_HINT 的源默认全部跳过（公开仓库不能有）；
 *   设置 ALLOW_ADULT=1 后才会收，并统一打上 bookSourceGroup='18+' 方便手机端整组关闭。
 *   另支持 ADULT_SRC_URL 指向私有仓库里的 json（带 token 的 raw 链接），单独当作一个上游。
 *
 * 环境变量：
 *   ALLOW_ADULT=1        允许收录成人源（默认关）
 *   ADULT_SRC_URL=...    成人专用上游（私有 raw 链接）
 *   MAX_TEST=40          单轮最多实测多少个候选（控制 CI 时长）
 *   SYNC_BUDGET_MIN=6    单轮实测时间预算（分钟）
 *   SYNC_CONC=6          实测并发
 *   MAX_HARVEST=800      harvested.json 总量上限
 */
'use strict';
const fs = require('fs');
const { norm } = require('./src/source-id');
const { checkSource } = require('./aging-test');

const CFG = 'upstreams.json';
const HARVEST = 'harvested.json';
const STATE = 'upstream-state.json';
const LEGADO = 'legado.json';
const QUARANTINE = 'quarantine.json';
const REPORT = 'reports/upstream-sync.json';

const MAX_TEST = num(process.env.MAX_TEST, 40);
const BUDGET_MS = num(process.env.SYNC_BUDGET_MIN, 6) * 60000;
const CONC = num(process.env.SYNC_CONC, 6);
const MAX_HARVEST = num(process.env.MAX_HARVEST, 800);
const ALLOW_ADULT = /^(1|true|yes)$/i.test(String(process.env.ALLOW_ADULT || ''));
const ADULT_SRC_URL = String(process.env.ADULT_SRC_URL || '').trim();
const ADULT_CAP = num(process.env.ADULT_CAP, 60);
const NOW = Date.now();
const DAY = 864e5;

// 成人向特征词（保守，宁可漏判也不误伤正常源）
const ADULT_HINT = /🔞|18\+|18禁|成人|色情|情色|肉文|禁书|午夜|福利|里番|海棠|po18|rouwen|h小说|nsfw|porn/i;
const ADULT_GROUP = '18+';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; }

function readJson(p, fb) {
    try {
        if (!fs.existsSync(p)) return fb;
        // 去掉 UTF-8 BOM：Windows 下手工编辑的 json 常带 BOM，JSON.parse 会直接报错
        return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    }
    catch (e) { console.log('⚠️ ' + p + ' 解析失败，按空处理: ' + e.message); return fb; }
}

/* ---------- 纯函数（可单测，不依赖网络与文件） ---------- */

// 成人判定：名字 / URL / 分组 任一命中
function adultOf(s) {
    if (!s) return false;
    return ADULT_HINT.test([s.bookSourceName, s.bookSourceUrl, s.bookSourceGroup].join(' '));
}

// 从上游全量里挑候选：去已存在、按活跃度过滤、按更新时间排序、截断到 cap
function selectCandidates(all, knownKeys, opt) {
    const maxAgeDays = (opt && opt.maxAgeDays) || 0;
    const cap = (opt && opt.cap) || 20;
    const now = (opt && opt.now) || NOW;
    const out = [];
    const seen = new Set();
    for (const s of Array.isArray(all) ? all : []) {
        const url = s && s.bookSourceUrl;
        const k = url ? norm(url) : null;
        if (!k || knownKeys.has(k) || seen.has(k)) continue;
        if (!s.searchUrl) continue;                     // 没有搜索入口，三关第一关就过不了
        if (maxAgeDays > 0) {
            const t = Number(s.lastUpdateTime);
            if (!t || now - t > maxAgeDays * DAY) continue;   // 太久没维护，不收
        }
        seen.add(k);
        out.push(s);
    }
    out.sort((a, b) => (Number(b.lastUpdateTime) || 0) - (Number(a.lastUpdateTime) || 0));
    return out.slice(0, cap);
}

// 合并进 harvested：剔除已进 legado / 已隔离的，并入新收的，按活跃度截断
function mergeHarvested(existing, added, legadoKeys, banKeys, max) {
    const keep = [];
    const seen = new Set();
    for (const s of Array.isArray(existing) ? existing : []) {
        const k = s && s.bookSourceUrl ? norm(s.bookSourceUrl) : null;
        if (!k || seen.has(k)) continue;
        if (legadoKeys.has(k)) continue;    // 已在主库 → 从 harvested 摘掉，避免重复膨胀
        if (banKeys.has(k)) continue;       // 已隔离 → 别再塞回来
        seen.add(k);
        keep.push(s);
    }
    for (const s of Array.isArray(added) ? added : []) {
        const k = s && s.bookSourceUrl ? norm(s.bookSourceUrl) : null;
        if (!k || seen.has(k)) continue;
        if (legadoKeys.has(k) || banKeys.has(k)) continue;  // 已进主库 / 已隔离，绝不回填
        seen.add(k);
        keep.push(s);
    }
    keep.sort((a, b) => (Number(b.lastUpdateTime) || 0) - (Number(a.lastUpdateTime) || 0));
    return keep.slice(0, max);
}

/* ---------- 网络 ---------- */

async function fetchText(urls, etag, ms) {
    let lastErr = '';
    for (const u of urls) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), ms || 60000);
        try {
            const h = { 'User-Agent': UA };
            if (etag) h['If-None-Match'] = etag;
            const r = await fetch(u, { headers: h, signal: c.signal, redirect: 'follow' });
            clearTimeout(t);
            if (r.status === 304) return { ok: true, notModified: true, url: u };
            if (!r.ok) { lastErr = u + ' HTTP ' + r.status; continue; }
            const text = await r.text();
            if (text.length < 100) { lastErr = u + ' 内容过短'; continue; }
            return { ok: true, text, etag: r.headers.get('etag') || '', url: u };
        } catch (e) {
            clearTimeout(t);
            lastErr = u + ' ' + (e && e.message ? e.message : e);
        }
    }
    return { ok: false, err: lastErr };
}

function pool(items, n, fn) {
    const ret = [];
    let i = 0;
    async function w() { while (i < items.length) { const k = i++; ret[k] = await fn(items[k], k); } }
    return Promise.all(Array.from({ length: n }, w)).then(() => ret);
}

/* ---------- 主流程 ---------- */

async function main() {
    const cfg = readJson(CFG, []);
    if (!Array.isArray(cfg) || !cfg.length) {
        console.log('无 upstreams.json 或为空，跳过上游同步');
        return;
    }
    const legado = readJson(LEGADO, []);
    const legadoKeys = new Set((Array.isArray(legado) ? legado : []).map(s => norm(s.bookSourceUrl)).filter(Boolean));
    const banKeys = new Set((readJson(QUARANTINE, []) || []).map(x => norm(typeof x === 'string' ? x : (x && x.url))).filter(Boolean));
    const harvest = readJson(HARVEST, []);
    const harvestedKeys = new Set((Array.isArray(harvest) ? harvest : []).map(s => norm(s.bookSourceUrl)).filter(Boolean));
    const state = readJson(STATE, { upstreams: {} });
    state.upstreams = state.upstreams || {};

    const jobs = cfg.filter(u => u && u.enabled !== false).map(u => Object.assign({}, u));
    if (ADULT_SRC_URL && ALLOW_ADULT) {
        jobs.push({
            id: 'adult-private', name: '成人专用上游(private)', urls: [ADULT_SRC_URL],
            license: 'PRIVATE', adult: true, cap: ADULT_CAP, maxAgeDays: 0, acceptSkip: false,
        });
    }

    const t0 = Date.now();
    let testedCount = 0;
    const admitted = [];
    const perUpstream = [];

    for (const u of jobs) {
        const id = u.id || u.name || ('upstream-' + perUpstream.length);
        const st = state.upstreams[id] || {};
        const urls = (u.urls && u.urls.length) ? u.urls : (u.url ? [u.url] : []);
        const row = {
            id, name: u.name || id, license: u.license || 'NONE', adult: !!u.adult,
            fetched: 0, candidates: 0, tested: 0, admitted: 0, skippedAdult: 0,
            notModified: false, error: '',
        };

        if (!urls.length) { row.error = 'no url'; perUpstream.push(row); continue; }
        if (u.adult && !ALLOW_ADULT) {
            row.error = 'adult upstream disabled (ALLOW_ADULT off)';
            perUpstream.push(row);
            console.log('[' + row.name + '] 跳过：成人源需 ALLOW_ADULT=1');
            continue;
        }

        console.log('[' + row.name + '] 拉取（ETag ' + (st.etag ? '有' : '无') + '）…');
        const r = await fetchText(urls, st.etag);
        if (!r.ok) {
            row.error = r.err || 'fetch failed';
            perUpstream.push(row);
            console.log('  ✗ ' + row.error);
            continue;
        }
        if (r.notModified) {
            row.notModified = true;
            perUpstream.push(row);
            console.log('  = 304 未变更，跳过');
            st.lastRun = NOW;
            state.upstreams[id] = st;
            continue;
        }

        let arr;
        try { arr = JSON.parse(r.text); } catch (e) { row.error = 'JSON 解析失败'; perUpstream.push(row); continue; }
        if (!Array.isArray(arr)) { row.error = '不是书源数组'; perUpstream.push(row); continue; }
        row.fetched = arr.length;
        st.etag = r.etag || st.etag || '';
        st.url = r.url;
        st.lastRun = NOW;
        st.fetched = arr.length;

        // 已存在（主库/待收割/已隔离）都不再作为候选：隔离名单也必须算进来，
        // 否则 quarantine 掉的源会被上游重新收割一遍，形成「隔离→复活」死循环
        const known = new Set([...legadoKeys, ...harvestedKeys, ...banKeys]);
        let cands = selectCandidates(arr, known, { maxAgeDays: u.maxAgeDays || 0, cap: u.cap || 20 });

        if (!u.adult) {
            const before = cands.length;
            cands = cands.filter(s => {
                if (!adultOf(s)) return true;
                row.skippedAdult++;
                return false;
            });
            if (before !== cands.length) console.log('  · 过滤成人源 ' + row.skippedAdult + ' 个（ALLOW_ADULT=' + (ALLOW_ADULT ? '1' : '0') + '）');
        }
        row.candidates = cands.length;
        if (!cands.length) { perUpstream.push(row); state.upstreams[id] = st; console.log('  · 无新候选'); continue; }

        const take = Math.max(0, Math.min(cands.length, MAX_TEST - testedCount));
        const toTest = cands.slice(0, take);
        if (!toTest.length) { perUpstream.push(row); state.upstreams[id] = st; console.log('  · 本轮实测预算已用完'); break; }

        console.log('  · 候选 ' + cands.length + '，本轮实测 ' + toTest.length);
        let admittedHere = 0;
        await pool(toTest, CONC, async (s) => {
            if (Date.now() - t0 > BUDGET_MS) return null;
            testedCount++; row.tested++;
            let res;
            try { res = await checkSource(s); } catch (e) { return null; }
            const pass = res && res.usable === true;
            const skipOk = res && res.usable === 'skip' && u.acceptSkip === true;
            if (!pass && !skipOk) return null;
            const out = Object.assign({}, s);
            if (u.adult || adultOf(s)) {
                const g = String(out.bookSourceGroup || '').trim();
                out.bookSourceGroup = g ? ADULT_GROUP + ',' + g : ADULT_GROUP;
            }
            admitted.push(out);
            admittedHere++; row.admitted++;
            return out;
        });
        if (admittedHere) console.log('  ✓ 准入 ' + admittedHere + ' 个（三关全过）');
        else console.log('  · 实测全部不通过（三关未过，不收）');
        state.upstreams[id] = st;
        perUpstream.push(row);
        if (Date.now() - t0 > BUDGET_MS) { console.log('  · 时间预算用完，停止后续上游'); break; }
    }

    const merged = mergeHarvested(harvest, admitted, legadoKeys, banKeys, MAX_HARVEST);
    fs.writeFileSync(HARVEST, JSON.stringify(merged, null, 0));
    state.generatedAt = NOW;
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync(REPORT, JSON.stringify({
        generatedAt: NOW,
        allowAdult: ALLOW_ADULT,
        maxTest: MAX_TEST,
        tested: testedCount,
        admitted: admitted.length,
        harvestedTotal: merged.length,
        degraded: perUpstream.every(x => x.error || x.notModified),
        upstreams: perUpstream,
    }, null, 1));

    console.log('上游同步: 实测 ' + testedCount + ' / 准入 ' + admitted.length +
        ' / harvested 共 ' + merged.length + ' / 用时 ' + Math.round((Date.now() - t0) / 1000) + 's' +
        (ALLOW_ADULT ? '（成人源已开启）' : '（成人源已关闭）'));
}

if (require.main === module) {
    main().catch(e => {
        // 上游同步失败不阻断发布：filter.js 会沿用已有库；但要留证据
        console.error('× 上游同步异常（不阻断发布）: ' + (e && e.message ? e.message : e));
        try {
            fs.mkdirSync('reports', { recursive: true });
            fs.writeFileSync(REPORT, JSON.stringify({ generatedAt: Date.now(), fatal: String((e && e.message) || e) }, null, 1));
            // 保证产物文件存在：update.yml 的 git add 依赖它们，缺了会让整个 commit 步骤失败
            if (!fs.existsSync(HARVEST)) fs.writeFileSync(HARVEST, '[]');
            if (!fs.existsSync(STATE)) fs.writeFileSync(STATE, JSON.stringify({ upstreams: {} }, null, 1));
        } catch (_) { }
        process.exit(0);
    });
}

module.exports = { adultOf, selectCandidates, mergeHarvested };
