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

test('fuse.js 用 git ls-tree 区分文件不存在 vs Git 异常（P1-2 最终版）', () => {
    const code = fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8');
    // 1. 用 git ls-tree 不是 git cat-file -e
    assert.ok(code.includes('git ls-tree HEAD --'), 'blobExists() 应用 git ls-tree 查询');
    assert.ok(!code.includes('git cat-file -e'), '不应再用 git cat-file -e 判定文件存在性');
    // 2. 三层判定结构
    assert.ok(code.includes('blobExists'), '应定义 blobExists 函数');
    assert.ok(code.includes('无基线报告（首次运行）'), '双缺时应明确打印首次运行');
    assert.ok(code.includes('基线状态不一致'), '应显式检查 health/legado 存在性不对称');
    // 3. catch 里 throw Git 异常不是 return false
    assert.ok(code.includes('git ls-tree 失败'), 'git 异常应 throw 报错而非伪装成不存在');
});

// 动态故障注入工具：创建带 src/source-id.js 依赖的临时 git repo
function makeTestFuseRepo({ healthContent = null, legadoContent = null } = {}) {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fuse-test-'));
    // 准备模块依赖（fuse.js 有 require('./src/source-id')）
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
    fs.writeFileSync(path.join(tmp, 'fuse.js'), fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8'));
    // 其他 fuse.js 需要的常量（ROLLBACK_FILES 等通过代码引用，不需要提前创建）
    // 初始化 git
    execSync('git init', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.email test@test.com', { cwd: tmp, stdio: 'pipe' });
    execSync('git config user.name Test', { cwd: tmp, stdio: 'pipe' });
    // 健康报告 JSON（必须有，fuse.js L99 会读）
    fs.mkdirSync(path.join(tmp, 'health'));
    fs.writeFileSync(path.join(tmp, 'health', 'source_health.json'), healthContent || JSON.stringify({ checkedAt: 0, total: 0, available: 0 }));
    // legado.json 也必须有
    fs.writeFileSync(path.join(tmp, 'legado.json'), legadoContent || '[]');
    execSync('git add -A && git commit -m "add baseline"', { cwd: tmp, stdio: 'pipe' });
    return tmp;
}

test('动态: 真首次运行（双基线不存在）→ exit 0', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fuse-test-firstrun-'));
    try {
        // 依赖 + fuse.js
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
        fs.writeFileSync(path.join(tmp, 'fuse.js'), fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8'));
        execSync('git init', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.email test@test.com', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.name Test', { cwd: tmp, stdio: 'pipe' });
        execSync('git commit --allow-empty -m "init"', { cwd: tmp, stdio: 'pipe' });
        // 故意不创建 health/source_health.json 和 legado.json
        const r = spawnSync(process.execPath, ['fuse.js'], { cwd: tmp, encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `真首次运行应 exit 0，实际 exit=${r.status}`);
        assert.ok((r.stdout || '').includes('无基线报告'), '应打印首次运行提示');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('动态: 损坏的 health JSON → fail-closed exit 1（不是 MODULE_NOT_FOUND）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fuse-test-corrupt-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
        fs.writeFileSync(path.join(tmp, 'fuse.js'), fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8'));
        execSync('git init', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.email test@test.com', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.name Test', { cwd: tmp, stdio: 'pipe' });
        fs.mkdirSync(path.join(tmp, 'health'));
        fs.writeFileSync(path.join(tmp, 'health', 'source_health.json'), '{ INVALID JSON');
        fs.writeFileSync(path.join(tmp, 'legado.json'), '[{"bookSourceUrl":"https://example.com","bookSourceName":"test"}]');
        execSync('git add -A && git commit -m "add baseline"', { cwd: tmp, stdio: 'pipe' });
        const r = spawnSync(process.execPath, ['fuse.js'], { cwd: tmp, encoding: 'utf8' });
        assert.ok(r.status === 1, `损坏基线应 exit 1，实际 exit=${r.status}; stderr=${r.stderr?.slice(0, 200)}`);
        // 关键断言：排除 MODULE_NOT_FOUND，确认是目标保护逻辑触发
        const combined = (r.stdout || '') + '\n' + (r.stderr || '');
        assert.ok(!combined.includes('MODULE_NOT_FOUND'), '不应是模块缺失导致的失败');
        assert.ok(combined.includes('解析失败') || combined.includes('拒绝发布'), 
                  `应包含目标错误信息，实际输出: ${combined.slice(0, 300)}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('动态: 单基线缺失（health 有 legado 无）→ fail-closed exit 1', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fuse-test-missing-'));
    try {
        fs.mkdirSync(path.join(tmp, 'src'));
        fs.copyFileSync(path.join(REPO, 'src', 'source-id.js'), path.join(tmp, 'src', 'source-id.js'));
        fs.writeFileSync(path.join(tmp, 'fuse.js'), fs.readFileSync(path.join(REPO, 'fuse.js'), 'utf8'));
        execSync('git init', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.email test@test.com', { cwd: tmp, stdio: 'pipe' });
        execSync('git config user.name Test', { cwd: tmp, stdio: 'pipe' });
        // 只有 health/source_health.json，故意不创建 legado.json
        fs.mkdirSync(path.join(tmp, 'health'));
        fs.writeFileSync(path.join(tmp, 'health', 'source_health.json'), JSON.stringify({ checkedAt: 0, total: 0, available: 0 }));
        execSync('git add -A && git commit -m "partial baseline"', { cwd: tmp, stdio: 'pipe' });
        // fuse.js 会在运行时读取工作区 legado.json（不存在）也没关系，blobExists 返回 false
        const r = spawnSync(process.execPath, ['fuse.js'], { cwd: tmp, encoding: 'utf8' });
        assert.ok(r.status === 1, `单基线缺失应 exit 1，实际 exit=${r.status}`);
        assert.ok((r.stdout || '').includes('基线状态不一致') || (r.stderr || '').includes('基线状态不一致'), 
                  `应检测到状态不一致，stdout=${r.stdout?.slice(0,200)} stderr=${r.stderr?.slice(0,200)}`);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
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
// 9. score.js 单次失败 vs 稳定死亡
// ============================================================
console.log('\n=== 9. score.js 单次失败不直接打 weight 5（行为级） ===');
const { grade, consOf } = require('../score.js');

test('单次 content=false + 本轮 fail 追加到 recent → watch/50（不进 dead）', () => {
    // 真实 health.js 行为：本轮 content=false 会 push 'fail' 到 recent 再写回
    // 所以单次失败的真实状态是 recent 末尾多一个 fail，不是只有历史 pass
    const v = { health: 75, search: true, toc: true, content: false, recent: ['pass', 'pass', 'pass', 'fail'] };
    const g = grade(v);
    assert.notStrictEqual(g.layer, 'dead', '单次失败（即使已追加 fail）不应进 dead');
    assert.notStrictEqual(g.weight, 5, 'weight 不应是 5');
    // base=20+25+0=45, stab=round(3/4*20)=15-5(consFail=1)=10, streak=0, score=55 → watch/50
    assert.strictEqual(g.layer, 'watch', '应为 watch 层');
    assert.strictEqual(g.weight, 50, 'weight 应为 50');
});

test('连续 2 次失败（最近两轮都是 fail）→ watch/50（不进 dead）', () => {
    const v = { health: 40, search: false, toc: false, content: true, recent: ['pass', 'pass', 'fail', 'fail'] };
    const g = grade(v);
    assert.notStrictEqual(g.layer, 'dead', '2 次 fail 不应进 dead（需要 content=false 才触发）');
    assert.strictEqual(g.weight, 50, '连续 2 次 fail → watch/50');
});

test('连续 3 次 fail + content=false → dead/weight5（稳定死亡）', () => {
    const v = { health: 20, search: false, toc: false, content: false, recent: ['pass', 'fail', 'fail', 'fail'] };
    const g = grade(v);
    assert.strictEqual(g.layer, 'dead', '3 次连续 fail + content=false → dead');
    assert.strictEqual(g.weight, 5, 'weight 应为 5');
});

test('连续 3 次 fail 但 content=true → watch/30（强制观察，不进 dead）', () => {
    const v = { health: 50, search: true, toc: true, content: true, recent: ['pass', 'fail', 'fail', 'fail'] };
    const g = grade(v);
    assert.notStrictEqual(g.layer, 'dead', 'content=true 不进 dead 即使 consFail>=3');
    assert.strictEqual(g.layer, 'watch', '应为 watch 层');
    assert.strictEqual(g.weight, 30, 'consFail>=3 → weight 30');
});

test('不可测池区分：曾有 pass→440，从未验证→380', () => {
    const v1 = { health: null, recent: ['pass'] };
    const v2 = { health: null, recent: [] };
    assert.strictEqual(grade(v1).weight, 440, '曾实测通过 weight=440');
    assert.strictEqual(grade(v2).weight, 380, '从未验证 weight=380');
    assert.strictEqual(grade(null).weight, 380, 'null weight=380');
});

// ============================================================
// 10. rules.js 误伤校验无正则 lastIndex 漏计
// ============================================================
console.log('\n=== 10. rules.js 正则误伤校验 ===');
test('rules.js 误伤校验不用全局正则 /g flag（防 lastIndex 状态漏计）', () => {
    const code = require('fs').readFileSync(path.join(REPO, 'rules.js'), 'utf8');
    // 找到候选规则误伤校验的 for 循环段落
    const m = code.match(/let fp = 0[\s\S]{0,400}?for\s*\(\s*const\s+p\s+of\s+cleanParas\s*\)/);
    assert.ok(m, '找到误伤校验循环');
    // 确认循环前没有 const re = new RegExp(c.pat, 'g')
    assert.ok(!/const\s+re\s*=\s*new\s+RegExp\(\s*c\.pat\s*,\s*['"]g['"]\s*\)/.test(m[0]),
        '误伤校验循环前不应有带 g flag 的全局正则');
});

test('动态: 多段重复匹配不漏计（全局正则 lastIndex 漏计验证）', () => {
    // 模拟原始有 bug 的写法 vs 修复后的写法
    const pats = ['<script>', '<iframe>'];
    const paras = [
        '这里有个<script>标签',
        '另一段也有<script>在里面',
        '第三段是<iframe>嵌入',
        '纯文本段落没有标记',
        '又一个<script>出现在这里'
    ];

    // 旧写法（bug）：循环外 new RegExp(c.pat, 'g')
    let fpBuggy = 0;
    for (const pat of pats) {
        const re = new RegExp(pat, 'g'); // 全局正则 → lastIndex 状态泄漏
        for (const p of paras) if (re.test(p)) fpBuggy++;
    }

    // 新写法（修复）：每段 new RegExp(c.pat)
    let fpFixed = 0;
    for (const pat of pats) {
        for (const p of paras) {
            const re = new RegExp(pat); // 无 g flag → 每次从头匹配
            if (re.test(p)) fpFixed++;
        }
    }

    // 期望值：<script> 匹配段 1/2/5（3段），<iframe> 匹配段 3（1段），总计 4 段
    assert.strictEqual(fpFixed, 4, '修复后应计 4 段误伤（3段<script> + 1段<iframe>）');
    assert.ok(fpBuggy <= fpFixed, '修复后计数应≥旧写法计数（旧写法漏计）');
    assert.ok(fpBuggy < 4, '旧写法的 lastIndex 状态确实导致漏计（验证 bug 存在）');
});

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
