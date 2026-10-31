// tests/data-contract.test.mjs —— 导出 → 导入 → 评分 的端到端数据契约测试
//
// 为什么需要它：
//   2026-10-30 曾出现一次真实的链路断裂 —— export-health-json.js 只导出
//   {url, state, health, note} 四个字段，而 score.js 的评分基础分依赖
//   search / toc / content 三要素、三振判死依赖 recent、fuse.js 依赖 flapping。
//   结果 146 个可用源的平均基础分从 70 塌到 25（-64%），核心层被误降观察层。
//   当时每个模块的单测都通过 —— 问题出在模块之间的**数据契约**上。
//
// 本测试模拟完整链路：
//   health 报告 → export-health-json（隔离 job 产物）→ 生产端导入 → score.js 评分
// 并断言「评分结果与直接用原始 health 报告算出来的一致」，以此锁死契约。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

let pass = 0;
let fail = 0;
function test(name, fn) {
    try {
        fn();
        pass++;
        console.log('  ✅ ' + name);
    } catch (e) {
        fail++;
        console.log('  ❌ ' + name + '  ->  ' + (e && e.message ? e.message : e));
    }
}

// ── 构造一份最小但字段完整的 health 报告 ────────────────────────────────────
function makeHealth() {
    return {
        updatedAt: Date.now(),
        summary: { total: 3 },
        sources: {
            'https://a.example.com': {
                name: '源A', health: 80, search: true, toc: true, content: true,
                chapters: 3, contentLen: 900, responseTime: 120, note: '通过',
                checkedAt: Date.now(), recent: ['pass', 'pass', 'pass'],
                flapping: false, explore: true, exploreNote: '',
            },
            'https://b.example.com': {
                name: '源B', health: 40, search: true, toc: false, content: true,
                chapters: 1, contentLen: 250, responseTime: 600, note: '目录为空',
                checkedAt: Date.now(), recent: ['fail', 'fail', 'pass'],
                flapping: true, explore: null, exploreNote: '',
            },
            'https://c.example.com': {
                name: '源C', health: null, search: false, toc: false, content: false,
                chapters: 0, contentLen: 0, responseTime: 0, note: 'JS需要联网(java.ajax)',
                checkedAt: Date.now(), recent: [],
                flapping: false, explore: null, exploreNote: '',
            },
        },
    };
}

/** 在临时目录里跑 export-health-json.js，返回产物对象 */
function runExport(health) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-export-'));
    fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'health', 'source_health.json'), JSON.stringify(health));
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'export-health-json.js')], {
        cwd: dir, stdio: 'pipe',
    });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'js-eval-result.json'), 'utf8'));
    return { dir, out };
}

/** 复刻 update.yml 里的导入重建逻辑（保持与 workflow 同步） */
function importResult(j) {
    const allowed = new Set(['available', 'broken', 'untestable']);
    const sources = {};
    for (const r of j.results) {
        assert.ok(allowed.has(r.state), 'bad state ' + r.state);
        const bool = (x, n) => { assert.ok(x === null || typeof x === 'boolean', 'bad ' + n); return x; };
        const num = (x, n) => { assert.ok(x === null || (typeof x === 'number' && Number.isFinite(x)), 'bad ' + n); return x; };
        const str = (x, n) => { assert.ok(typeof x === 'string', 'bad ' + n); return x; };
        assert.ok(Array.isArray(r.recent), 'bad recent');
        sources[r.url] = {
            name: str(r.name, 'name'),
            health: num(r.health, 'health'),
            search: bool(r.search, 'search'),
            toc: bool(r.toc, 'toc'),
            content: bool(r.content, 'content'),
            chapters: num(r.chapters, 'chapters'),
            contentLen: num(r.contentLen, 'contentLen'),
            responseTime: num(r.responseTime, 'responseTime'),
            note: str(r.note, 'note'),
            checkedAt: num(r.checkedAt, 'checkedAt'),
            recent: r.recent.slice(),
            flapping: bool(r.flapping, 'flapping'),
            explore: bool(r.explore, 'explore'),
            exploreNote: str(r.exploreNote, 'exploreNote'),
        };
    }
    return { updatedAt: j.generatedAt, summary: { total: j.results.length }, sources };
}

