'use strict';
/**
 * 存活实测（curl 驱动版）。
 *
 * 为什么不用 node 的 http/https：实测发现本机 Node 到大量目标站点的 TLS
 * 握手被重置（ECONNRESET），而同一批站点 curl 能正常返回 301/200。
 * 对照组：baidu / github 在 node 下正常，说明不是全局断网；
 * 是这批小说站的 TLS 栈与本机 Node 的 OpenSSL 组合不通。
 * 用 curl 探测可绕开该差异，结果才反映「站点是否活着」而不是「本机能否 TLS」。
 *
 * 用法：
 *   node scripts/import-probe-curl.js --stage=host
 *   node scripts/import-probe-curl.js --stage=search [--limit=200]
 *
 * 输出 reports/import/probe-host.json / probe-search.json（只读探测，不改成品）
 */
const fs = require('fs');
const { execFile } = require('child_process');

const arg = (n, d) => {
  const h = process.argv.find((x) => x.startsWith('--' + n + '='));
  return h ? h.slice(n.length + 3) : d;
};
const STAGE = arg('stage', 'host');
const LIMIT = Number(arg('limit', 0));
const CONC = Number(arg('conc', 4)); // 实测并发 >4 会集体失败，本机连接池很小
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

const norm = (u) => String(u || '').replace(/#.*$/, '').replace(/\/+$/, '').trim();

function curl(url, opt = {}) {
  const args = [
    '-s',
    '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w', '%{http_code}',
    '--max-time', String(opt.timeout || 12),
    '-A', UA,
    '-L', // 跟随重定向，301 也算活
  ];
  if (opt.method && opt.method !== 'GET') args.push('-X', opt.method);
  if (opt.body) args.push('--data', opt.body);
  args.push(url);
  return new Promise((resolve) => {
    execFile('curl', args, { timeout: (opt.timeout || 12) * 1000 + 3000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ code: '000', err: err.code || 'exec' });
      resolve({ code: String(stdout || '').trim() || '000' });
    });
  });
}

function parseSearch(s) {
  const su = String(s.searchUrl || '').trim();
  if (!su) return null;
  const i = su.indexOf(',{');
  const base = i > 0 ? su.slice(0, i) : su;
  let cfg = {};
  if (i > 0) {
    try {
      cfg = JSON.parse(su.slice(i + 1));
    } catch (e) {
      return null;
    }
  }
  return { base, cfg };
}

(async () => {
  const fresh = JSON.parse(fs.readFileSync('reports/import/fresh.json', 'utf8'));
  let pool = fresh;
  if (LIMIT > 0) pool = pool.slice(0, LIMIT);

  const t0 = Date.now();
  let i = 0;
  const out = [];

  async function worker() {
    while (i < pool.length) {
      const s = pool[i++];
      const url = norm(s.bookSourceUrl);
      let r;
      if (STAGE === 'host') {
        const c = await curl(url);
        r = {
          url: s.bookSourceUrl,
          name: s.bookSourceName,
          code: c.code,
          alive: c.code !== '000',
        };
      } else {
        const ps = parseSearch(s);
        if (!ps) {
          r = { url: s.bookSourceUrl, name: s.bookSourceName, ok: false, reason: '无 searchUrl' };
        } else {
          const keyword = '斗罗大陆';
          const body = ps.cfg.body ? String(ps.cfg.body).replace('{{key}}', encodeURIComponent(keyword)) : null;
          const method = (ps.cfg.method || (body ? 'POST' : 'GET')).toUpperCase();
          let target = ps.base;
          if (method === 'GET') target = ps.base.replace('{{key}}', encodeURIComponent(keyword)).replace(/\{\{page\}\}/g, '1');
          const c = await curl(target, { method, body });
          const ok = c.code !== '000' && Number(c.code) < 500 && Number(c.code) !== 403 && Number(c.code) !== 429;
          r = {
            url: s.bookSourceUrl,
            name: s.bookSourceName,
            code: c.code,
            ok,
            reason: ok ? '' : (c.code === '403' || c.code === '429' ? 'IP受限' : 'http' + c.code),
          };
        }
      }
      out.push(r);
      const done = out.length;
      if (done % 40 === 0) {
        const rate = done / ((Date.now() - t0) / 1000);
        console.log('  进度 ' + done + '/' + pool.length + '  (' + rate.toFixed(1) + '/s)');
      }
    }
  }

  console.log('━━━ ' + (STAGE === 'host' ? '域名探活(curl)' : '搜索实测(curl)') + '：' + pool.length + ' 条，并发 ' + CONC + ' ━━━');
  await Promise.all(Array.from({ length: CONC }, worker));

  const okN = out.filter((x) => (STAGE === 'host' ? x.alive : x.ok)).length;
  console.log('\n完成 ' + out.length + ' 条，耗时 ' + Math.round((Date.now() - t0) / 1000) + 's');
  console.log('  可用: ' + okN + ' / ' + out.length + '（' + ((okN / out.length) * 100).toFixed(1) + '%）');

  if (STAGE === 'host') {
    const codes = {};
    for (const x of out) codes[x.code] = (codes[x.code] || 0) + 1;
    console.log('  HTTP 码分布: ' + JSON.stringify(codes));
  } else {
    const reasons = {};
    for (const x of out) {
      if (x.ok) continue;
      reasons[x.reason || '?'] = (reasons[x.reason || '?'] || 0) + 1;
    }
    const top = Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) {
      console.log('  失败原因:');
      top.forEach(([k, v]) => console.log('    ' + v + '  ' + k));
    }
  }

  const f = 'reports/import/probe-' + STAGE + '.json';
  fs.writeFileSync(f, JSON.stringify(out, null, 1));
  console.log('\n已写 ' + f);
})();
