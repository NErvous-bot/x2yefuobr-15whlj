/**
 * rules.js — 净化规则自维护（CI 版）
 * 流程：挑静态页源取样真实正文 → 跑现有规则净化 → 扫漏网广告特征 →
 *       模板法生成候选规则 → 干净语料误伤校验（0误伤）→ 净化率提升校验 →
 *       追加写入 replaceRule.json（单轮≤10条，无新增/失败自动跳过）
 * 约束：仅用 node 内置模块；任何异常都 exit 0（跳过写入，防止 CI 常红）；
 *       写入后由 update.yml 后续步骤自动校验结构并重签名。
 */
'use strict';
const fs = require('fs'), https = require('https'), http = require('http'), zlib = require('zlib');
const R = __dirname.replace(/\\/g, '/') + '/';
const UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36';

/* ---------- 网络 ---------- */
function decode(buf) {
  const head = buf.slice(0, 2048).toString('latin1').toLowerCase();
  if (/charset=["']?(gb2312|gbk)/.test(head)) { try { return new TextDecoder('gbk').decode(buf); } catch (e) {} }
  return buf.toString('utf8');
}
function fetchText(url, depth = 0, ref = null) {
  return new Promise(res => {
    if (depth > 3) return res(null);
    let mod = url.startsWith('https') ? https : http, req;
    const h = { 'User-Agent': UA, 'Accept': 'text/html,*/*' };
    if (ref) h['Referer'] = ref;
    try { req = mod.get(url, { headers: h }, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume(); try { return res(fetchText(new URL(r.headers.location, url).href, depth + 1, ref)); } catch (e) { return res(null); }
      }
      const cs = []; r.on('data', c => cs.push(c));
      r.on('end', () => { let b = Buffer.concat(cs); if ((r.headers['content-encoding'] || '').includes('gzip')) { try { b = zlib.gunzipSync(b); } catch (e) {} } res({ status: r.statusCode, text: decode(b) }); });
      r.on('error', () => res(null));
    }); } catch (e) { return res(null); }
    req.setTimeout(15000, () => { req.destroy(); res(null); });
    req.on('error', () => res(null));
  });
}

