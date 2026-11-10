#!/usr/bin/env node
/**
 * build-public-subset.js — 从全量成品生成「可公开再分发」子集
 *
 * 背景（2026-11-10）：
 *   仓库是 public，而 legado.json 是历史累计产物，混入了无 LICENSE 文件上游
 *   （tickmao/Novel、aoaostar/legado）并入的条目。NOTICE 已如实记录这个遗留。
 *   但「记录风险」不等于「消除风险」——公开仓库每多放一天，就多一天再分发事实。
 *
 *   同时不能一刀切删源：本人日常要用全量。所以拆成两份：
 *     · legado.json            —— 全量，手机同步实际消费（保持现状）
 *     · dist/legado-public.json —— 仅保留「授权可追溯」的源，供公开分发
 *
 * 判定口径（保守，宁可少放）：
 *   1) reports/source-provenance.json 命中且 license=NONE 的上游 → 剔除
 *   2) 未在上游清单里的源（自有策展 / extra-sources）→ 保留
 *      （这是我们自己的整理成果，不属于他人再分发）
 *   3) 无法溯源但存在于 quarantine.json 的 → 已隔离，本来就不进成品
 *
 * 用法：
 *   node build-public-subset.js            # 生成 dist/legado-public.json + 报告
 *   node build-public-subset.js --check    # 只报告，不写文件（CI 用）
 *
 * 退出码：始终 0（这是分发辅助，不阻断生产）；--check 模式下若发现
 *         公开子集里仍残留无授权源，退出码 1。
 */
const fs = require('fs');
const path = require('path');

const REPO = __dirname;
const LEGADO = path.join(REPO, 'legado.json');
const PROV = path.join(REPO, 'reports', 'source-provenance.json');
const OUT_DIR = path.join(REPO, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'legado-public.json');
const OUT_REPORT = path.join(REPO, 'reports', 'public-subset.json');

const CHECK_ONLY = process.argv.includes('--check');

const { norm } = require(path.join(REPO, 'src', 'source-id'));

function main() {
    if (!fs.existsSync(LEGADO)) {
        console.error('× 找不到 legado.json');
        process.exit(1);
    }
    const all = JSON.parse(fs.readFileSync(LEGADO, 'utf8'));

    let prov = { byUrl: {} };
    if (fs.existsSync(PROV)) {
        try { prov = JSON.parse(fs.readFileSync(PROV, 'utf8')); }
        catch (e) { console.warn('⚠️ source-provenance.json 解析失败，按「全部保留」处理（保守即不误删）'); }
    } else {
        console.warn('⚠️ 缺少 reports/source-provenance.json（先跑一次 filter.js），本次不剔除任何源');
    }

    const keep = [];
    const drop = [];
    const byUpstream = {};

    for (const s of all) {
        const k = norm(s.bookSourceUrl);
        const hit = prov.byUrl && prov.byUrl[k];
        // 只有「命中且明确属于无授权上游」才剔除。
        // 命中但有许可证（MPL/GPL）→ 保留（GPL 系可再分发，保留署名即可）。
        if (hit && hit.publicPublish === false) {
            drop.push({ name: s.bookSourceName, url: s.bookSourceUrl, upstream: hit.id, license: hit.license });
            byUpstream[hit.id] = (byUpstream[hit.id] || 0) + 1;
        } else {
            keep.push(s);
        }
    }

    const report = {
        generatedAt: Date.now(),
        totalSources: all.length,
        publicSources: keep.length,
        removed: drop.length,
        removedRatio: all.length ? Math.round(drop.length / all.length * 1000) / 10 : 0,
        byUpstream,
        note: 'publicSources = 可在公开仓库再分发的子集；legado.json 仍为全量（个人使用）',
        removedSample: drop.slice(0, 20),
    };

    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_REPORT, JSON.stringify(report, null, 1));

    console.log('━━━━ 公开子集构建 ━━━━');
    console.log('全量源     ' + all.length);
    console.log('可公开     ' + keep.length + '（' + (100 - report.removedRatio) + '%）');
    console.log('剔除       ' + drop.length + '（' + report.removedRatio + '%）');
    for (const [k, v] of Object.entries(byUpstream)) {
        console.log('  · ' + k + '  ' + v + ' 个');
    }
    console.log('报告       reports/public-subset.json');

    if (CHECK_ONLY) {
        // CI 口径：公开子集里不该再有 publicPublish=false 的源
        const leaked = keep.filter((s) => {
            const k = norm(s.bookSourceUrl);
            const hit = prov.byUrl && prov.byUrl[k];
            return hit && hit.publicPublish === false;
        });
        if (leaked.length) {
            console.error('× 公开子集仍残留无授权源 ' + leaked.length + ' 个（判定逻辑有 bug）');
            process.exit(1);
        }
        console.log('✅ 公开子集校验通过（无授权源 0 个残留）');
        return;
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify(keep, null, 1));
    console.log('已写入     dist/legado-public.json（' + keep.length + ' 个源）');
}

main();
