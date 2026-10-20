// tests/repo-regression.test.js — 回归测试（纯 Node 内置 assert + fs，无外部依赖）
// 运行：node tests/repo-regression.test.js
// 本脚本在临时目录里执行破坏性测试，绝不修改生产 legado.json

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
let passed = 0, failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (e) {
        failed++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${e.message || e}`);
    }
}

function makeTempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'legado-test-'));
}

// ============================================================
// 0. 准备：所有脚本都能 node --check 过
// ============================================================
console.log('\n=== 0. 语法检查 ===');
const filesToCheck = [
    'rank-legado.js',
    'health.js',
    'smoke-p0.js',
];
for (const f of filesToCheck) {
    test(`node --check ${f}`, () => {
        const r = spawnSync(process.execPath, ['--check', path.join(REPO, f)]);
        assert.strictEqual(r.status, 0, `语法错误: ${r.stderr?.toString() || ''}`);
    });
}
// source-audit.mjs 是 ESM，直接 --check .mjs 文件即可
test('node --check scripts/source-audit.mjs (ESM)', () => {
    const r = spawnSync(process.execPath, ['--check', 'scripts/source-audit.mjs'], { cwd: REPO, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `语法错误: ${r.stderr?.toString() || ''}`);
});

// ============================================================
// 1. 排名：两个同名不同 URL 的书源不会串用健康数据
// ============================================================
console.log('\n=== 1. 排名：URL 身份不串用 ===');
test('同名不同 URL 各自独立的诊断数据', () => {
    const tmp = makeTempDir();
    const legado = [
        { bookSourceName: '测试源', bookSourceUrl: 'https://a.example.com', weight: 500, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
        { bookSourceName: '测试源', bookSourceUrl: 'https://b.example.com', weight: 500, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
    ];
    // 关键：bySource 里 A 源有 3 条正向 diff>=0 记录（会进 HIGH_PERFORMER）
    // B 源只有 2 条负向 diff<-200 记录（应该进 SEVERE_LAGGING）
    const summary = {
        books: {
            b1: { key: 'b1', title: '书1', reference: 500, bySource: [
                { url: 'https://a.example.com', name: '测试源', observed_chapters: 498, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
                { url: 'https://b.example.com', name: '测试源', observed_chapters: 30, diff: -470, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
            ]},
            b2: { key: 'b2', title: '书2', reference: 600, bySource: [
                { url: 'https://a.example.com', name: '测试源', observed_chapters: 595, diff: -5, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
                { url: 'https://b.example.com', name: '测试源', observed_chapters: 25, diff: -575, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
            ]},
            b3: { key: 'b3', title: '书3', reference: 400, bySource: [
                { url: 'https://a.example.com', name: '测试源', observed_chapters: 398, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
                { url: 'https://b.example.com', name: '测试源', observed_chapters: 20, diff: -380, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false },
            ]},
        }
    };

    fs.writeFileSync(path.join(tmp, 'legado.json'), JSON.stringify(legado, null, 2));
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'freshness-summary.json'), JSON.stringify(summary, null, 2));

    // 复制 rank-legado.js 并在临时目录运行
    fs.copyFileSync(path.join(REPO, 'rank-legado.js'), path.join(tmp, 'rank-legado.js'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
    const r = spawnSync(process.execPath, ['rank-legado.js'], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `rank-legado.js 失败: ${r.stderr}`);

    const ranked = JSON.parse(fs.readFileSync(path.join(tmp, 'ranked-legado.json'), 'utf8'));
    // 两个源都应该有 _diagnosis，且 tags 不同
    const aSrc = ranked.find(s => s.bookSourceUrl === 'https://a.example.com');
    const bSrc = ranked.find(s => s.bookSourceUrl === 'https://b.example.com');
    assert.ok(aSrc && aSrc._diagnosis, 'A 源应有 _diagnosis');
    assert.ok(bSrc && bSrc._diagnosis, 'B 源应有 _diagnosis');

    // A 源 3/3 正向 diff → positiveRatio=1.0 + tested=3 → HIGH_PERFORMER
    assert.ok(aSrc._diagnosis.tags.includes('HIGH_PERFORMER'), `A 源应有 HIGH_PERFORMER，实际 tags: ${aSrc._diagnosis.tags}`);
    // B 源 3/3 diff<-200 且 confidence!==low → lagCount>=2 → SEVERE_LAGGING
    assert.ok(bSrc._diagnosis.tags.includes('SEVERE_LAGGING'), `B 源应有 SEVERE_LAGGING，实际 tags: ${bSrc._diagnosis.tags}`);
    // 关键断言：A 和 B 的 score 应该不同（A 正分，B 负分）
    assert.ok(aSrc._diagnosis.score > bSrc._diagnosis.score, `A(${aSrc._diagnosis.score}) 应比 B(${bSrc._diagnosis.score}) 分高`);
});

// ============================================================
// 2. 排名：权重上下限为 0 和 1000
// ============================================================
console.log('\n=== 2. 排名：权重 clamp ===');
test('原权重 800 + HIGH_PERFORMER → 1000 而非 1800', () => {
    const tmp = makeTempDir();
    const legado = [
        { bookSourceName: '高权重源', bookSourceUrl: 'https://hi.example.com', weight: 800, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
    ];
    // 3 本全正向 diff → HIGH_PERFORMER（加 1000 bonus）
    const summary = { books: {
        b1: { key: 'b1', title: '书1', reference: 500, bySource: [{ url: 'https://hi.example.com', name: '高权重源', observed_chapters: 498, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false }]},
        b2: { key: 'b2', title: '书2', reference: 600, bySource: [{ url: 'https://hi.example.com', name: '高权重源', observed_chapters: 595, diff: -5, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false }]},
        b3: { key: 'b3', title: '书3', reference: 400, bySource: [{ url: 'https://hi.example.com', name: '高权重源', observed_chapters: 398, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false }]},
    }};
    fs.writeFileSync(path.join(tmp, 'legado.json'), JSON.stringify(legado, null, 2));
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'freshness-summary.json'), JSON.stringify(summary, null, 2));
    fs.copyFileSync(path.join(REPO, 'rank-legado.js'), path.join(tmp, 'rank-legado.js'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));

    const r = spawnSync(process.execPath, ['rank-legado.js'], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `失败: ${r.stderr}`);
    const ranked = JSON.parse(fs.readFileSync(path.join(tmp, 'ranked-legado.json'), 'utf8'));
    const w = ranked[0].weight;
    assert.strictEqual(w, 1000, `800*1.0+1000=1800 应该被 clamp 到 1000，实际: ${w}`);
});

test('原权重 1500 → clamp 到 1000（乘倍率后）', () => {
    const tmp = makeTempDir();
    const legado = [
        { bookSourceName: '边界源', bookSourceUrl: 'https://edge.example.com', weight: 1500, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
    ];
    const summary = { books: {
        b1: { key: 'b1', title: '书1', reference: 500, bySource: [{ url: 'https://edge.example.com', name: '边界源', observed_chapters: 498, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false }]},
    }};
    fs.writeFileSync(path.join(tmp, 'legado.json'), JSON.stringify(legado, null, 2));
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'freshness-summary.json'), JSON.stringify(summary, null, 2));
    fs.copyFileSync(path.join(REPO, 'rank-legado.js'), path.join(tmp, 'rank-legado.js'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
    const r = spawnSync(process.execPath, ['rank-legado.js'], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `失败: ${r.stderr}`);
    const ranked = JSON.parse(fs.readFileSync(path.join(tmp, 'ranked-legado.json'), 'utf8'));
    assert.ok(ranked[0].weight <= 1000, `权重 ${ranked[0].weight} 应 ≤ 1000`);
});

test('原权重 -5 → clamp 到 0', () => {
    const tmp = makeTempDir();
    const legado = [
        { bookSourceName: '负权重源', bookSourceUrl: 'https://neg.example.com', weight: -5, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
    ];
    const summary = { books: {
        b1: { key: 'b1', title: '书1', reference: 500, bySource: [{ url: 'https://neg.example.com', name: '负权重源', observed_chapters: 498, diff: -2, confidence: 'high', suspicious_truncation: false, pagination_rule_dormant: false }]},
    }};
    fs.writeFileSync(path.join(tmp, 'legado.json'), JSON.stringify(legado, null, 2));
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'freshness-summary.json'), JSON.stringify(summary, null, 2));
    fs.copyFileSync(path.join(REPO, 'rank-legado.js'), path.join(tmp, 'rank-legado.js'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
    const r = spawnSync(process.execPath, ['rank-legado.js'], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `失败: ${r.stderr}`);
    const ranked = JSON.parse(fs.readFileSync(path.join(tmp, 'ranked-legado.json'), 'utf8'));
    assert.ok(ranked[0].weight >= 0, `权重 ${ranked[0].weight} 应 ≥ 0`);
});

// ============================================================
// 3. 排名：源数量 / URL / 规则不变
// ============================================================
console.log('\n=== 3. 排名：生产保护校验 ===');
test('源数量和 URL 不变', () => {
    const tmp = makeTempDir();
    const legado = [
        { bookSourceName: 'A', bookSourceUrl: 'https://a.com', weight: 500, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
        { bookSourceName: 'B', bookSourceUrl: 'https://b.com', weight: 300, ruleToc: { nextTocUrl: '/next' }, ruleSearch: { bookList: 'x' }, ruleContent: { content: 'y' }, ruleBookInfo: {} },
    ];
    const summary = { books: {
        b1: { key: 'b1', title: '书1', reference: 500, bySource: [] }, // 空 bySource → 中性分组
    }};
    fs.writeFileSync(path.join(tmp, 'legado.json'), JSON.stringify(legado, null, 2));
    fs.mkdirSync(path.join(tmp, 'reports'));
    fs.writeFileSync(path.join(tmp, 'reports', 'freshness-summary.json'), JSON.stringify(summary, null, 2));
    fs.copyFileSync(path.join(REPO, 'rank-legado.js'), path.join(tmp, 'rank-legado.js'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
    const r = spawnSync(process.execPath, ['rank-legado.js'], { cwd: tmp, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `失败: ${r.stderr}`);
    const ranked = JSON.parse(fs.readFileSync(path.join(tmp, 'ranked-legado.json'), 'utf8'));
    assert.strictEqual(ranked.length, 2, '源数量应该不变');
    const origUrls = new Set(legado.map(s => s.bookSourceUrl));
    const rankUrls = new Set(ranked.map(s => s.bookSourceUrl));
    assert.deepStrictEqual(origUrls, rankUrls, 'URL 集合应完全一致');
});

// ============================================================
// 4. 审计脚本：不再包含内部 git commit / push
// ============================================================
console.log('\n=== 4. source-audit.mjs 不再自行发布 ===');
test('不含 git commit / git push / git pull 命令', () => {
    const code = fs.readFileSync(path.join(REPO, 'scripts', 'source-audit.mjs'), 'utf8');
    // 负向断言：以下字符串都不应出现在代码里（除了注释中的说明）
    const forbidden = [
        'execSync(\'git commit',
        'execSync(\'git push',
        'execSync(\'git pull',
        'execSync(\'git add',
        /import.*execSync.*child_process/,
    ];
    for (const p of forbidden) {
        if (p instanceof RegExp) {
            assert.ok(!p.test(code), `发现不应该存在的模式: ${p}`);
        } else {
            assert.ok(!code.includes(p), `发现不应该存在的字符串: ${p}`);
        }
    }
});

// ============================================================
// 5. 健康检查：致命异常使工作流失败
// ============================================================
console.log('\n=== 5. health.js 致命异常 → exit 1 ===');
test('health.js 的 catch 是 exit(1) 不是 exit(0)', () => {
    const code = fs.readFileSync(path.join(REPO, 'health.js'), 'utf8');
    assert.ok(code.includes('process.exit(1)'), 'health.js catch 应该 exit(1)');
    assert.ok(!code.includes("process.exit(0)") || !code.includes('不影响主流程'), 'health.js 不应有伪装成功的 exit(0)');
});

// ============================================================
// 6. Android：ConcurrentHashMap + latch await 检查
// ============================================================
console.log('\n=== 6. SyncWorker.java 并发安全 ===');
test('使用 ConcurrentHashMap 保存探测结果', () => {
    const code = fs.readFileSync(path.join(REPO, 'SourceAutoSync', 'app', 'src', 'main', 'java', 'io', 'nervous', 'sourcesync', 'SyncWorker.java'), 'utf8');
    assert.ok(code.includes('ConcurrentHashMap'), '应 import ConcurrentHashMap');
    assert.ok(code.includes('new ConcurrentHashMap<>()'), 'probeResults 应用 ConcurrentHashMap 初始化');
});

test('检查 latch.await 返回值 + 超时保留历史状态', () => {
    const code = fs.readFileSync(path.join(REPO, 'SourceAutoSync', 'app', 'src', 'main', 'java', 'io', 'nervous', 'sourcesync', 'SyncWorker.java'), 'utf8');
    assert.ok(code.includes('completed = latch.await'), '应捕获 latch.await 返回值');
    assert.ok(code.includes('Thread.currentThread().interrupt()'), 'InterruptedException 应恢复中断标志');
    assert.ok(code.includes('localOk = oldH.localAvailable'), '超时未完成应保留历史状态而非默认 true');
});

// ============================================================
// 7. P1 边界保护：故障注入静态审计
// ============================================================
console.log('\n=== 7. P1 边界保护代码存在性 ===');

test('fuse.js 区分"基线不存在"和"基线损坏"（P1-2 fail-closed）', () => {
    const code = fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8');
    // 1. blobExists 函数存在，用 git cat-file -e 预检查
    assert.ok(code.includes('git cat-file -e'), '应有 blobExists() 用 git cat-file -e');
    assert.ok(code.includes('blobExists'), '应定义 blobExists 函数');
    // 2. 三层判定：双缺→fail-open；单缺→fail-closed；双存在但解析失败→fail-closed
    assert.ok(code.includes('无基线报告（首次运行）'), '双缺时应明确打印首次运行');
    assert.ok(code.includes('process.exit(1)') && code.includes('解析失败') || code.includes('基线状态不一致'), 
              '应有基线损坏或不一致时的 exit(1) 分支');
    assert.ok(code.includes('基线状态不一致'), '应显式检查 health/legado 存在性不对称');
});

test('filter.js alive() 探测替代 upstream-removed（P1-1 生效）', () => {
    const code = fs.readFileSync(path.join(REPO, 'filter.js'), 'utf8');
    // 1. 应有 alive() / originOf() 调用
    assert.ok(code.includes('alive(') || code.includes('originOf('), '应有 alive() 或 originOf() 调用');
    // 2. 应有"保留旧源"分支（alive === true）
    assert.ok(code.includes('canonicalizeUrl'), '应有 canonicalizeUrl 用于回填旧源');
    // 3. upstream-removed 不再出现在自动写入的删除理由里（只在 legacy 读取里）
    // 简单验证：filter.js 没有"upstream-removed"作为 reason 赋值
    const noUpstreamAssign = !/reason\s*[:=]\s*['"]upstream-removed['"]/.test(code);
    assert.ok(noUpstreamAssign, 'filter.js 不应再写入 upstream-removed 作为 reason');
});

test('fuse.js 白名单不再包含 upstream-removed（P1-1）', () => {
    const code = fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8');
    // 匹配 new Set([...]) 或 [...] 两种可能
    const match = code.match(/LEGAL_DELETION_REASONS\s*=\s*(?:new\s+Set\()?\[([^\]]+)\]/);
    assert.ok(match, '应定义 LEGAL_DELETION_REASONS');
    assert.ok(!match[1].includes('upstream-removed'), '白名单不应包含 upstream-removed');
    // 应保留另外三个合法理由
    assert.ok(match[1].includes('probe-dead'), '白名单应包含 probe-dead');
    assert.ok(match[1].includes('aging-failed'), '白名单应包含 aging-failed');
    assert.ok(match[1].includes('canon-merged'), '白名单应包含 canon-merged');
});

// ============================================================
// 8. smoke-p0.js 必须通过真实断言
// ============================================================
console.log('\n=== 8. smoke-p0.js 真实运行 ===');
test('smoke-p0.js exit 0（所有断言通过）', () => {
    const r = spawnSync(process.execPath, ['smoke-p0.js'], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, `smoke-p0.js 退出码 ${r.status}，stderr: ${r.stderr?.slice(0, 500)}`);
});

// ============================================================
// 汇总
// ============================================================
console.log(`\n===== 回归测试汇总: ${passed + failed} 项 =====`);
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(failed === 0 ? '\n🎉 全部回归测试通过！' : '\n⚠️ 有测试失败，请排查');
process.exit(failed === 0 ? 0 : 1);