/** 复刻 score.js 的基础分公式（L139） */
function baseScore(v) {
    return (v.search ? 20 : 0) + (v.toc ? 25 : 0) + (v.content ? 25 : 0);
}

console.log('=== 导出 → 导入 → 评分 端到端契约 ===\n');

test('导出产物包含 score.js 依赖的全部字段', () => {
    const { out } = runExport(makeHealth());
    assert.equal(out.version, 2, 'version 应为 2（v1 缺字段）');
    const row = out.results[0];
    for (const k of ['url', 'state', 'search', 'toc', 'content', 'recent', 'flapping',
        'health', 'name', 'chapters', 'contentLen', 'responseTime', 'note', 'checkedAt',
        'explore', 'exploreNote']) {
        assert.ok(Object.prototype.hasOwnProperty.call(row, k), '导出缺少字段: ' + k);
    }
    assert.equal(Object.keys(row).length, 16, '字段数应为 16');
});

test('导出→导入往返后，评分基础分与原始报告一致', () => {
    const health = makeHealth();
    const { out } = runExport(health);
    const imported = importResult(out);
    for (const url of Object.keys(health.sources)) {
        const orig = health.sources[url];
        const round = imported.sources[url];
        assert.ok(round, '导入后缺少源: ' + url);
        assert.equal(baseScore(orig), baseScore(round),
            url + ' 基础分不一致: 原始 ' + baseScore(orig) + ' vs 往返 ' + baseScore(round));
    }
});

test('search/toc 不再丢失（回归：曾导致 70→25）', () => {
    const { out } = runExport(makeHealth());
    const row = out.results.find((r) => r.url === 'https://a.example.com');
    assert.equal(row.search, true, 'search 必须保留为 true');
    assert.equal(row.toc, true, 'toc 必须保留为 true');
    assert.equal(baseScore(row), 70, '全通过源的基础分必须是 70（20+25+25）');
});

test('recent 历史与 flapping 完整传递', () => {
    const health = makeHealth();
    const { out } = runExport(health);
    const imported = importResult(out);
    const b = imported.sources['https://b.example.com'];
    assert.deepEqual(b.recent, ['fail', 'fail', 'pass'], 'recent 历史必须逐项保留');
    assert.equal(b.flapping, true, 'flapping 必须保留');
    const a = imported.sources['https://a.example.com'];
    assert.equal(a.flapping, false, 'flapping=false 不能被当成 unknown');
});

test('不可测源在往返后仍是 untestable，不被降级为 broken', () => {
    const { out } = runExport(makeHealth());
    const c = out.results.find((r) => r.url === 'https://c.example.com');
    assert.equal(c.state, 'untestable', 'health=null 必须判 untestable');
    const imported = importResult(out);
    assert.equal(imported.sources['https://c.example.com'].health, null, 'health 必须保持 null');
});

test('数字零值与 false 不被误判为空', () => {
    const health = makeHealth();
    health.sources['https://z.example.com'] = {
        name: '零值源', health: 0, search: false, toc: false, content: false,
        chapters: 0, contentLen: 0, responseTime: 0, note: '',
        checkedAt: 0, recent: [], flapping: false, explore: false, exploreNote: '',
    };
    const { out } = runExport(health);
    const z = out.results.find((r) => r.url === 'https://z.example.com');
    assert.equal(z.health, 0, 'health=0 必须保留为 0 而不是 null');
    assert.equal(z.chapters, 0, 'chapters=0 必须保留');
    assert.equal(z.explore, false, 'explore=false 必须保留（不是 null）');
    assert.equal(z.recent.length, 0, '空 recent 必须是空数组');
});

