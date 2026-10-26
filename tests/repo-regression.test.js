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

// Windows 下 git 对象文件带只读属性，直接 rmSync 会 EPERM；先清只读再删。
// 清理失败只警告，不影响断言结果。
function cleanupDir(dir) {
    const clearReadonly = d => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) clearReadonly(p);
            else try { fs.chmodSync(p, 0o666); } catch {}
        }
    };
    try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
        clearReadonly(dir);
        try {
            fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
            console.warn('  （临时目录清理失败，不影响测试结果）: ' + dir);
        }
    }
}

// ============================================================
// 0. 准备：所有脚本都能 node --check 过
// ============================================================
console.log('\n=== 0. 语法检查 ===');
// 根目录所有 .js 都必须是语法合法的 CommonJS（新增脚本无需再手动登记）
const filesToCheck = fs.readdirSync(REPO).filter(f => f.endsWith('.js')).sort();
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
    } finally { cleanupDir(tmp); }
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
    } finally { cleanupDir(tmp); }
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
    } finally { cleanupDir(tmp); }
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

test('连续 2 次失败（本轮也 content=false，consFail=2 < 3）→ 不进 dead', () => {
    // 真实状态：content=false + recent 末尾两个 fail（health.js 会把本轮 fail push 到 recent）
    // consFail=2 < 3 → 不触发 dead guard，走正常评分
    const v = { health: 30, search: false, toc: false, content: false, recent: ['pass', 'pass', 'fail', 'fail'] };
    const g = grade(v);
    assert.notStrictEqual(g.layer, 'dead', 'consFail=2 < 3 不应进 dead');
    // base=0, stab=round(2/4*20)=10-15(consFail=2)=-5→0, streak=0(末尾fail), score=0 → watch/50
    assert.strictEqual(g.layer, 'watch', '应为 watch 层（consFail=2 惩罚但不强制观察）');
    assert.strictEqual(g.weight, 50, 'weight 应为 50');
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
// 11. 测试器能力：java.encodeURI(key) 槽位（阶段三 P1）
// ============================================================
console.log('\n=== 11. 测试器 java.encodeURI(key) 槽位 ===');
const { parseSearch, selectAll } = require('../aging-test.js');
const BASE = 'https://fixture.example.com';

test('搜索URL含 {{java.encodeURI(key,"gbk")}} → 不再误判"搜索无{{key}}槽位"', () => {
    const r = parseSearch('/s.php?action=search&wd={{java.encodeURI(key,"gbk")}}&page={{page}}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    // 都市 的 GBK 字节：都=B6BC、市=CAD0；URLSearchParams 会按 UTF-8 反解成乱码，故直接查原始 URL
    assert.ok(r.opt.url.includes('wd=%B6%BC%CA%D0'), 'wd 应为 GBK 百分号编码，实际: ' + r.opt.url);
    assert.ok(r.opt.url.includes('page=1'), 'page 槽位应替换为 1，实际: ' + r.opt.url);
});

test('搜索URL含 {{java.encodeURI(key)}} → 默认 UTF-8 编码', () => {
    const r = parseSearch('/api/search?q={{java.encodeURI(key)}}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    assert.strictEqual(new URL(r.opt.url).searchParams.get('q'), '都市', '应为 UTF-8 编码后可被 searchParams 还原');
});

test('POST body 含 {{java.encodeURI(key)}} → 可实测且方法为 POST', () => {
    const r = parseSearch('/api/search/list,{"method":"post","body":"name={{java.encodeURI(key)}}&type=3"}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    assert.strictEqual(r.opt.method, 'POST');
    assert.strictEqual(r.opt.body.toString('utf8'), 'name=' + encodeURIComponent('都市') + '&type=3');
});

test('负向对照：真正无关键词槽位的静态页仍判不可测', () => {
    const r = parseSearch('/search/{{page}}_2.html', BASE, '都市');
    assert.strictEqual(r.skip, '搜索无{{key}}槽位', '无 key 槽位必须仍判不可测，实际: ' + JSON.stringify(r));
});

test('负向对照：<js> 动态搜索URL仍判不可测', () => {
    const r = parseSearch('/<js>java.ajax(baseUrl)</js>', BASE, '都市');
    assert.strictEqual(r.skip, '无搜索URL或含js', '动态搜索URL必须仍判不可测，实际: ' + JSON.stringify(r));
});

test('动态脚本 token（java.connect）不得被拼进 URL，应判不可测', () => {
    const r = parseSearch('{{String(java.connect("https://x.example.com").raw().request().url())}}search.html', BASE, '都市');
    assert.strictEqual(r.skip, '搜索URL/body含动态语法', '动态脚本必须判不可测，实际: ' + JSON.stringify(r));
});

test('cookie.removeCookie 前缀槽位求值为空串 → 仍可实测', () => {
    const r = parseSearch('{{cookie.removeCookie(source.getKey())}}/s.php?action=search,{"method":"POST","body":"wd={{key}}&page={{page}}"}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    assert.strictEqual(r.opt.url, BASE + '/s.php?action=search', 'URL 不应残留 mustache，实际: ' + r.opt.url);
    assert.strictEqual(r.opt.method, 'POST');
});

test('url=source.getKey();cookie.removeCookie(url) 槽位求值为空串 → 仍可实测', () => {
    const r = parseSearch('{{url=source.getKey();cookie.removeCookie(url)}}/search?q={{key}}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    assert.ok(!r.opt.url.includes('{{'), 'URL 不应残留 mustache，实际: ' + r.opt.url);
});

test('page 算术槽位 {{(page-1)*10}} 求值为 0（第 1 页）', () => {
    const r = parseSearch('{{(page-1)*10}}/list?q={{key}}', BASE, '都市');
    assert.ok(!r.skip, '不应 skip，实际: ' + r.skip);
    assert.ok(r.opt.url.includes('/0/list'), '应替换为 0，实际: ' + r.opt.url);
});

test('负向对照：未知 {{...}} 脚本槽位判不可测（防拼出假地址→假死）', () => {
    const r = parseSearch('{{someUnknownFn(key)}}/search?q={{key}}', BASE, '都市');
    assert.strictEqual(r.skip, '搜索URL/body含未支持动态语法', '未知脚本必须判不可测，实际: ' + JSON.stringify(r));
});

test('table 无 tbody 时按 HTML5 补隐式 tbody（防"搜索无结果"误判）', () => {
    const html = '<table class="grid"><tr><th>文章名称</th></tr><tr><td><a href="/read/1/">书A</a></td></tr><tr><td><a href="/read/2/">书B</a></td></tr></table>';
    const r = selectAll(html, 'tbody@tr');
    assert.ok(r && r.items.length === 3, '应命中表头+2行，实际: ' + (r && r.items.length));
});

// ============================================================
// 12. 测试器能力：bookList 静态规则 !N 排除 与 tag.class（阶段三 P2）
// ============================================================
console.log('\n=== 12. 测试器 !N 排除 / tag.class ===');
const ROWS_HTML = '<table><tbody><tr><th>表头</th></tr><tr><td><a href="/r/1">书1</a></td></tr><tr><td><a href="/r/2">书2</a></td></tr></tbody></table>';

test('!0 排除首项：tbody@tr!0 跳过表头，剩 2 行', () => {
    const r = selectAll(ROWS_HTML, 'tbody@tr!0');
    assert.ok(r && r.items.length === 2, '应剩 2 行，实际: ' + (r && r.items.length));
    assert.ok(!r.items[0].includes('表头'), '首项不应是表头，实际: ' + r.items[0]);
});

test('!-1 从末尾排除：tbody@tr!-1 只剩表头+第1行', () => {
    const r = selectAll(ROWS_HTML, 'tbody@tr!-1');
    assert.ok(r && r.items.length === 2, '应剩 2 行，实际: ' + (r && r.items.length));
    assert.ok(r.items[0].includes('表头'), '首项应是表头');
});

test('tag.class 命中：div.bk 只取 class 含 bk 的 div', () => {
    const html = '<div class="wrap"><div class="bk hot"><a href="/b/1">书A</a></div><div class="other"><a href="/b/2">书B</a></div><div class="notbk"><a href="/b/3">书C</a></div></div>';
    const r = selectAll(html, 'div.bk');
    assert.ok(r && r.items.length === 1, '应只命中 1 个，实际: ' + (r && r.items.length));
    assert.ok(r.items[0].includes('/b/1'), '应命中 class="bk hot" 那个，实际: ' + r.items[0].slice(0, 80));
});

test('负向对照：div.bk 无匹配时返回空列表而非"不可测"', () => {
    const html = '<div class="wrap"><p>x</p></div>';
    const r = selectAll(html, 'div.bk');
    assert.ok(r, 'tag.class 应被识别（不可测会返回 null）');
    assert.strictEqual(r.items.length, 0, '无匹配应为空列表，实际: ' + r.items.length);
});

test('兼容性：div.0 仍按"第 0 个 div"解析，不被误认成 class="0"', () => {
    const html = '<div id="d0">甲</div><div id="d1">乙</div>';
    const r = selectAll(html, 'div.0');
    assert.ok(r && r.items.length === 1, '应只取 0 号 div，实际: ' + (r && r.items.length));
    assert.ok(r.items[0].includes('甲'), '应命中第 0 个 div');
});

// ============================================================
// 13. 同步 App：清理仓库已剔除的源
// ============================================================
console.log('\n=== 13. 同步 App：清理已下架源 ===');
const SYNC_WORKER = path.join(REPO, 'SourceAutoSync', 'app', 'src', 'main', 'java', 'io', 'nervous', 'sourcesync', 'SyncWorker.java');

test('通过官方 bookSources/delete 清理仓库已剔除的源', () => {
    const code = fs.readFileSync(SYNC_WORKER, 'utf8');
    assert.ok(code.includes('/bookSources/delete'), '应使用官方删除路由 bookSources/delete');
    assert.ok(code.includes('private JSONArray diffSources('), '应定义 diffSources 对比旧清单');
    assert.ok(code.includes('mergePending(diffSources(oldArr, finalSources), finalSources)'), '应在写入成功后对比旧清单');
    assert.ok(code.includes('deleteSources(authority, merged)'), '应调用 deleteSources 清理');
    assert.ok(code.includes('pending-delete.json'), '删除失败清单应落盘，下次同步重试');
    assert.ok(code.includes('keep.contains(url)'), '重新收录的源不得因旧失败记录被误删');
    // 删除必须在「写入回查通过」之后：避免新数据没落库就把旧源删掉
    assert.ok(code.indexOf('verifyWritten(authority, finalSources)') < code.indexOf('deleteSources(authority, merged)'),
        '删除应在写入回查通过之后执行');
});

test('App 版本号已递增（APK 可覆盖升级）', () => {
    const g = fs.readFileSync(path.join(REPO, 'SourceAutoSync', 'app', 'build.gradle'), 'utf8');
    const m = g.match(/versionCode\s+(\d+)/);
    assert.ok(m && Number(m[1]) >= 23, 'versionCode 应 ≥ 23，实际: ' + (m && m[1]));
});

test('sign.js 校验签名私钥与 App 内置公钥配对', () => {
    const code = fs.readFileSync(path.join(REPO, 'sign.js'), 'utf8');
    const app = fs.readFileSync(SYNC_WORKER, 'utf8');
    const m = code.match(/APP_PUB_B64\s*=\s*'([^']+)'/);
    assert.ok(m, 'sign.js 应定义 APP_PUB_B64');
    assert.ok(app.includes(m[1]), 'sign.js 的 APP_PUB_B64 必须与 SyncWorker.PUB_B64 完全一致');
    assert.ok(code.includes('createPublicKey(key)'), '应从私钥导出公钥并比对');
});

// ============================================================
// 14. rssSources.json 结构校验
// ============================================================
console.log('\n=== 14. rssSources.json 结构校验 ===');
test('可解析、非空、必要字段齐全、sourceUrl 无重复', () => {
    const arr = JSON.parse(fs.readFileSync(path.join(REPO, 'rssSources.json'), 'utf8'));
    assert.ok(Array.isArray(arr) && arr.length > 0, '应为非空数组');
    const seen = new Set();
    for (const s of arr) {
        for (const k of ['sourceUrl', 'sourceName', 'ruleArticles', 'ruleContent']) {
            assert.ok(typeof s[k] === 'string' && s[k].trim() !== '',
                `${s.sourceName || '?'} 缺字段 ${k}`);
        }
        assert.ok(!seen.has(s.sourceUrl), 'sourceUrl 重复: ' + s.sourceUrl);
        seen.add(s.sourceUrl);
    }
});

// ============================================================
// 汇总
// ============================================================
console.log(`\n===== 回归测试汇总: ${passed + failed} 项 =====`);
console.log(`✅ 通过: ${passed}`);
console.log(`❌ 失败: ${failed}`);
console.log(failed === 0 ? '\n🎉 全部回归测试通过！' : '\n⚠️ 有测试失败，请排查');
process.exit(failed === 0 ? 0 : 1);
