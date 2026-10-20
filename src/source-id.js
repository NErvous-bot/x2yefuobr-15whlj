// src/source-id.js — 书源身份统一规范（单一来源）
// 语义（9 个文件共享，不可随意改）：
//   - 去掉 #fragment（同 URL 下的规则变体用 fragment 区分，健康追踪按 URL 键归并）
//   - 去掉 pathname 尾部斜杠（//example.com/ 和 //example.com 视为同一源）
//   - 保留 protocol://host:port + pathname 主体（query 参数本就被去掉）
//   - 无效 URL → null（返回 null 的调用方必须自己处理 null 分支，不可信任）
// 对应成品层（canonicalizeUrl 在 filter.js 里）的不同职责：
//   - norm() = 身份键（跨轮追踪、健康聚合、熔断裁决的唯一 Key）
//   - canonicalizeUrl() = 成品 URL 格式统一（保留 fragment，仅白名单 query 和根路径多斜杠）
//   - 两者故意不同：身份键要"最窄收敛"（便于追踪），成品 URL 要"最宽保留"（避免误合并）

function norm(u) {
    try {
        const x = new URL(String(u).trim().split('#')[0]);
        return x.origin + x.pathname.replace(/\/$/, '');
    } catch (e) { return null; }
}

// 派生函数（减少各文件里的自定义）
function originOf(u) {
    try { return new URL(String(u).split('#')[0]).origin; }
    catch (e) { return null; }
}

module.exports = { norm, originOf };
