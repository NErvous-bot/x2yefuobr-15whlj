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
test('拿不到 require', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url', typeof require);", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, 'undefined');
});
test('拿不到 process', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url', typeof process);", base: BASE, key: 'k' });
  eq(r.ok, true); eq(r.url, 'undefined');
});
test('constructor 逃逸被拒', () => {
  const r = evaluateSearchJs({ su: "@js:java.put('url', String(this.constructor.constructor('return process')()));", base: BASE, key: 'k' });
  eq(r.ok, false); if (!/沙箱拒绝/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
});
test('死循环被超时切断', () => {
  const t0 = Date.now();
  const r = evaluateSearchJs({ su: '@js:while(true){}', base: BASE, key: 'k' });
  eq(r.ok, false); if (!/超时/.test(r.skip)) throw new Error('理由不符: ' + r.skip);
  if (Date.now() - t0 > 3000) throw new Error('超时保护失效，耗时 ' + (Date.now() - t0) + 'ms');
});
test('网络能力一律拒绝（ajax/post/get/connect）', () => {
  for (const api of ['ajax', 'post', 'get', 'connect']) {
    const r = evaluateSearchJs({ su: '@js:java.' + api + "('https://evil.example.com')", base: BASE, key: 'k' });
    eq(r.ok, false, 'java.' + api);
  }
});

console.log('\n===== 汇总: ' + (pass + fail) + ' 项 =====');
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
if (fail === 0) console.log('\n🎉 legado-js 单元测试全部通过！');
process.exit(fail === 0 ? 0 : 1);
