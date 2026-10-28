/**
 * official-contract.test.js — 与官方阅读 App 的「契约测试」
 *
 * 为什么要有这个文件：
 *   本仓库的成品最终是被 LegadoTeam/legado（阅读 App）消费的，接口有两处硬契约：
 *     ① ContentProvider 路由（ReaderProviderRoutes.kt）
 *     ② 书源实体字段（BookSource.kt）
 *   官方任何一个改动，我们这边要么写不进去、要么静默丢字段。靠人肉盯着上游不现实，
 *   所以每轮 CI 拉一次官方源码对一遍。
 *
 * 判定：
 *   官方删掉路由 / 删掉字段  → FAIL（我们还在用，必须跟进，否则线上静默失败）
 *   官方新增字段/路由        → WARN（不阻断，但要落到 reports/contract-warnings.txt 里提醒）
 *   拉不到官方源码（无网络）  → SKIP，exit 0（不因网络抖动挡住发布）
 */
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');

const REPO = path.join(__dirname, '..');
const RAW = 'https://raw.githubusercontent.com/LegadoTeam/legado/master/';
const FILES = {
    routes: 'app/src/main/java/io/legado/app/api/ReaderProviderRoutes.kt',
    entity: 'app/src/main/java/io/legado/app/data/entities/BookSource.kt',
};

function fetchText(url, ms) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: ms || 15000 }, (res) => {
            if (res.statusCode !== 200) { res.resume(); return resolve(null); }
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
    });
}

// 官方路由：ReaderProviderRoute("bookSources/insert", ...)
function officialRoutes(src) {
    const out = new Set();
    const re = /ReaderProviderRoute\(\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

// 官方字段：普通 var / override var
function officialFields(src) {
    const out = new Set();
    const re = /^\s+(?:override\s+)?var\s+([A-Za-z][A-Za-z0-9]*)\s*:/gm;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

// 本仓库 SyncWorker 里实际用到的路由（形如 "/bookSources/insert"）
function appRoutes() {
    const p = path.join(REPO, 'SourceAutoSync/app/src/main/java/io/nervous/sourcesync/SyncWorker.java');
    const src = fs.readFileSync(p, 'utf8');
    const out = new Set();
    const re = /"\/(bookSources?\/[a-zA-Z]+)"/g;
    let m;
    while ((m = re.exec(src))) out.add(m[1]);
    return out;
}

(async () => {
    const [routesSrc, entitySrc] = await Promise.all([
        fetchText(RAW + FILES.routes),
        fetchText(RAW + FILES.entity),
    ]);
    if (!routesSrc || !entitySrc) {
        console.log('SKIP 官方契约检查：拉不到 LegadoTeam/legado 源码（网络不可用），本轮跳过，不阻断发布');
        process.exit(0);
    }

    let failed = 0;
    const warnings = [];

    // ── ① 路由契约 ──
    const oRoutes = officialRoutes(routesSrc);
    const aRoutes = appRoutes();
    console.log('官方 Provider 路由 ' + oRoutes.size + ' 条；同步器用到 ' + aRoutes.size + ' 条');
    for (const r of aRoutes) {
        if (!oRoutes.has(r)) {
            console.error('× 路由契约破坏：同步器在用 "/' + r + '"，但官方 ReaderProviderRoutes.kt 里已经没有这条路由');
            failed++;
        } else {
            console.log('  √ /' + r);
        }
    }
    for (const r of oRoutes) {
        if (/^bookSource/.test(r) && !aRoutes.has(r)) warnings.push('官方存在但同步器未使用的书源路由：/' + r + '（需要时可接入）');
    }

    // ── ② 字段契约 ──
    const oFields = officialFields(entitySrc);
    const { OFFICIAL_FIELDS } = require(path.join(REPO, 'score.js'));
    console.log('官方 BookSource 字段 ' + oFields.size + ' 个；成品白名单 ' + OFFICIAL_FIELDS.length + ' 个');
    for (const f of OFFICIAL_FIELDS) {
        if (!oFields.has(f)) {
            console.error('× 字段契约破坏：白名单里的 "' + f + '" 在官方 BookSource.kt 中已不存在（我们会在写一个死字段）');
            failed++;
        }
    }
    for (const f of oFields) {
        if (!OFFICIAL_FIELDS.includes(f)) {
            warnings.push('官方新增书源字段："' + f + '"（未进白名单，会被裁掉；确认是否需要在 score.js 放行）');
        }
    }

    if (warnings.length) {
        fs.mkdirSync(path.join(REPO, 'reports'), { recursive: true });
        fs.writeFileSync(path.join(REPO, 'reports/contract-warnings.txt'),
            warnings.map((w) => '- ' + w).join('\n') + '\n');
        console.log('\n⚠ 警告 ' + warnings.length + ' 条（不阻断，已写入 reports/contract-warnings.txt）:');
        for (const w of warnings) console.log('  ' + w);
    }

    if (failed) {
        console.error('\n× 官方契约检查失败 ' + failed + ' 项，同步器/白名单必须跟进官方变更');
        process.exit(1);
    }
    console.log('\n√ 官方契约检查通过（路由与字段均兼容 LegadoTeam/legado@master）');
})();
