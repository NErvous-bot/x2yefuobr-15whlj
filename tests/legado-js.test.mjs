import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const { evaluateSearchJs, isJsSearchUrl, extractJs } = require(path.join(REPO, 'src', 'legado-js.js'));

const BASE = 'https://x.example.com';
const cases = [];
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + '  ->  ' + e.message); }
}
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ' 实际 ' + JSON.stringify(a)); }

console.log('=== 1. 形态识别 ===');
test('isJsSearchUrl 识别 <js>', () => eq(isJsSearchUrl('<js>x</js>'), true));
test('isJsSearchUrl 识别 @js:', () => eq(isJsSearchUrl('@js:x'), true));
test('isJsSearchUrl 普通 URL 返回 false', () => eq(isJsSearchUrl('https://a.com/s'), false));
test('extractJs 取出 <js> 正文与后缀', () => {
  const r = extractJs('<js>a</js>/s?q={{key}}');
  eq(r.code, 'a'); eq(r.suffix, '/s?q={{key}}');
});

console.log('\n=== 2. 求值能力（应成功）===');
test('java.put(url) 产出 URL', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','https://x.example.com/s?wd='+key);", base: BASE, key: '都市' });
  eq(r.ok, true); eq(r.url, 'https://x.example.com/s?wd=都市');
});
test('java.put(key) + 静态后缀拼接', () => {
  const r = evaluateSearchJs({ su: '<js>java.put("key",key)</js>/s?q={{key}}', base: BASE, key: '都市' });
  eq(r.ok, true); if (!r.url.includes('都市')) throw new Error('URL 未含关键词: ' + r.url);
});
test('@js: 形态下 result 取静态前缀', () => {
  const r = evaluateSearchJs({ su: '/s?q={{key}} @js:java.put("key",key);result', base: BASE, key: '都市' });
  eq(r.ok, true); if (!r.url.includes('都市')) throw new Error('URL 未含关键词: ' + r.url);
});
test('source.getKey() 可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url',source.getKey()+'/s?wd='+key);", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, BASE + '/s?wd=k');
});
test('baseUrl 隐式变量可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url',baseUrl+'/s?wd='+key);", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, BASE + '/s?wd=k');
});
test('JSON.stringify 拼 POST 选项', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','/s,'+JSON.stringify({method:'POST',body:'wd='+key}));", base: BASE, key: 'k' });
  eq(r.ok, true); if (!r.url.includes('"method":"POST"')) throw new Error('缺少 POST 选项: ' + r.url);
});
test('java.md5Encode 可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','/s?sign='+java.md5Encode('abc'));", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, '/s?sign=900150983cd24fb0d6963f7d28e17f72');
});
test('java.base64Encode 可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','/s?b='+java.base64Encode('abc'));", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, '/s?b=YWJj');
});
test('java.encodeURI 可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','/s?wd='+java.encodeURI('都市'));", base: BASE, key: 'k' });
  eq(r.ok, true); if (!r.url.includes('%E9%83%BD%E5%B8%82')) throw new Error('编码不符: ' + r.url);
});
test('page 变量可用', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url','/s?p='+page+'&wd='+key);", base: BASE, key: 'k', page: 3 });
  eq(r.ok, true); eq(r.url, '/s?p=3&wd=k');
});

