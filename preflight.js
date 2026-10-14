// preflight.js - 升级预演：跑 filter.js 但不真写 legado.json
// 用途：上传新 filter.js 前，先本地跑一遍看看预期效果（剔除/新增/阈值）
// 用法：node preflight.js

const fs = require('fs');
const { execSync } = require('child_process');

const FILE = 'legado.json';
const BACKUP = 'legado.backup.json';

// 备份原文件
if (!fs.existsSync(FILE)) {
    console.log('❌ 找不到 ' + FILE);
    process.exit(1);
}
fs.copyFileSync(FILE, BACKUP);
const beforeSize = fs.statSync(FILE).size;
const beforeList = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const beforeCount = beforeList.length;

console.log('===== 升级预演 =====');
console.log('原源数: ' + beforeCount + ' / 大小: ' + (beforeSize / 1024).toFixed(1) + 'KB');
console.log('');

let runOk = true;
let stdout = '';

try {
    // 跑 filter.js（捕获输出；候选实测会增加探测量，超时放宽到15分钟）
    stdout = execSync('node filter.js', { encoding: 'utf8', timeout: 900000 });
    console.log(stdout);
} catch (e) {
    runOk = false;
    console.log('❌ filter.js 报错:');
    console.log(e.stdout || e.message);
} finally {
    // 检查 legado.json 是否被改
    const afterList = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const afterCount = afterList.length;

    console.log('');
    console.log('===== 预演报告 =====');
    console.log('原源数: ' + beforeCount);
    console.log('新源数: ' + afterCount);
    const diff = afterCount - beforeCount;
    console.log('变化: ' + (diff >= 0 ? '+' : '') + diff);

    if (runOk) {
        // 真实剔除数：从 filter.js stdout 解析（首尾差会被"同时剔+增"稀释）
        // 新日志格式：剔除 X+Y（探活+老化）
        const m = stdout.match(/剔除\s+(\d+)\+(\d+)/);
        const probeRemoved = m ? parseInt(m[1], 10) : 0;
        const agedRemoved = m ? parseInt(m[2], 10) : 0;
        const removed = probeRemoved + agedRemoved;
        const removedRate = beforeCount > 0 ? (removed / beforeCount * 100) : 0;
        console.log('剔除率: ' + removedRate.toFixed(1) + '%（探活 ' + probeRemoved + ' + 老化 ' + agedRemoved + '，按真实剔除数算，非首尾差）');
        if (agedRemoved > 0) {
            console.log('（老化剔除分批进行：每轮上限 8%，剩余 ' + agedRemoved + ' 个本轮已清）');
        }

        if (removedRate > 30) {
            console.log('');
            console.log('⚠️ 警告：剔除率超过 30%，会被 filter.js 的阈值保护拦截！');
            console.log('   上传到 GitHub 后，Actions 跑出来会是「无变化」效果。');
        } else {
            console.log('');
            console.log('✓ 剔除率 < 30%，上传后能正常生效');
        }
    } else {
        console.log('');
        console.log('⚠️ filter.js 运行报错，预演结果不可靠');
    }

    // 恢复原文件
    fs.copyFileSync(BACKUP, FILE);
    fs.unlinkSync(BACKUP);
    console.log('');
    console.log('✓ legado.json 已恢复原状（预演不修改真实文件）');
}
