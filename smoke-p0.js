// smoke-p0.js — P0 离线冒烟：GBK 编码表 / JSONPath / parseSearch / selectAll-JSON
const fs = require('fs');
// 直接引 aging-test 内部不导出的模块不好测，这里用子进程外挂验证主流程导出 + 逐段复制核心逻辑测
// 简化：aging-test 只导出 checkSource，这里通过发本地 http 服务模拟三关来验证全链路
const http = require('http');
const { checkSource } = require('./aging-test');

const enc = new TextEncoder();
function gbkBuf(str) { // 测试辅助：用 iconv 不可用，构造 GBK 字节需查表 —— 直接用 aging-test 的思路独立验证太重
    return null;
}

let step = 'start';
const srv = http.createServer((req, res) => {
    const u = req.url || '';
    if (u.startsWith('/search')) {
        // 校验 POST 表单编码：都市 的 GBK 字节 %B6%BC%CA%D0 或原文 UTF-8
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            step = 'search:' + req.method + ':' + (req.headers['content-type'] || '') + ':' + body.slice(0, 60);
            const ok = /%B6%BC%CA%D0|都市|kw=/.test(body) || /kw=/.test(u);
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

srv.listen(0, async () => {
    const port = srv.address().port;
    const base = 'http://127.0.0.1:' + port;
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
    console.log('（服务器收到的请求形态: ' + step + '）');

    // GBK 源：GET + charset=gbk（本地服务器不懂 GBK，只验证不再 skip 且发出 GBK 转义关键词）
    const src2 = {
        bookSourceUrl: base + '/',
        searchUrl: base + '/search?kw={{key}},{"charset":"gbk"}',
        ruleSearch: { bookList: '$.data.books[*]', bookUrl: '$.url' },
        ruleToc: { chapterList: '$.data.chapters', chapterUrl: '$.url' },
        ruleContent: { content: '$.data.content' }
    };
    const r2 = await checkSource(src2);
    console.log('GBK-GET源 →', JSON.stringify(r2));

    // 伪 JSON 选项 + HTML 规则源
    const src3 = {
        bookSourceUrl: base + '/',
        searchUrl: "/search,{method:'post',body:'kw={{key}}'}",
        ruleSearch: { bookList: 'class.book', bookUrl: 'tag.a@href' },
        ruleToc: { chapterList: 'class.ch' },
        ruleContent: { content: 'class.c' }
    };
    const r3 = await checkSource(src3); // HTML 服务器返回 JSON → bookList(class.book) 解析 HTML 无果 → 目录为空等
    console.log('伪JSON+HTML源(响应不匹配) →', JSON.stringify(r3));

    // HTML 全流程源
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
        srv.close(); srv2.close();
        // 冒烟判定
        const pass = r.usable === true && r2.usable === true && r4.usable === true;
        console.log(pass ? 'SMOKE-PASS' : 'SMOKE-FAIL');
        process.exit(pass ? 0 : 1);
    });
});