/* ---------- 正文抽取：标签平衡 + legado 常见选择器子集 ---------- */
const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'source']);
function grabInnerAll(html, cls) {
  const openRe = new RegExp('<(\\w+)[^>]*?(?:class|id)\\s*=\\s*["\'][^"\']*\\b' + cls + '\\b[^"\']*["\'][^>]*>', 'gi');
  const out = []; let om;
  while ((om = openRe.exec(html))) {
    const tag = om[1];
    if (VOID.has(tag.toLowerCase())) continue;
    let i = om.index + om[0].length, inner;
    const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'gi');
    re.lastIndex = i; let depth = 1, m2;
    while ((m2 = re.exec(html))) {
      depth += m2[1] === '/' ? -1 : 1;
      if (depth === 0) { inner = html.slice(i, m2.index); break; }
    }
    if (inner === undefined) inner = html.slice(i, i + 60000);
    out.push(inner);
  }
  return out;
}
function stripToText(t) {
  t = t.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|section)>/gi, '\n').replace(/<[^>]+>/g, '');
  return t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '');
}
function extract(html, rule) {
  for (const alt of rule.split('||')) {
    let clean = '', ci = alt.indexOf('##'), sel = alt;
    if (ci >= 0) { clean = alt.slice(ci + 2); sel = alt.slice(0, ci); }
    const m = sel.match(/^(?:class|id)?[.#]?([\w\u4e00-\u9fff\-]+)@(?:tag\.[\w]+@)?(html|textNodes|text)$/);
    if (!m) continue;
    for (const inner of grabInnerAll(html, m[1])) {
      let t = stripToText(inner);
      if (clean) clean.split('|').forEach(p => { if (!p) return; try { t = t.replace(new RegExp(p, 'g'), ''); } catch (e) {} });
      t = t.trim();
      if (t.length >= 200) return t;
    }
  }
  return '';
}

/* ---------- 章节链接发现 ---------- */
function chapterLinks(base, html) {
  const scored = [], seen = new Set();
  const root = base.split('/').slice(0, 3).join('/');
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi; let m;
  while ((m = re.exec(html))) {
    let u = m[1].trim(), t = m[2].replace(/<[^>]+>/g, '').trim();
    if (!u || /^(javascript|mailto)/i.test(u)) continue;
    try { u = new URL(u, base).href; } catch (e) { continue; }
    if (!u.startsWith(root)) continue;
    if (/\.(css|js|png|jpe?g|gif|ico|svg|apk|txt)(\?|$)/i.test(u)) continue;
    if (seen.has(u)) continue; seen.add(u);
    let s = 0;
    if (/第.{1,8}章|最新章节|正文卷?/.test(t)) s += 3;
    if (/\d+_\d+\.html|\/\d+\.html|\/\d+_\d+\//.test(u)) s += 2;
    if (/\/\d{4,}\//.test(u)) s += 1;
    if (/book|read|chapter|xiaoshuo|xs|text/i.test(u)) s += 1;
    if (s > 0) scored.push([s, u]);
  }
  return scored.sort((a, b) => b[0] - a[0]).map(x => x[1]);
}

/* ---------- 净化（现有规则） ---------- */
let allRules = [];
try { allRules = JSON.parse(fs.readFileSync(R + 'replaceRule.json', 'utf8')); } catch (e) { allRules = []; }
if (!Array.isArray(allRules)) allRules = [];
const rules = allRules.filter(r => r.isEnabled !== false && r.isRegex !== false && r.replacePattern);
function purify(t) {
  for (const r of rules) { try { t = t.replace(new RegExp(r.replacePattern, 'gm'), r.replacement || ''); } catch (e) {} }
  return t;
}

/* ---------- 残留检测 ---------- */
const DET = [
  { k: '域名/链接', sev: '高', re: /(?:https?:\/\/)?(?:[\w\-]+\.)+(?:com|cn|net|org|cc|xyz|top|vip|info|la|me|site|club|online|fun|icu|biz|wang|link|ltd|pro)(?:\/[^\s，。！？]{0,30})?/gi },
  { k: '站点推广', sev: '高', re: /全网(?:最)?(?:快|首)|更新速度|无错章节|笔趣阁?|去广告|无弹窗|下载APP|APP下载|手机版阅读|更多精彩|记得收藏|方便(?:阅读|下次)|最快更新|首发于|本书来自|整理制作|转载请|手机用户/gi },
  { k: '社群引流', sev: '高', re: /公众[号號]|微信公众号|微信号?|威信|V信|Q群|QQ群|群号|交流群|书友群|加群|加微信/gi },
  { k: '求票互动', sev: '中', re: /[求跪请]{1,2}(?:收藏|月票|推荐票?|鲜花|打赏|订阅|追读|评价票|评论|五星|投资|支持本?[书作站]|点击)/gi },
  { k: '导航残留', sev: '低', re: /上一[章页]|下一[章页]|返回目录|加入书签|章节目录/g },
  { k: '乱码符号', sev: '中', re: /[\uE000-\uF8FF\uFFF0-\uFFFF\uFFFD]/g },
];
function hitCount(t) {
  let n = 0;
  for (const d of DET) {
    d.re.lastIndex = 0; let m;
    while ((m = d.re.exec(t))) { n++; if (d.re.lastIndex === m.index) d.re.lastIndex++; }
  }
  return n;
}

/* ---------- 主流程 ---------- */
async function main() {
  const srcs = JSON.parse(fs.readFileSync(R + 'legado.json', 'utf8'));
  const cands = srcs.filter(s => {
    const c = ((s.ruleContent && s.ruleContent.content) || '').trim();
    return /^(?:class|id|\.|#)[\w\u4e00-\u9fff\-]+@(?:tag\.[\w]+@)?(?:html|textNodes|text)(##|\|\||$)/.test(c) && !/<js>|@js:/i.test(c);
  }).sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 30);

  console.log('== 取样（候选' + cands.length + '个静态源，目标≥10章，并行）==');
  const corpus = [];
  await Promise.all(cands.map(async s => {
    if (corpus.length >= 20) return;
    const base = (s.bookSourceUrl || '').replace(/#.*$/, '');
    const home = await fetchText(base);
    if (!home || !home.text) return void console.log('  [首页失败]', s.bookSourceName, base);
    let links = chapterLinks(base, home.text).slice(0, 10);
    if (!links.length) {
      // 二跳：首页只有书页链接 → 先进书页再找章节
      const bookRe = /<a[^>]+href=["']([^"']*(?:\/book\/|\d+_\d+|\/\d+\.html)[^"']*)["']/gi;
      const books = new Set(); let bm;
      while ((bm = bookRe.exec(home.text)) && books.size < 2) {
        try { const u = new URL(bm[1], base).href; if (u.startsWith(base.split('/').slice(0, 3).join('/'))) books.add(u); } catch (e) {}
      }
      for (const bu of books) {
        const bp = await fetchText(bu, 0, base);
        if (bp && bp.text) links = links.concat(chapterLinks(bu, bp.text).slice(0, 5));
        if (links.length >= 6) break;
      }
      if (!links.length) return void console.log('  [无章节链接·二跳也空]', s.bookSourceName, base);
    }
    let got = 0;
    for (const u of links) {
      if (got >= 2 || corpus.length >= 20) break;
      const pg = await fetchText(u, 0, base);
      if (!pg || !pg.text) continue;
      let raw = extract(pg.text, ((s.ruleContent && s.ruleContent.content) || '').trim());
      if (raw.length < 500) {
        // 该页可能是书页：进去找章节链接再试一跳
        const sub = chapterLinks(u, pg.text).slice(0, 4);
        for (const su of sub) {
          if (got >= 2 || corpus.length >= 20) break;
          const sp = await fetchText(su, 0, base);
          if (!sp || !sp.text) continue;
          raw = extract(sp.text, ((s.ruleContent && s.ruleContent.content) || '').trim());
          if (raw.length < 500) continue;
          got++;
          corpus.push({ site: s.bookSourceName.replace(/\s+/g, ''), url: su, raw, pur: purify(raw) });
        }
        continue;
      }
      got++;
      corpus.push({ site: s.bookSourceName.replace(/\s+/g, ''), url: u, raw, pur: purify(raw) });
    }
    if (got) console.log('  [√ 取' + got + '章]', s.bookSourceName, base);
    else console.log('  [×抽取失败]', s.bookSourceName, base);
  }));

  if (corpus.length < 3) { console.log('守门：样本章数不足(' + corpus.length + ')，跳过写入'); return; }

  // ---- 残留统计（对净化后文本） ----
  const hits = {};
  for (const c of corpus) {
    const seen = new Set();
    for (const d of DET) {
      d.re.lastIndex = 0; let m;
      while ((m = d.re.exec(c.pur))) {
        const key = d.k + '|' + m[0].toLowerCase().trim();
        if (seen.has(key)) continue; seen.add(key);
        if (!hits[key]) hits[key] = { det: d.k, sev: d.sev, n: 0, sites: new Set(), eg: m[0] };
        hits[key].n++; hits[key].sites.add(c.site);
        if (d.re.lastIndex === m.index) d.re.lastIndex++;
      }
    }
  }
  const list = Object.entries(hits).map(([k, v]) => ({ ...v, key: k })).sort((a, b) => b.sites.size * 100 + b.n - (a.sites.size * 100 + a.n));

  console.log('\n== 残留检测（净化后仍存在）==');
  console.log('样本：' + corpus.length + '章 / ' + corpus.reduce((a, c) => a + c.pur.length, 0) + '字，来自 ' + new Set(corpus.map(c => c.site)).size + ' 个站');
  list.slice(0, 25).forEach(v => console.log('  [' + v.sev + '][' + v.det + '] ' + v.eg.slice(0, 40) + '  ←' + v.sites.size + '站x' + v.n));

  // ---- 候选规则生成（模板法） ----
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cands2 = [];
  for (const v of list) {
    if (v.det === '域名/链接' && cands2.length < 4 && !v.eg.includes('://')) {
      const d = v.eg.replace(/\/.*$/, '').toLowerCase();
      cands2.push({ name: '自动·引流域名 ' + d, pat: '(?:[a-zA-Z0-9\\-]+\\.)*' + esc(d) + '(?:/[^\u4e00-\u9fa5\\s，。]{0,30})?', why: v.sites.size + '站x' + v.n, sev: v.sev });
    }
  }
  for (const v of list) {
    if (cands2.length >= 10) break;
    if (v.det === '域名/链接') continue;
    if (v.sites.size < 2 && v.sev !== '高') continue;
    const phrase = v.eg.trim();
    if (phrase.length < 2 || phrase.length > 30) continue;
    if (cands2.some(c => c.pat.includes(esc(phrase)))) continue;
    cands2.push({ name: '自动·' + v.det + '「' + phrase.slice(0, 12) + '」', pat: esc(phrase), why: v.sites.size + '站x' + v.n, sev: v.sev });
  }

  // ---- 干净语料误伤校验 ----
  const cleanParas = [];
  for (const c of corpus) {
    for (const p of c.pur.split(/\n+/)) {
      const t = p.trim();
      if (t.length >= 30 && /[\u4e00-\u9fa5]/.test(t) && !/http|www\.|\d{3,}|第.{0,6}章/.test(t)) cleanParas.push(t);
    }
  }
  console.log('\n== 候选规则（' + cands2.length + '条）与误伤校验（干净段落池 ' + cleanParas.length + ' 段）==');
  const passCands = [];
  for (const c of cands2) {
    let fp = 0;
    try {
      const re = new RegExp(c.pat, 'g');
      for (const p of cleanParas) if (re.test(p)) fp++;
    } catch (e) { console.log('  [REJECT·正则异常] ' + c.name); continue; }
    if (fp === 0) passCands.push(c);
    console.log('  [' + (fp === 0 ? 'PASS' : 'REJECT·误伤' + fp + '段') + '] ' + c.name + '  (' + c.why + ')  → ' + c.pat.slice(0, 70));
  }
  if (cleanParas.length < 20) { console.log('守门：干净段落池不足(' + cleanParas.length + ')，误伤校验不可信，跳过写入'); return; }
  if (!passCands.length) { console.log('守门：无可通过误伤校验的新规则，跳过写入'); return; }

  // ---- 去重 + 单轮上限10条 ----
  const haveName = new Set(allRules.map(r => String(r.name || '').trim()));
  const havePat = new Set(allRules.map(r => String(r.replacePattern || '')));
  const maxSort = allRules.reduce((a, r) => Math.max(a, r.sortNo | 0), 0);
  const toAdd = [];
  for (const c of passCands) {
    if (toAdd.length >= 10) break;
    if (haveName.has(c.name) || havePat.has(c.pat) || toAdd.some(x => x.name === c.name || x.pat === c.pat)) continue;
    toAdd.push(c);
  }
  if (!toAdd.length) { console.log('守门：候选规则均已存在（无新增），跳过写入'); return; }

  // ---- 净化率提升校验：加新规则后残留命中必须下降 ----
  const before = corpus.reduce((a, c) => a + hitCount(c.pur), 0);
  const after = corpus.reduce((a, c) => {
    let t = c.pur;
    for (const r of toAdd) { try { t = t.replace(new RegExp(r.pat, 'gm'), ''); } catch (e) {} }
    return a + hitCount(t);
  }, 0);
  if (after >= before) { console.log('守门：净化率未提升（残留 ' + before + '→' + after + '），放弃写入'); return; }

  // ---- 写入 replaceRule.json（保持既有格式：每行一条紧凑 JSON） ----
  let sortNo = maxSort;
  for (const c of toAdd) {
    allRules.push({ name: c.name, group: '净化-自动', replacePattern: c.pat, replacement: '', scope: '', isEnabled: true, isRegex: true, sortNo: ++sortNo });
  }
  fs.writeFileSync(R + 'replaceRule.json', '[\n' + allRules.map(r => '  ' + JSON.stringify(r)).join(',\n') + '\n]');
  console.log('\n== 写入完成 ==');
  console.log('新增净化规则 ' + toAdd.length + ' 条（总 ' + allRules.length + ' 条），残留命中 ' + before + '→' + after);
  toAdd.forEach(c => console.log('  [+] ' + c.name + '  (' + c.why + ')'));
}

(async () => {
  try { await main(); }
  catch (e) { console.log('!! 规则自维护异常（自动跳过，不影响主流程）: ' + (e && e.message)); }
  process.exit(0);
})();