test('recent 超过 5 条时按三振口径截断为最近 5 条', () => {
    const health = makeHealth();
    health.sources['https://r.example.com'] = {
        name: '长历史', health: 50, search: true, toc: true, content: true,
        chapters: 2, contentLen: 400, responseTime: 200, note: '',
        checkedAt: Date.now(),
        recent: ['pass', 'fail', 'pass', 'fail', 'pass', 'fail', 'pass', 'fail'],
        flapping: false, explore: null, exploreNote: '',
    };
    const { out } = runExport(health);
    const r = out.results.find((x) => x.url === 'https://r.example.com');
    assert.equal(r.recent.length, 5, 'recent 必须截断为 5 条');
    assert.deepEqual(r.recent, ['fail', 'pass', 'fail', 'pass', 'fail'], '应保留最后 5 条');
});

// ── 孤儿键裁剪（run 41184777297 之后补）──────────────────────────────────────
//
// 背景：health 报告的 sources 键是 norm(bookSourceUrl)。成品每轮会被 quarantine
// 删掉一些源，旧报告里就残留「成品已剔除」的孤儿键。若不裁掉，update.yml 对账会以
// 'result url not in product' 整轮拒收。CI 里不会发生（health.js 现读 legado.json），
// 但本地复跑会和 CI 不一致 —— 这条测试锁死「导出器自己就把差异消掉」。

test('legado.json 存在时按身份键裁掉孤儿键（本地与 CI 行为一致）', () => {
    const health = makeHealth();
    // 四个 URL 里只有 a / b 写进成品；c / z 是「成品已剔除」的孤儿
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-prune-'));
    fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'health', 'source_health.json'), JSON.stringify(health));
    fs.writeFileSync(path.join(dir, 'legado.json'), JSON.stringify([
        { bookSourceName: 'A', bookSourceUrl: 'https://a.example.com' },
        { bookSourceName: 'B', bookSourceUrl: 'https://b.example.com#x' }, // 带 # 也要能对上 norm
    ]));
    execFileSync(process.execPath, [path.join(REPO, 'scripts', 'export-health-json.js')], {
        cwd: dir, stdio: 'pipe',
    });
    const out = JSON.parse(fs.readFileSync(path.join(dir, 'js-eval-result.json'), 'utf8'));
    const urls = out.results.map((r) => r.url).sort();
    assert.deepEqual(urls, ['https://a.example.com', 'https://b.example.com'],
        '孤儿键必须被裁掉，且带 # 的成品 URL 要按 norm 匹配上');
    assert.equal(out.totalSources, 2, 'totalSources 必须等于裁剪后的行数');
    assert.equal(out.totalSources, out.results.length, '契约：totalSources === results.length');
});

test('legado.json 不存在时不裁剪（构造式单测保持旧行为）', () => {
    const health = makeHealth();   // a / b / c 共 3 个源
    const { out } = runExport(health);   // runExport 的临时目录里没有 legado.json
    assert.equal(out.results.length, 3, '无 legado.json 时不得丢弃任何行');
    assert.equal(out.totalSources, 3, 'totalSources 应为原始行数');
});

test('裁剪后为空时 fail-closed（拒绝产出空壳）', () => {
    const health = makeHealth();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-prune-empty-'));
    fs.mkdirSync(path.join(dir, 'health'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'health', 'source_health.json'), JSON.stringify(health));
    // 成品里一个都对不上
    fs.writeFileSync(path.join(dir, 'legado.json'), JSON.stringify([
        { bookSourceName: 'X', bookSourceUrl: 'https://x.example.com' },
    ]));
    let threw = false;
    try {
        execFileSync(process.execPath, [path.join(REPO, 'scripts', 'export-health-json.js')], {
            cwd: dir, stdio: 'pipe',
        });
    } catch (e) {
        threw = true;
    }
    assert.equal(threw, true, '全部键都不在成品里时必须非零退出，而不是写出空壳');
});

console.log(`\n===== 汇总: ${pass + fail} 项 =====`);
console.log('✅ 通过: ' + pass);
console.log('❌ 失败: ' + fail);
if (fail === 0) console.log('\n🎉 数据契约端到端测试全部通过！');
process.exit(fail === 0 ? 0 : 1);
