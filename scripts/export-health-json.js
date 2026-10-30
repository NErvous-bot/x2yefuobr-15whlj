// scripts/export-health-json.js —— 把本轮健康判定收口成一份纯 JSON
//
// 用途：js-eval.yml（低权限隔离 job）跑完 health.js 后，把结果导出成
// js-eval-result.json，供生产 job（update.yml）消费。
//
// 设计约束（安全边界的一部分）：
//   · 只输出 JSON 字符串/数字/布尔，绝不输出函数、路径、堆栈
//   · 字段集合固定，生产侧会再校验一次 keys，防止被注入额外字段
//   · url 字段做长度截断，避免异常长大对象撑爆产物
//   · 若 health 报告缺失或损坏，明确失败而不是输出空壳（fail-closed）

'use strict';

const fs = require('fs');
const path = require('path');

const HEALTH = 'health/source_health.json';
const OUT = 'js-eval-result.json';
const MAX_URL_LEN = 2048;
const MAX_ROWS = 2000;

function safeState(v) {
    if (v === null || v === undefined) return 'untestable';
    if (v.content === true) return 'available';
    if (v.content === false) return 'broken';
    return 'untestable';
}

function safeString(x, max) {
    const s = typeof x === 'string' ? x : String(x === undefined ? '' : x);
    return s.length > max ? s.slice(0, max) : s;
}

function main() {
    if (!fs.existsSync(HEALTH)) {
        console.error('export: ' + HEALTH + ' 不存在，拒绝产出空壳结果');
        process.exit(1);
    }
    let report;
    try {
        report = JSON.parse(fs.readFileSync(HEALTH, 'utf8'));
    } catch (e) {
        console.error('export: ' + HEALTH + ' 解析失败: ' + e.message);
        process.exit(1);
    }
    const sources = report && report.sources ? report.sources : {};
    const keys = Object.keys(sources);
    if (keys.length === 0) {
        console.error('export: sources 为空，拒绝产出空壳结果');
        process.exit(1);
    }

    const rows = [];
    for (const k of keys.slice(0, MAX_ROWS)) {
        const v = sources[k] || {};
        rows.push({
            url: safeString(k, MAX_URL_LEN),
            state: safeState(v),
            health: typeof v.health === 'number' ? v.health : null,
            note: safeString(v.note === undefined ? '' : v.note, 200),
        });
    }

    // 固定字段集合，不接受 report 里的其它内容透传
    const payload = {
        version: 1,
        generatedAt: typeof report.updatedAt === 'number' ? report.updatedAt : Date.now(),
        results: rows,
    };

    fs.writeFileSync(OUT, JSON.stringify(payload) + '\n');
    console.log('export: 写入 ' + OUT + '（' + rows.length + ' 行）');
}

main();
