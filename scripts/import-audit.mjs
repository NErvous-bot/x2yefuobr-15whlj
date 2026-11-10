/**
 * import-audit.mjs — 对「外部书源包」做 Playwright 三重验收（L1 搜索 / L2 目录 / L3 正文）
 *
 * 为什么必须在 CI 跑而不是本地：
 *   实测本机到这批小说站的 HTTPS 会被对端在 TLS 阶段重置（TCP 通、0 字节 RST），
 *   而同一批站在 CI（Azure）能正常出书。本地筛选结果对手机毫无代表性。
 *   所以「能不能用」这个判断必须交给 CI，和最终运行环境一致。
 *
 * 与 source-audit.mjs 的关系：
 *   复用它的解析引擎（selectAll / pickOne / buildSearchUrl / phaseA / phaseB），
 *   只把「候选源来源」从上游仓库换成外部包文件。
 *   这样避免两套解析逻辑漂移——同一个源不该在审计里过关、在 freshness 里出错。
 *
 * 输入：IMPORT_PKG 环境变量指定包路径（CI 里由 workflow 下载或从 artifacts 取）
 * 输出：reports/import/audit-result.json（只写报告，绝不改 legado.json）
 *
 * 用法：
 *   IMPORT_PKG=shareBookSource.json LIMIT=300 node scripts/import-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isAdult } = require('./adult-filter.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

// —— 复用 source-audit.mjs 的引擎：直接从源文件里 import 不可行（它有顶层 main()），
// 所以这里用动态方式拿它的内部函数做不到，改为独立实现关键三步。
// 保持与 source-audit.mjs 完全相同的解析语义（下面每个函数都对应那边同名的实现）。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';
const L2_MIN_CHAPTERS = 10;
const L3_MIN_TEXT = 500;

const BLOCK_TAGS =
  /(人机验证|搜索暂不可用|需登录|梯子|被封|反爬|滑块|Cloudflare)/i;
// 成人向关键词：公开仓库不收（GitHub AUP 会直接 disable 仓库）

const arg = (n, d) => {
  const h = process.argv.find((x) => x.startsWith('--' + n + '='));
  return h ? h.slice(n.length + 3) : d;
};

function walkJson(obj, p) {
  // 简化 JSONPath：$.a.b / $.a[*].b
  if (!p || !p.startsWith('$')) return undefined;
  const parts = p.replace(/^\$\.?/, '').split(/\.|\[|\]/).filter(Boolean);
  let cur = [obj];
  for (const seg of parts) {
    if (seg === '*') continue;
    const next = [];
    for (const c of cur) {
      if (c == null) continue;
      if (Array.isArray(c)) for (const v of c) next.push(v?.[seg]);
      else next.push(c[seg]);
    }
    cur = next;
  }
  return cur.filter((v) => v !== undefined && v !== null && v !== '');
}

function selectAll(html, rule) {
  // 只支持本仓库实际在用的 CSS 子集：class.x / tag.a.N / .a.b@tag.c
  if (!rule || typeof rule !== 'string') return { items: [] };
  const atIdx = rule.lastIndexOf('@');
  const listRule = atIdx > 0 ? rule.slice(0, atIdx) : rule;
  const itemRule = atIdx > 0 ? rule.slice(atIdx + 1) : '';
  const blocks = [];
  const cls = /^class\.([\w-]+)(?:\.(-?\d+))?$/.exec(listRule);
  if (cls) {
    const name = cls[1];
    const re = new RegExp('<[a-zA-Z][^>]*class="[^"]*\\b' + name + '\\b[^"]*"[^>]*>', 'g');
    let m;
    while ((m = re.exec(html))) blocks.push(m.index);
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const end = i + 1 < blocks.length ? blocks[i + 1] : html.length;
      out.push(html.slice(blocks[i], end));
    }
    return { items: out, itemRule };
  }
  const tag = /^tag\.([\w]+)(?:\.(-?\d+))?$/.exec(listRule);
  if (tag) {
    const re = new RegExp('<' + tag[1] + '[^>]*>[\\s\\S]*?</' + tag[1] + '>', 'g');
    return { items: html.match(re) || [], itemRule };
  }
  return { items: [] };
}

function pickOne(item, rule) {
  if (!item || !rule) return null;
  const parts = String(rule).split('@');
  let cur = item;
  for (const part of parts) {
    const m = /^(tag|class)\.([\w-]+)(?:\.(-?\d+))?$/.exec(part.trim());
    if (m) {
      const kind = m[1];
      const name = m[2];
      const idx = m[3] !== undefined ? Number(m[3]) : 0;
      const re =
        kind === 'tag'
          ? new RegExp('<' + name + '[^>]*>([\\s\\S]*?)</' + name + '>', 'g')
          : new RegExp('<([a-zA-Z][^>]*)class="[^"]*\\b' + name + '\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>', 'g');
      const hits = [];
      let mm;
      while ((mm = re.exec(cur))) hits.push(mm);
      if (!hits.length) return null;
      const p = idx < 0 ? hits[hits.length + idx] : hits[idx];
      if (!p) return null;
      cur = kind === 'tag' ? p[1] : p[2];
      continue;
    }
    if (part === 'text') return String(cur).replace(/<[^>]+>/g, '').trim();
    if (part === 'href') {
      const h = /href="([^"]*)"/.exec(cur);
      return h ? h[1] : null;
    }
  }
  return String(cur).replace(/<[^>]+>/g, '').trim();
}

function absUrl(source, u) {
  if (!u) return null;
  if (/^https?:/i.test(u)) return u;
  try {
    return new URL(u, source.bookSourceUrl).toString();
  } catch (e) {
    return null;
  }
}

function buildSearchUrl(source, keyword) {
  const su = String(source.searchUrl || '').trim();
  if (!su) return null;
  const i = su.indexOf(',{');
  const base = i > 0 ? su.slice(0, i) : su;
  return base.replace(/\{\{key\}\}/g, encodeURIComponent(keyword)).replace(/\{\{page\}\}/g, '1');
}

async function launchBrowser() {
  const { chromium } = await import('playwright');
  return chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
}

async function pwGet(page, url) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    if (!resp) return '';
    return await page.content();
  } catch (e) {
    return '';
  }
}

async function phaseA(page, source, keywords) {
  for (const kw of keywords) {
    const url = buildSearchUrl(source, kw);
    if (!url) return { pass: false, reason: '无 searchUrl' };
    const html = await pwGet(page, url);
    if (!html) continue;
    const r = selectAll(html, source.ruleSearch?.bookList);
    if (!r.items?.length) continue;
    const item = r.items[0];
    let detail = null;
    const burl = source.ruleSearch?.bookUrl;
    if (burl) detail = pickOne(item, burl) || (typeof item === 'string' ? item : null);
    detail = absUrl(source, detail);
    if (detail) return { pass: true, kw, detailUrl: detail };
  }
  return { pass: false, reason: 'L1 搜索无结果' };
}

async function phaseB(page, source, hit) {
  // L2 目录
  const tocHtml = await pwGet(page, hit.detailUrl);
  if (!tocHtml) return { pass: false, reason: 'L2 目录页空' };
  const toc = selectAll(tocHtml, source.ruleToc?.chapterList);
  const chapters = toc.items?.length || 0;
  if (chapters < L2_MIN_CHAPTERS) return { pass: false, reason: 'L2 章节仅 ' + chapters };

  // L3 正文：取第一章
  let chapUrl = null;
  const curl = source.ruleToc?.chapterUrl;
  if (curl && toc.items[0]) chapUrl = pickOne(toc.items[0], curl);
  chapUrl = absUrl(source, chapUrl);
  if (!chapUrl) return { pass: false, reason: 'L3 章节 URL 取不到', chapters };

  const cHtml = await pwGet(page, chapUrl);
  if (!cHtml) return { pass: false, reason: 'L3 正文页空', chapters };
  const cr = selectAll(cHtml, source.ruleContent?.content);
  let text = '';
  if (cr.items?.length) {
    text = cr.items.join('').replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, '').trim();
  }
  if (text.length < L3_MIN_TEXT) return { pass: false, reason: 'L3 正文仅 ' + text.length + ' 字', chapters };
  return { pass: true, chapters, textLen: text.length };
}

async function main() {
  const pkgPath = process.env.IMPORT_PKG || arg('pkg', '');
  if (!pkgPath || !fs.existsSync(pkgPath)) {
    console.error('× 找不到包文件：' + pkgPath);
    process.exit(1);
  }
  const limit = Number(process.env.LIMIT || arg('limit', 0)) || 0;

  console.log('=== 外部包三重验收 ===');
  const raw = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const incoming = Array.isArray(raw) ? raw : raw.bookSources;
  console.log('包内条目: ' + incoming.length);

  // 1) 与现有仓库去重（按身份键：去 fragment / 尾斜杠 / 协议）
  const canon = (u) =>
    String(u || '')
      .toLowerCase()
      .replace(/#[\s\S]*$/, '')
      .replace(/^https?:\/\//, '')
      .replace(/\/+$/, '')
      .trim();
  const legado = JSON.parse(fs.readFileSync(path.join(REPO, 'legado.json'), 'utf8'));
  const exist = new Set(legado.map((s) => canon(s.bookSourceUrl)));

  const skipped = { dup: 0, adult: 0, blockTag: 0, incomplete: 0 };
  const candidates = [];
  const seen = new Set();
  for (const s of incoming) {
    const k = canon(s.bookSourceUrl);
    if (!k) continue;
    if (seen.has(String(s.bookSourceUrl))) continue;
    seen.add(String(s.bookSourceUrl));
    if (exist.has(k)) { skipped.dup++; continue; }

    if (isAdult(s)) { skipped.adult++; continue; }
    if (BLOCK_TAGS.test((s.bookSourceGroup || '') + ' ' + (s.bookSourceComment || ''))) { skipped.blockTag++; continue; }
    if (!s.searchUrl || !s.ruleToc?.chapterList || !s.ruleContent?.content) { skipped.incomplete++; continue; }
    candidates.push(s);
  }
  console.log('跳过: 重复 ' + skipped.dup + ' / 成人向 ' + skipped.adult + ' / 屏蔽词 ' + skipped.blockTag + ' / 结构不全 ' + skipped.incomplete);
  console.log('进入实测: ' + candidates.length + (limit ? '（限 ' + limit + '）' : ''));

  // 分片：把全量拆成多批并行跑，每批独立 artifact，最后合并。
  // 为什么要分片：单条 Playwright 实测约 5-15 秒，2400 条全量单 job 要 5-9 小时，
  // 超过 GitHub 单 job 6 小时上限。拆成 N 片可并行，且单片失败不影响其它片。
  const SHARD = Number(process.env.SHARD || 0);
  const SHARD_TOTAL = Math.max(1, Number(process.env.SHARD_TOTAL || 1));
  let pool = candidates;
  if (SHARD_TOTAL > 1) {
    // 按取模分片：保证同一源固定落在同一片，重跑结果稳定可比
    pool = candidates.filter((s, i) => i % SHARD_TOTAL === SHARD);
    console.log('分片 ' + SHARD + '/' + SHARD_TOTAL + ' → 本片 ' + pool.length + ' 条');
  }
  if (limit) pool = pool.slice(0, limit);

  const browser = await launchBrowser();
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  const keywords = ['斗罗大陆', '凡人修仙传', '诡秘之主'];
  const passed = [];
  const failed = [];

  for (let i = 0; i < pool.length; i++) {
    const s = pool[i];
    process.stdout.write('  [' + (i + 1) + '/' + pool.length + '] ' + String(s.bookSourceName || '').padEnd(20, ' ') + ' ');
    try {
      const a = await phaseA(page, s, keywords);
      if (!a.pass) { failed.push({ name: s.bookSourceName, url: s.bookSourceUrl, reason: a.reason }); process.stdout.write('❌ ' + a.reason + '\n'); continue; }
      const b = await phaseB(page, s, a);
      if (b.pass) {
        passed.push({ name: s.bookSourceName, url: s.bookSourceUrl, chapters: b.chapters, textLen: b.textLen, via: a.kw });
        process.stdout.write('✅ L2=' + b.chapters + ' L3=' + b.textLen + '字\n');
      } else {
        failed.push({ name: s.bookSourceName, url: s.bookSourceUrl, reason: b.reason });
        process.stdout.write('❌ ' + b.reason + '\n');
      }
    } catch (e) {
      failed.push({ name: s.bookSourceName, url: s.bookSourceUrl, reason: 'ERR ' + String(e.message).slice(0, 40) });
      process.stdout.write('❌ ERR\n');
    }
    await page.waitForTimeout(150);
  }
  await browser.close();

  const out = {
    runAt: new Date().toISOString(),
    pkg: path.basename(pkgPath),
    incoming: incoming.length,
    skipped,
    tested: pool.length,
    passedCount: passed.length,
    failedCount: failed.length,
    passed,
    failed,
  };
  fs.mkdirSync(path.join(REPO, 'reports/import'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'reports/import/audit-result.json'), JSON.stringify(out, null, 2), 'utf8');

  console.log('\n=== 结果 ===');
  console.log('三重全过: ' + passed.length + ' / ' + pool.length);
  console.log('已写 reports/import/audit-result.json');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
