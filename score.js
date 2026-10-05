// score.js — V3 源评分分层+自动排序（体验优化层，不改变检测/删除/保险丝逻辑）
// 读取 health/source_health.json 的实测结果 → 计算健康分 → 核心/稳定/备用/观察分层
// → 覆写每源 weight 并按权重降序重排 legado.json，手机端搜索结果优质源自动排前
// 评分（100分）：搜索20 + 目录25 + 正文25 + 稳定性20 + 最近连续成功10
//   稳定性：recent≥2个样本时按窗口成功率×20，否则中性12；连续失败1次-5、2次-15、≥3次强制观察层
// 分层：≥90核心(weight500~900) / 75~89稳定(300~490) / 60~74备用(150~290) / <60观察(50)
//       连续失败≥3→观察(30) / 不可测保护池(40,不评分不判死) / 确认坏(5,待老化剔除)
// 保底：番茄源固定 weight=9999 排最前（固定核心源 > 健康评分排序 > 备用源）
// 历史记录复用 health.json 的 recent 数组（最近5次有结论实测），不另建文件避免状态漂移
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const fs = require('fs');

const norm = u => { try { const x = new URL(String(u).split('#')[0]); return x.origin + x.pathname.replace(/\/$/, ''); } catch (e) { return null; } };
const isFanqie = s => /番茄|fanqie|changdunovel/i.test(String(s.bookSourceName || '') + ' ' + String(s.bookSourceUrl || ''));

// 最近 N 次结果 → 末尾连续 pass / fail 计数
const consOf = (recent, tag) => { let n = 0; for (let i = recent.length - 1; i >= 0 && recent[i] === tag; i--) n++; return n; };

function grade(v) {
    // v: health.json 源条目 → { score, layer, weight }
    if (!v || v.health === null || v.health === undefined) return { score: null, layer: 'untestable', weight: 40 };
    const recent = Array.isArray(v.recent) ? v.recent : [];
    if (v.content === false) return { score: v.health, layer: 'dead', weight: 5 }; // 确认坏：等探活/老化层处理
    const base = (v.search ? 20 : 0) + (v.toc ? 25 : 0) + (v.content ? 25 : 0);
    const consFail = consOf(recent, 'fail');
    let stab = recent.length < 2 ? 12 : Math.round(recent.filter(x => x === 'pass').length / recent.length * 20);
    if (consFail === 1) stab -= 5; else if (consFail === 2) stab -= 15;
    const consPass = consOf(recent, 'pass');
    const streak = consPass >= 3 ? 10 : consPass === 2 ? 7 : consPass === 1 ? 4 : 0;
    const score = Math.max(0, Math.min(100, base + stab + streak));
    if (consFail >= 3) return { score, layer: 'watch', weight: 30 };
    if (score >= 90) return { score, layer: 'core', weight: Math.round(500 + (score - 90) * 20) };
    if (score >= 75) return { score, layer: 'stable', weight: Math.round(300 + (score - 75) * 12) };
    if (score >= 60) return { score, layer: 'backup', weight: Math.round(150 + (score - 60) * 9) };
    return { score, layer: 'watch', weight: 50 };
}

try {
    const list = JSON.parse(fs.readFileSync('legado.json', 'utf8'));
    const H = JSON.parse(fs.readFileSync('health/source_health.json', 'utf8')).sources || {};

    const layers = { core: [], stable: [], backup: [], watch: [], untestable: [], dead: [] };
    for (const s of list) {
        const k = norm(s.bookSourceUrl);
        const hv = H[k];
        // 番茄保底：仅"可实测且确认坏"（health非null且content=false）才取消9999，防坏源占首位；
        // 不可测（health=null）说明是WebView/js规则测不出，不代表坏，保留保底
        const fanqieDead = hv && hv.health !== null && hv.health !== undefined && hv.content === false;
        if (isFanqie(s) && !fanqieDead) {
            s.weight = 9999;
            layers.core.unshift({ name: String(s.bookSourceName || '').slice(0, 16), score: hv ? hv.health : null, layer: 'fanqie', weight: 9999 });
            continue;
        }
        const g = grade(hv);
        s.weight = g.weight;
        (layers[g.layer] || layers.watch).push({ name: String(s.bookSourceName || '').slice(0, 16), score: g.score, layer: g.layer, weight: g.weight, url: k });
    }

    // 按权重降序重排（番茄9999自然置顶）
    list.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    fs.writeFileSync('legado.json', JSON.stringify(list));

    // 评分明细留档
    const flat = Object.values(layers).flat();
    fs.mkdirSync('reports', { recursive: true });
    fs.writeFileSync('reports/source_scores.json', JSON.stringify({ generatedAt: Date.now(), layers: { core: layers.core, stable: layers.stable, backup: layers.backup, watch: layers.watch, untestable: layers.untestable, dead: layers.dead }, total: flat.length }, null, 1));

    // 中文摘要表
    const L = [];
    L.push('━━━━━━━━━━━━━━━━━━━━ 源评分分层 ━━━━━━━━━━━━━━━━━━━━');
    L.push('核心源  ' + layers.core.length + ' 个（≥90分+番茄保底9999）');
    for (const x of layers.core.slice(0, 10).sort((a, b) => b.weight - a.weight))
        L.push('  ' + String(x.weight).padStart(5) + '  ' + x.name + (x.score !== null && x.score !== undefined ? '  ' + x.score + '分' : ''));
    if (layers.core.length > 10) L.push('  ...等 ' + layers.core.length + ' 个');
    L.push('稳定源  ' + layers.stable.length + ' 个（75~89分，weight 300~490）');
    L.push('备用源  ' + layers.backup.length + ' 个（60~74分，weight 150~290）');
    L.push('观察    ' + layers.watch.length + ' 个（<60分或连续失败，weight 30~50）');
    L.push('不可测保护池  ' + layers.untestable.length + ' 个（不评分不判死，weight 40）');
    L.push('确认坏  ' + layers.dead.length + ' 个（weight 5，待探活/老化层剔除）');
    L.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(L.join('\n'));
    process.exit(0);
} catch (e) {
    console.log('源评分异常(不影响主流程，保持原顺序): ' + e.message);
    process.exit(0);
}
