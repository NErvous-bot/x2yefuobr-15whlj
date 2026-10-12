// fuse.js — 发布保险丝（V3）：三道闸门全过才放行发布，BLOCKED 时回滚成品、只提交诊断报告
//   ① 回归闸门：旧可用 → 新确认坏 → 交给 recheck-regression.js 复查裁决（5次实测）
//              · REAL_DEATH_CANDIDATE 且旧报告 flapping=false（无跨轮抖动前科）→ 阻断（P1 硬回归）
//              · REAL_DEATH_CANDIDATE 但旧报告 flapping=true（系统早知该源时好时坏）→ 降级观察，
//                不冻结整轮发布；源留库由 score.js 降权，下轮继续实测（3-strike 落地前的过渡策略）
//              · FLAPPING/SUSPECT/MIXED/RECOVERED/NET_UNREACHABLE/UNTESTABLE → 本就不阻断
//   ② 总量熔断：legado.json 源数骤降 >5%（398→370 拦，398→397 放）→ 阻断
//   ③ 可用熔断：健康报告可用数骤降 >10% → 阻断；但要求探测覆盖率 ≥60%，
//              且优先按「两轮共同实测源」同口径比较（carried 沿用源不计），
//              覆盖率不足或测量口径不可比 → 降级为观察，不阻断（不把测量误差当退化）
// 回滚安全性（V3 加固）：
//   · 逐文件先验 HEAD 中存在（cat-file -e），checkout 失败或回滚后 sha256 与 HEAD 不一致
//     → 直接 exit 1 让 CI 红灯（旧版空 catch 会把 BLOCKED 静默变成发布）
//   · 复查脚本异常 / 复查报告损坏 → exit 1（无法可信裁决时不放行）
//   · 仅「HEAD 无基线（首次运行）」保留 fail-open；保险丝其余任何异常 fail-closed
// 首次运行无基线报告时直接放行。
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const TOTAL_DROP_MAX = 0.05;  // 总源数降幅阈值
const AVAIL_DROP_MAX = 0.10;  // 可用数降幅阈值
const COVERAGE_MIN = 0.60;    // 闸门③最低探测覆盖率（实测源/总源），低于则熔断降级为观察
const COMMON_MIN = 30;        // 共同实测口径最小样本，不足则回退历史 summary 口径
const ROLLBACK_FILES = ['legado.json', 'legado.json.sig', 'replaceRule.json', 'replaceRule.json.sig', 'version.txt'];

const gitShow = f => execSync(`git show HEAD:${f}`, { maxBuffer: 64e6 });
const pct = (a, b) => !a ? '—' : '(' + (b >= a ? '+' : '') + (Math.round((b - a) / a * 1000) / 10) + '%)';
const norm = u => { try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); } catch (e) { return null; } };
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// 源状态口径与 recheck-regression.js 一致：health=null → untestable，content=true → available
const stOf = v => (v.health === null || v.health === undefined) ? 'untestable' : v.content ? 'available' : 'broken';

// 本轮真正实测过的源：checkedAt 等于报告 updatedAt（carried 沿用源时间戳是旧的，自然排除）
function testedSetOf(h) {
    const t = Number(h.updatedAt || (h.summary || {}).updatedAt);
    const s = new Set();
    for (const [k, v] of Object.entries(h.sources || {})) if (Number(v.checkedAt) === t) s.add(k);
    return s;
}

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

const head = execSync('git rev-parse --short HEAD').toString().trim();
let oldHealth, oldTotal;
try {
    oldHealth = JSON.parse(gitShow('health/source_health.json').toString());
    oldTotal = JSON.parse(gitShow('legado.json').toString()).length;
} catch (e) {
    // 唯一保留的 fail-open：首次运行没有可比基线
    console.log('发布保险丝: HEAD 无基线报告（首次运行），跳过判定直接放行');
    process.exit(0);
}

