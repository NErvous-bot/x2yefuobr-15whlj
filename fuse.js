// fuse.js — 发布保险丝（V2）：三道闸门全过才放行发布，BLOCKED 时回滚成品、只提交诊断报告
//   ① 回归闸门：旧可用 → 新确认坏 → 交给 recheck-regression.js 复查裁决（5次实测），仅"稳定死亡"才 BLOCKED
//              （FLAPPING/疑似/死因混杂/复查全过/规则不可测 → 不阻塞，只留观察）
//   ② 总量熔断：legado.json 源数骤降 >5%（398→370 拦，398→397 放）→ BLOCKED
//   ③ 可用熔断：健康报告可用数骤降 >10% → BLOCKED
// 保险丝自身异常时 fail-open（放行并标注异常），避免脚本 bug 长期卡死自动发布；
// 首次运行无基线报告时直接放行。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const { execSync, spawnSync } = require('child_process');

const TOTAL_DROP_MAX = 0.05;  // 总源数降幅阈值
const AVAIL_DROP_MAX = 0.10;  // 可用数降幅阈值

const gitShow = f => execSync(`git show HEAD:${f}`, { maxBuffer: 64e6 }).toString();
const pct = (a, b) => !a ? '—' : '(' + (b >= a ? '+' : '') + (Math.round((b - a) / a * 1000) / 10) + '%)';

// 源状态口径与 recheck-regression.js 一致：health=null → untestable，content=true → available
const stOf = v => (v.health === null || v.health === undefined) ? 'untestable' : v.content ? 'available' : 'broken';

const VERDICT_CN = {
    REAL_DEATH_CANDIDATE: '稳定死亡',
    NET_UNREACHABLE: '网络不可达(不判死,下轮观察)',
    FLAPPING: '抖动',
    SUSPECT: '疑似(部分成功)',
    MIXED_DEATH: '死因混杂',
    RECOVERED: '复查全过',
    UNTESTABLE_RULE: '规则不可测(豁免)',
    UNTESTED: '预算内未测完'
};

try {
    const head = execSync('git rev-parse --short HEAD').toString().trim();
    let oldHealth, oldTotal;
    try {
        oldHealth = JSON.parse(gitShow('health/source_health.json'));
        oldTotal = JSON.parse(gitShow('legado.json')).length;
    } catch (e) {
        console.log('发布保险丝: HEAD 无基线报告（首次运行），跳过判定直接放行');
        process.exit(0);
    }
    const newHealth = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8'));
    const newTotal = JSON.parse(fs.readFileSync('legado.json', 'utf8')).length;

    const L = [];
    L.push('━━━━━━━━━━━━━━━━━━━━ 发布保险丝 ━━━━━━━━━━━━━━━━━━━━');
    L.push('基线 ' + head + ' 上一轮报告 vs 本轮报告');
    const oldUsable = oldHealth.summary.usable || 0, newUsable = newHealth.summary.usable || 0;
    L.push('总源数   ' + oldTotal + ' → ' + newTotal + ' ' + pct(oldTotal, newTotal));
    L.push('可用数   ' + oldUsable + ' → ' + newUsable + ' ' + pct(oldUsable, newUsable));
    const flapN = Object.values(newHealth.sources || {}).filter(v => v.flapping).length;
    L.push('FLAPPING 观察期 ' + flapN + ' 个');

    // ① 回归闸门：旧可用 → 新确认坏（removed 不算，由总量熔断兜底）
    const availToBad = [];
    for (const [k, ov] of Object.entries(oldHealth.sources || {})) {
        const nv = (newHealth.sources || {})[k];
        if (stOf(ov) === 'available' && nv && stOf(nv) === 'broken')
            availToBad.push(String(nv.name || k).slice(0, 20));
    }
    L.push('');
    L.push('旧可用 → 确认坏  ' + availToBad.length + ' 个' +
        (availToBad.length ? '（' + availToBad.slice(0, 8).join('、') + (availToBad.length > 8 ? ' 等' + availToBad.length + '个' : '') + '）' : ''));

    let realDeath = 0;
    const verdictCnt = {};
    if (availToBad.length) {
        // 复查裁决：复用 recheck-regression.js（保险丝模式跳过二级实测省预算）
        const r = spawnSync('node', ['recheck-regression.js', 'HEAD'],
            { stdio: 'inherit', env: { ...process.env, RECHECK_T2: '0' }, timeout: 20 * 60000 });
        if (r.status !== 0) L.push('（复查脚本异常退出 ' + r.status + '，按保守放行处理，见上方日志）');
        try {
            const rep = JSON.parse(fs.readFileSync('reports/recheck-report.json', 'utf8'));
            for (const j of rep.tier1 || []) {
                const v = j.verdict || 'UNTESTED';
                verdictCnt[v] = (verdictCnt[v] || 0) + 1;
                if (v === 'REAL_DEATH_CANDIDATE') realDeath++;
            }
        } catch (e) { L.push('（复查报告读取失败: ' + e.message + '）'); }
        if (Object.keys(verdictCnt).length) {
            L.push('复查裁决:');
            for (const [v, n] of Object.entries(verdictCnt).sort((a, b) => b[1] - a[1]))
                L.push('  ├─ ' + (VERDICT_CN[v] || v) + '  ' + n);
        }
    }

    // ② ③ 数量熔断
    const totalDrop = oldTotal ? (oldTotal - newTotal) / oldTotal : 0;
    const availDrop = oldUsable ? (oldUsable - newUsable) / oldUsable : 0;
    const reasons = [];
    if (realDeath > 0) reasons.push('存在 ' + realDeath + ' 个旧可用→稳定死亡（须人工确认站点真死或定位测试器）');
    if (totalDrop > TOTAL_DROP_MAX) reasons.push('总源数骤降 ' + (Math.round(totalDrop * 1000) / 10) + '%（>' + TOTAL_DROP_MAX * 100 + '%，疑似批量误删/环境异常）');
    if (availDrop > AVAIL_DROP_MAX) reasons.push('可用数骤降 ' + (Math.round(availDrop * 1000) / 10) + '%（>' + AVAIL_DROP_MAX * 100 + '%，疑似测试器/网络环境异常）');

    L.push('');
    L.push('━━ 发布状态：' + (reasons.length ? 'BLOCKED' : 'PASS') + ' ━━');
    for (const r of reasons) L.push('原因：' + r);
    if (reasons.length) {
        // 回滚成品到 HEAD：手机端书源/规则/签名保持上一版，仅提交诊断报告
        let rolled = 0;
        for (const f of ['legado.json', 'legado.json.sig', 'replaceRule.json', 'replaceRule.json.sig', 'version.txt']) {
            try { execSync(`git checkout HEAD -- ${f}`); rolled++; } catch (e) {}
        }
        L.push('已回滚成品 ' + rolled + ' 个文件至上一版，手机端书源不变；本轮仅提交健康报告与诊断报告（reports/）');
    }
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const txt = L.join('\n');
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/fuse-summary.txt', txt);
    console.log(txt);
    process.exit(0);
} catch (e) {
    // fail-open：保险丝自身异常不卡死发布，但日志必须可见
    console.log('发布保险丝异常(不影响主流程，按放行处理): ' + e.message);
    process.exit(0);
}