console.log('\n=== 3. 分层拒绝（应不可测，且理由精确）===');
test('java.ajax → 需要联网', () => {
  const r = evaluateSearchJs({ su: "@js:java.ajax(baseUrl)", base: BASE, key: 'k' });
  eq(r.ok, false); if (!/需要联网\(java\.ajax\)/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});
test('java.post → 需要联网', () => {
  const r = evaluateSearchJs({ su: "@js:java.post(baseUrl,'',{})", base: BASE, key: 'k' });
  eq(r.ok, false); if (!/需要联网\(java\.post\)/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});
test('java.webView → 未实现', () => {
  const r = evaluateSearchJs({ su: '@js:java.webView(null,baseUrl,null)', base: BASE, key: 'k' });
  eq(r.ok, false); if (!/未实现的 java\.webView/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});
test('无返回值且无后缀 → 不可测', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('key',key)", base: BASE, key: 'k' });
  eq(r.ok, false); if (!/无返回值且无静态后缀/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});

console.log('\n=== 4. 安全（沙箱不得逃逸）===');
// 说明：node:vm 本身不是安全沙箱（Node 官方文档明确如此）。
// 这一组的职责是「防回归」：确认我们把宿主函数挡在沙箱外之后，
// 那些已知的低成本逃逸表达式仍然拿不到宿主对象。
// 真正的隔离边界在 CI 的独立低权限 job（见 .github/workflows/js-eval.yml）。

test('拿不到 require / process / Buffer（typeof 均为 undefined）', () => {
  for (const name of ['require', 'process', 'Buffer', 'global']) {
    const r = evaluateSearchJs({ su: `@js:java.put('url', typeof ${name});`, base: BASE, key: 'k' });
    eq(r.ok, true, name + ' 应求值成功');
    eq(r.url, 'undefined', name + ' 在沙箱内必须不存在');
  }
});

// 评审指出的核心逃逸面：从「宿主传入的函数」上取 constructor。
// 修复前 java.put.constructor('return process')().version 能返回真实版本号。
const HOST_FN_TARGETS = [
  'java.put', 'java.get', 'java.log', 'java.ajax', 'java.post',
  'source.getKey', 'source.getVariable', 'cookie.getKey', 'cookie.removeCookie',
  'md5Encode', 'base64Encode',
];
test('宿主/工具函数的 constructor 逃逸全部被拒', () => {
  for (const target of HOST_FN_TARGETS) {
    const r = evaluateSearchJs({
      su: `@js:java.put('url', String(${target}.constructor('return process')().version));`,
      base: BASE,
      key: 'k',
    });
    eq(r.ok, false, target + ' 逃逸必须失败，实际: ' + JSON.stringify(r));
    if (!/越界被拒|求值失败|沙箱/.test(r.skip)) {
      throw new Error(target + ' 的拒绝理由不明确: ' + r.skip);
    }
  }
});

test('this.constructor.constructor 逃逸被拒', () => {
  const r = evaluateSearchJs({
    su: "@js:java.put('url', String(this.constructor.constructor('return process')()));",
    base: BASE,
    key: 'k',
  });
  eq(r.ok, false);
  if (!/越界被拒|求值失败|沙箱/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});

test('Object / JSON 构造器逃逸被拒', () => {
  for (const expr of [
    "Object.constructor('return process')().version",
    "JSON.stringify.constructor('return process')().version",
  ]) {
    const r = evaluateSearchJs({ su: `@js:java.put('url', String(${expr}));`, base: BASE, key: 'k' });
    eq(r.ok, false, expr);
  }
});

test('死循环被超时切断', () => {
  const t0 = Date.now();
  const r = evaluateSearchJs({ su: '@js:while(true){}', base: BASE, key: 'k' });
  eq(r.ok, false); if (!/超时/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
  if (Date.now() - t0 > 3000) throw new Error('超时保护失效，耗时 ' + (Date.now() - t0) + 'ms');
});

// ── 受限网络（2026-10-31）──────────────────────────────────────────────────
//
// 语义变化：java.ajax/post/get 从「一律拒绝」改为「**同源**且能预取到才给结果」。
// 边界一条没松：只允许书源自己 origin、只 GET/POST、有超时与体积上限、
// 跨站 / file / userinfo 伪装一律拒绝并降级为 skip（绝不判死源）。
test('网络能力：跨站请求一律拒绝并降级 skip（不判死）', () => {
  for (const api of ['ajax', 'post', 'get']) {
    const r = evaluateSearchJs({ su: '@js:java.' + api + "('https://evil.example.com/x')", base: BASE, key: 'k' });
    eq(r.ok, false, 'java.' + api + ' 应失败');
    if (!/需要联网/.test(r.skip)) throw new Error('java.' + api + ' 应降级为「需要联网」而不是别的: ' + r.skip);
  }
});

test('网络能力：connect（socket）仍不支持', () => {
  const r = evaluateSearchJs({ su: "@js:java.connect('127.0.0.1:80')", base: BASE, key: 'k' });
  eq(r.ok, false);
  if (!/需要联网/.test(r.skip)) throw new Error('connect 应降级为需要联网: ' + r.skip);
});

test('网络安全闸门：sameOriginAllowed 的四个拒绝面', () => {
  const net = require('../src/legado-js-net.js');
  const O = 'https://a.example.com';
  const cases = [
    [O + '/x', true, '同源放行'],
    ['https://b.example.com/x', false, '跨站拒绝'],
    ['file:///etc/passwd', false, 'file 协议拒绝'],
    ['https://a.example.com@evil.com/x', false, 'userinfo 伪装拒绝'],
    ['http://a.example.com/x', false, '协议不一致拒绝'],
  ];
  for (const [u, want, label] of cases) eq(net.sameOriginAllowed(u, O), want, label);
});

test('网络安全闸门：LEGADO_JS_NET=0 可彻底关闭', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(process.execPath, ['-e', `
    process.env.LEGADO_JS_NET='0';
    const n=require(${JSON.stringify(require.resolve('../src/legado-js-net.js'))});
    const r=n.syncFetch({url:'https://a.example.com/x',method:'GET',sourceOrigin:'https://a.example.com'});
    console.log(n.ENABLED+'|'+(r.ok?'ok':'blocked:'+r.reason));
  `], { encoding: 'utf8', timeout: 30000 }).trim();
  if (!out.startsWith('false|blocked')) throw new Error('关网开关失效: ' + out);
});

test('沙箱内不存在真实网络对象（隔离边界未放松）', () => {
  // 关键回归：VM 里不能出现 fetch / XMLHttpRequest / require / process
  for (const probe of ['fetch', 'XMLHttpRequest', 'require', 'process', 'WebSocket']) {
    const r = evaluateSearchJs({ su: '@js:(typeof ' + probe + "==='undefined'?'NO':'LEAK')", base: BASE, key: 'k' });
    const v = r.ok ? String(r.url || '') : '';
    if (v === 'LEAK') throw new Error('沙箱泄漏了 ' + probe);
  }
});

console.log('\n===== 汇总: ' + (pass + fail) + ' 项 =====');
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
if (fail === 0) console.log('\n🎉 legado-js 单元测试全部通过！');
process.exit(fail === 0 ? 0 : 1);