try {
    const newHealth = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8'));
    const newTotal = JSON.parse(fs.readFileSync('legado.json', 'utf8')).length;

    const L = [], W = [];  // L=裁决日志，W=观察项（不阻断）
    L.push('━━━━━━━━━━━━━━━━━━━━ 发布保险丝 V3 ━━━━━━━━━━━━━━━━━━━━');
    L.push('基线 ' + head + ' 上一轮报告 vs 本轮报告');
    const oldUsable = oldHealth.summary.usable || 0, newUsable = newHealth.summary.usable || 0;
    L.push('总源数   ' + oldTotal + ' → ' + newTotal + ' ' + pct(oldTotal, newTotal));
    L.push('可用数   ' + oldUsable + ' → ' + newUsable + ' ' + pct(oldUsable, newUsable));

    // 探测覆盖率与同口径集合（闸门③置信度）
    const oldTested = testedSetOf(oldHealth), newTested = testedSetOf(newHealth);
    const covOld = oldTotal ? oldTested.size / oldTotal : 1, covNew = newTotal ? newTested.size / newTotal : 1;
    L.push('探测覆盖率 ' + Math.round(covOld * 100) + '% → ' + Math.round(covNew * 100) + '%（实测 ' +
        oldTested.size + '/' + oldTotal + ' → ' + newTested.size + '/' + newTotal + '）');
    const flapN = Object.values(newHealth.sources || {}).filter(v => v.flapping).length;
    L.push('FLAPPING 观察期 ' + flapN + ' 个');

    // ① 回归闸门：旧可用 → 新确认坏（removed 不算，由总量熔断兜底）
    const availToBad = [];
    for (const [k, ov] of Object.entries(oldHealth.sources || {})) {
        const nv = (newHealth.sources || {})[k];
        if (stOf(ov) === 'available' && nv && stOf(nv) === 'broken')
            availToBad.push({ k, name: String(nv.name || k).slice(0, 20) });
    }
    L.push('');
    L.push('旧可用 → 确认坏  ' + availToBad.length + ' 个' +
        (availToBad.length ? '（' + availToBad.slice(0, 8).map(x => x.name).join('、') +
            (availToBad.length > 8 ? ' 等' + availToBad.length + '个' : '') + '）' : ''));

    let hardDeath = 0, flapDeath = 0;
    const verdictCnt = {};
    if (availToBad.length) {
        // 复查裁决：复用 recheck-regression.js（保险丝模式跳过二级实测省预算）
        const r = spawnSync('node', ['recheck-regression.js', 'HEAD'],
            { stdio: 'inherit', env: { ...process.env, RECHECK_T2: '0' }, timeout: 20 * 60000 });
        // V3：复查基础设施故障属于「无法可信裁决」→ fail-closed（旧版是悄悄放行）
        if (r.error) throw new Error('复查脚本启动失败: ' + r.error.message);
        if (r.status !== 0) throw new Error('复查脚本异常退出 ' + r.status + '，无法可信裁决，本轮拒绝发布');
        let rep;
        try { rep = JSON.parse(fs.readFileSync('reports/recheck-report.json', 'utf8')); }
        catch (e) { throw new Error('复查报告读取失败: ' + e.message); }
        const flapNames = [], hardNames = [];
        for (const j of rep.tier1 || []) {
            const v = j.verdict || 'UNTESTED';
            verdictCnt[v] = (verdictCnt[v] || 0) + 1;
            if (v === 'REAL_DEATH_CANDIDATE') {
                const k = norm(j.url);
                const wasFlap = k && (oldHealth.sources[k] || {}).flapping === true;
                if (wasFlap) { flapDeath++; flapNames.push(String(j.name || k).slice(0, 20)); }
                else { hardDeath++; hardNames.push(String(j.name || k).slice(0, 20)); }
            }
        }
        if (Object.keys(verdictCnt).length) {
            L.push('复查裁决:');
            for (const [v, n] of Object.entries(verdictCnt).sort((a, b) => b[1] - a[1]))
                L.push('  ├─ ' + (VERDICT_CN[v] || v) + '  ' + n);
        }
        if (hardNames.length) L.push('  ├─ 稳定死亡·硬回归（无抖动前科）: ' + hardNames.join('、'));
        if (flapNames.length) W.push('闸门① 降级观察：' + flapDeath + ' 个跨轮抖动源复查 5/5 失败（' +
            flapNames.join('、') + '），旧报告已标 flapping；不冻结发布，源留库降权，下轮继续观察');
    }

    // ② 总量熔断（硬阻断；删除原因归因待 filter 层产出删除清单后再细化）
    const totalDrop = oldTotal ? (oldTotal - newTotal) / oldTotal : 0;
    // ③ 可用熔断：覆盖率门 + 两轮共同实测源同口径
    let availDrop = oldUsable ? (oldUsable - newUsable) / oldUsable : 0;
    let dropBasis = 'summary 口径（两轮实测覆盖率均为100%，口径可比）';
    const covOk = covOld >= COVERAGE_MIN && covNew >= COVERAGE_MIN;
    if (!covOk) {
        W.push('闸门③ 降级观察：探测覆盖率 ' + Math.round(covOld * 100) + '%→' + Math.round(covNew * 100) +
            '%，低于 ' + COVERAGE_MIN * 100 + '% 门限，可用数变化可能是测量误差而非真实退化，本轮不阻断');
    } else {
        const common = [...oldTested].filter(k => newTested.has(k));
        const cOld = common.filter(k => stOf(oldHealth.sources[k]) === 'available').length;
        const cNew = common.filter(k => stOf(newHealth.sources[k]) === 'available').length;
        if (cOld >= COMMON_MIN) {
            availDrop = (cOld - cNew) / cOld;
            dropBasis = '共同实测口径（两轮均实测的 ' + common.length + ' 个源中，可用 ' + cOld + '→' + cNew + '）';
        } else {
            dropBasis = 'summary 口径（共同实测样本 ' + cOld + ' < ' + COMMON_MIN + '，回退总量比较）';
        }
    }

    const reasons = [];
    if (hardDeath > 0) reasons.push('存在 ' + hardDeath + ' 个旧可用→稳定死亡的硬回归（无跨轮抖动前科，须人工确认站点真死或定位测试器）');
    if (totalDrop > TOTAL_DROP_MAX) reasons.push('总源数骤降 ' + (Math.round(totalDrop * 1000) / 10) + '%（>' + TOTAL_DROP_MAX * 100 + '%，疑似批量误删/环境异常）');
    if (covOk && availDrop > AVAIL_DROP_MAX) reasons.push('可用数骤降 ' + (Math.round(availDrop * 1000) / 10) + '%（>' + AVAIL_DROP_MAX * 100 + '%，' + dropBasis + '）');

    L.push('');
    L.push('闸门③ 比对基准：' + dropBasis);
    L.push('━━ 发布状态：' + (reasons.length ? 'BLOCKED' : 'PASS') + ' ━━');
    for (const r of reasons) L.push('阻断原因：' + r);
    for (const w of W) L.push('观察项(不阻断)：' + w);
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // 诊断报告先落盘（即使随后回滚失败 CI 红灯，reports 仍保留本轮证据；commit 步骤在 fuse 之后）
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/fuse-summary.txt', L.join('\n'));
    console.log(L.join('\n'));

    if (reasons.length) {
        // 回滚成品到 HEAD：手机端书源/规则/签名保持上一版，仅提交诊断报告
        // V3：任何一步失败都硬失败——旧版空 catch 会在 checkout 失败时把候选新内容当正式版发布
        for (const f of ROLLBACK_FILES) {
            execSync(`git cat-file -e HEAD:${f}`, { stdio: 'pipe' });   // HEAD 中必须存在
            execSync(`git checkout HEAD -- ${f}`);
            const ws = sha256(fs.readFileSync(f)), hs = sha256(gitShow(f));
            if (ws !== hs) throw new Error('回滚后哈希与基线不一致: ' + f + '（工作区 ' + ws.slice(0, 8) + ' / HEAD ' + hs.slice(0, 8) + '）');
        }
        console.log('发布保险丝: 已回滚 ' + ROLLBACK_FILES.length + ' 个成品并逐一哈希校验通过，手机端书源不变；本轮仅提交健康报告与诊断报告（reports/）');
    }
    process.exit(0);
} catch (e) {
    // V3 fail-closed：判定/回滚阶段任何异常都拒绝发布（CI 红灯），杜绝候选版本被静默放行
    console.error('× 发布保险丝故障(拒绝发布): ' + (e.stack || e.message));
    try {
        fs.mkdirSync('reports', { recursive: true });
        fs.appendFileSync('reports/fuse-summary.txt', '\n[FUSE FAILURE] ' + new Date().toISOString() + ' ' + e.message + '\n');
    } catch (_) {}
    process.exit(1);
}
