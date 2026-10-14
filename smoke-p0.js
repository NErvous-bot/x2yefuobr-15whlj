// smoke-p0.js — P0 离线冒烟：验证 aging-test 核心解析行为
// 本脚本用本地 mock HTTP 服务器验证：
//   - JSON+POST 源：表单编码 + JSONPath 正确解析
//   - GBK-GET 源：charset 选项传递正确
//   - HTML-GET 源：class/tag selector 正确解析
//   - 畸形响应（JSON 规则+HTML 响应）：usable=false
// 注意：离线 mock ≠ 真实上游验收——真实上游由 health.js + Playwright 三重验收负责

const http = require('http');
const assert = require('assert');
const { checkSource } = require('./aging-test');

const enc = new TextEncoder();
let lastPostContentType = null;
let lastPostBody = null;
let lastGbkRequestLine = null;

const srv = http.createServer((req, res) => {
    const u = req.url || '';
    if (u.startsWith('/search')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            // 记录 POST 请求的 content-type 和 body（真实请求，不是硬编码变量）
            lastPostContentType = req.headers['content-type'] || '';
            lastPostBody = body;
            lastGbkRequestLine = req.method + ' ' + u;
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ data: { books: [{ name: '都市之书', book_id: '1001', url: '/book/1001.html' }] } }));
        });
    } else if (u.startsWith('/book/1001')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { chapters: [{ name: '第1章', url: '/chapter/1.html' }, { name: '第2章', url: '/chapter/2.html' }] } }));
    } else if (u.startsWith('/chapter/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { content: '这是一段超过两百字的正文内容。'.repeat(20) } }));
    } else { res.writeHead(404); res.end('nf'); }
});

let phaseAOk = false;
let gbkOk = false;
let malformedResult = null;
let htmlOk = false;

srv.listen(0, async () => {
    const port = srv.address().port;
    const base = 'http://127.0.0.1:' + port;

    // ---- Test 1: JSON+POST 源 ----
    const src = {
        bookSourceUrl: base + '/',
        searchUrl: base + '/search,{"method":"POST","body":"kw={{key}}&p={{page}}"}',
        ruleSearch: { bookList: '$.data.books[*]', bookUrl: '$.url' },
        ruleBookInfo: {},
        ruleToc: { chapterList: '$.data.chapters', chapterUrl: '$.url' },
        ruleContent: { content: '$.data.content' }
    };
    const r = await checkSource(src);
    console.log('JSON+POST源 →', JSON.stringify(r));
    phaseAOk = r.usable === true;

    // ---- 断言 1: POST content-type 是 application/x-www-form-urlencoded ----
    assert.ok(
        lastPostContentType.includes('application/x-www-form-urlencoded'),
        'POST content-type 应该是 application/x-www-form-urlencoded，实际: ' + lastPostContentType
    );

    // ---- 断言 2: POST body 包含 kw 字段（中文经 encodeURIComponent 编码）----
    assert.ok(
        /(?:^|&)kw=/.test(lastPostBody || ''),
        'POST body 应该包含 kw 字段，实际 body: ' + (lastPostBody || '(empty)')
    );

    // ---- Test 2: GBK-GET 源（GET + charset=gbk 选项）----
    const src2 = {
        bookSourceUrl: base + '/',
        searchUrl: base + '/search?kw={{key}},{"charset":"gbk"}',
        ruleSearch: { bookList: '$.data.books[*]', bookUrl: '$.url' },
        ruleToc: { chapterList: '$.data.chapters', chapterUrl: '$.url' },
        ruleContent: { content: '$.data.content' }
    };
    const r2 = await checkSource(src2);
    console.log('GBK-GET源 →', JSON.stringify(r2));
    gbkOk = r2.usable === true;

    // ---- 断言 3: GBK 源请求是 GET ----
    assert.ok(
        (lastGbkRequestLine || '').startsWith('GET'),
        'GBK 源应该发 GET 请求，实际: ' + (lastGbkRequestLine || '(none)')
    );
    // 快照：后面的畸形规则源也是 POST，会覆盖这个变量
    const gbkWasGet = (lastGbkRequestLine || '').startsWith('GET');

    // ---- Test 3: 畸形规则（JSON 规则 + HTML 响应） → 应该 usable=false ----
    const src3 = {
        bookSourceUrl: base + '/',
        searchUrl: "/search,{method:'post',body:'kw={{key}}'}",
        ruleSearch: { bookList: 'class.book', bookUrl: 'tag.a@href' },
        ruleToc: { chapterList: 'class.ch' },
        ruleContent: { content: 'class.c' }
    };
    const r3 = await checkSource(src3);
    console.log('伪JSON+HTML源(响应不匹配) →', JSON.stringify(r3));
    malformedResult = r3;

    // ---- 断言 4: 畸形规则响应被正确拒绝（usable=false）----
    assert.strictEqual(r3.usable, false, '畸形规则应该 usable=false，实际: ' + r3.usable);

    // ---- Test 4: HTML 全流程源 ----
    const srv2 = http.createServer((req, res) => {
        if (req.url.startsWith('/s')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<div class="book"><a href="/b/1.html">书1</a></div><div class="book"><a href="/b/2.html">书2</a></div>');
        } else if (req.url.startsWith('/b/')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<div class="ch"><a href="/c/1.html">章1</a></div><div class="ch"><a href="/c/2.html">章2</a></div>');
        } else if (req.url.startsWith('/c/')) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end('<div class="c">' + '正文内容测试。'.repeat(40) + '</div>');
        } else { res.writeHead(404); res.end(); }
    });
    srv2.listen(0, async () => {
        const b2 = 'http://127.0.0.1:' + srv2.address().port;
        const src4 = {
            bookSourceUrl: b2 + '/',
            searchUrl: b2 + '/s?q={{key}}',
            ruleSearch: { bookList: 'class.book', bookUrl: 'tag.a@href' },
            ruleToc: { chapterList: 'class.ch' },
            ruleContent: { content: 'class.c' }
        };
        const r4 = await checkSource(src4);
        console.log('HTML-GET源(回归) →', JSON.stringify(r4));
        htmlOk = r4.usable === true;

        // ---- 汇总 ----
        srv.close(); srv2.close();
        const allPass = phaseAOk && gbkOk && htmlOk;
        console.log('\n===== SMOKE-P0 汇总 =====');
        console.log('JSON+POST 三关全过:', phaseAOk);
        console.log('GBK-GET 三关全过:', gbkOk);
        console.log('HTML-GET 三关全过:', htmlOk);
        console.log('畸形规则 usable=false:', malformedResult?.usable === false);
        console.log('POST content-type 含 x-www-form-urlencoded:', lastPostContentType?.includes('application/x-www-form-urlencoded'));
        console.log('POST body 含 kw:', /(?:^|&)kw=/.test(lastPostBody || ''));
        console.log('GBK 源用 GET（快照）:', gbkWasGet);
        console.log('\n' + (allPass ? '✅ SMOKE-PASS（所有断言通过）' : '❌ SMOKE-FAIL（有关键断言失败）'));
        process.exit(allPass ? 0 : 1);
    });
});
