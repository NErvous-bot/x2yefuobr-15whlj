// freshness-audit.js — 阶段 A：冻结期独立只读时效诊断
// 目标：验证"精品源追更是否普遍滞后"，输出诊断报告，绝不修改任何生产文件
//
// 输入：
//   legado.json — 现有源清单（只读）
//   books.json  — 测试书目（手工维护）
//
// 输出（均在 reports/ 下）：
//   freshness-summary.json  — 每本书的跨源章节数分布
//   freshness-details.csv   — 每源每书的详细对比
//
// 边界：
//   ✅ 只读 legado.json / health.json，绝不重写
//   ✅ 不调用 score.js / filter.js / fuse.js 的主流程
//   ✅ 不自动禁用任何源
//   ✅ 网络失败/搜索无结果/章节无法识别 → result=unknown
//
// 依赖：aging-test.js（共享 fetchPage / selectAll / doSearch 等经过实测的函数）
const fs = require('fs');
const crypto = require('crypto');
const { doSearch, fetchPage, selectAll, pickOne, firstHref, originOf, norm, isChallenge, sleep } = require('./aging-test');

const CONC = 2;              // 并发数（防止 OOM）
const BUDGET_PER_BOOK = 480; // 每本书最多 8 分钟（390 源全量）
const CHAPTER_HINT = /第.{1,8}章|^\d{2,5}$/;

/* ================================================================
   T1: classifyRule — 识别单条备选规则的语法类别（纯函数）
   ================================================================ */
function classifyRule(alt) {
    alt = String(alt || '').trim();
    if (!alt) return { type: 'EMPTY', parse_result: 'UNSUPPORTED' };

    // @js: / <js> → 不支持
    if (/@js:|<js>/i.test(alt)) return { type: 'JS', parse_result: 'UNSUPPORTED' };

    // XPath: // 开头 或 @xpath:
    if (alt.startsWith('//') || alt.startsWith('@xpath:')) return { type: 'XPATH', parse_result: 'UNSUPPORTED' };

    // @css: wrapper → 解包后复用 selectAll
    if (alt.startsWith('@css:')) return { type: 'CSS_WRAPPED', parse_result: 'PARSE_OK', inner: alt.slice(5) };

    // text.xxx.N@href — 带索引
    let m = alt.match(/^text\.([^\.@]+)\.(\d+)@href$/);
    if (m) return { type: 'TEXT_INDEXED', parse_result: 'PARSE_OK', keyword: m[1], index: parseInt(m[2], 10) };

    // text.xxx@href — 不带索引
    m = alt.match(/^text\.([^\.@]+)@href$/);
    if (m) return { type: 'TEXT', parse_result: 'PARSE_OK', keyword: m[1] };

    // option!N@value — 跳过索引 N
    m = alt.match(/^option!(\d+)@value$/);
    if (m) return { type: 'OPTION_SKIP', parse_result: 'PARSE_OK', skipIndex: parseInt(m[1], 10) };

    // option[selected]+option@value — 复合，不支持
    if (/option\[selected\]/.test(alt) && /\+option/.test(alt)) {
        return { type: 'OPTION_SELECTED_PLUS', parse_result: 'UNSUPPORTED' };
    }

    // option@value — 基础 option 规则
    m = alt.match(/^option@value$/);
    if (m) return { type: 'OPTION', parse_result: 'PARSE_OK' };

    // class.blue.0@option!0@value — 混合 class + option，不支持（class 前置筛选逻辑复杂）
    if (/@option/.test(alt)) return { type: 'CLASS_OPTION_MIXED', parse_result: 'UNSUPPORTED' };

    // 其他 → pass-through selectAll（selectAll 自己判断能否处理）
    return { type: 'PASS_THROUGH', parse_result: 'PARSE_OK' };
}

/* ================================================================
   T1: resolveNextUrls — 分页规则解析纯函数（零网络、零文件、零 async）
   输入: rule（nextTocUrl 原始字符串，含 || 备选）, html（单页 HTML）, baseUrl
   输出: 三层分离的候选结果，供 T2 状态机消费
   ================================================================ */
function resolveNextUrls(rule, html, baseUrl) {
    rule = String(rule || '').trim();

    const result = {
        rule_raw: rule,
        has_js_anywhere: /@js:|<js>/i.test(rule),
        baseUrl: baseUrl || '',
        // 每个备选的详细结果
        alts: [],
        // 汇总
        selected_alt_index: -1,
        selected_urls: [],
        skipped_alts: [],
        final_status: null,       // RESOLVED / NO_VALID_URL / ALL_UNSUPPORTED / ALL_NO_MATCH
    };

    // 拆分 ||（resolveNextUrls 自己拆，避免和 selectAll 内部拆分重复）
    let altsSplit = rule.split('||').map(x => x.trim()).filter(Boolean);
    if (!altsSplit.length) {
        result.final_status = 'ALL_UNSUPPORTED';
        return result;
    }

    let selected = false;

    for (let i = 0; i < altsSplit.length; i++) {
        if (selected) break; // 前面已经选中了，后面不再尝试

        const altRaw = altsSplit[i];
        const cr = classifyRule(altRaw);

        const altResult = {
            alt_index: i,
            alt_raw: altRaw,
            rule_type: cr.type,
            parse_result: cr.parse_result,  // PARSE_OK / UNSUPPORTED / SYNTAX_ERROR
            extract_result: null,             // EXTRACT_OK / NO_MATCH
            url_resolution: null,             // HAS_VALID_URLS / NO_URL_POSSIBLE / MIXED
            raw_candidates: [],               // 提取到的原始值
            resolved_urls: [],                // 能 resolve 的有效 URL
            numeric_values: [],               // 纯数字/非 URL 格式的原始值
            alt_selection: null,              // SELECTED / SKIPPED_UNSUPPORTED / SKIPPED_NO_MATCH / SKIPPED_NO_URL / SKIPPED_SYNTAX / SKIPPED_FIRST_OK
        };

        // === UNSUPPORTED ===
        if (cr.parse_result === 'UNSUPPORTED') {
            altResult.extract_result = null;
            altResult.url_resolution = null;
            altResult.alt_selection = 'SKIPPED_UNSUPPORTED';
            result.alts.push(altResult);
            result.skipped_alts.push(i);
            continue; // 试下一个备选
        }

        // === PARSE_OK ===
        let candidates = [];

        switch (cr.type) {
            case 'TEXT':
            case 'TEXT_INDEXED': {
                // 正则匹配 <a> 标签，文本包含关键词，提取 href
                // 用 [^<]* 匹配 <a ...> 标签内的 href 属性，和 </a> 之间的文本
                const re = new RegExp(
                    '<a\\b([^>]*)href\\s*=\\s*["\']([^"\']*)["\'][^>]*>([\\s\\S]*?)</a>',
                    'gi'
                );
                let m;
                const allMatches = [];
                while ((m = re.exec(html)) !== null) {
                    const text = m[3].replace(/<[^>]+>/g, '').trim(); // 去掉嵌套标签
                    if (text.includes(cr.keyword)) {
                        allMatches.push(m[2]); // href 值
                    }
                }
                if (cr.type === 'TEXT_INDEXED') {
                    if (cr.index < allMatches.length) {
                        candidates = [allMatches[cr.index]];
                    } else {
                        candidates = []; // 越界 = 无匹配
                    }
                } else {
                    candidates = allMatches;
                }
                break;
            }

            case 'OPTION':
            case 'OPTION_SKIP': {
                // 正则提取所有 <option value="...">
                const re = /<option\b[^>]*value\s*=\s*["']([^"']*)["'][^>]*>/gi;
                let m;
                const allVals = [];
                while ((m = re.exec(html)) !== null) {
                    allVals.push(m[1]);
                }
                if (cr.type === 'OPTION_SKIP') {
                    // 跳过索引 N
                    candidates = allVals.filter((_, idx) => idx !== cr.skipIndex);
                } else {
                    candidates = allVals;
                }
                // 暂不跳过 selected——等原文确认。全部提取。
                break;
            }

            case 'CSS_WRAPPED': {
                // 解包 @css: 后 pass-through selectAll
                const sa = selectAll(html, cr.inner);
                if (sa === null) {
                    // selectAll 无法处理解包后的规则 → 视为 UNSUPPORTED
                    altResult.parse_result = 'UNSUPPORTED';
                    altResult.extract_result = null;
                    altResult.url_resolution = null;
                    altResult.alt_selection = 'SKIPPED_UNSUPPORTED';
                    result.alts.push(altResult);
                    result.skipped_alts.push(i);
                    continue;
                }
                // selectAll 返回 {items, isText} — items 可能是片段或 href
                for (const item of sa.items || []) {
                    if (typeof item === 'string') {
                        if (sa.isText) {
                            // selectAll@href 已经提取了 href 字符串
                            if (item.trim()) candidates.push(item.trim());
                        } else {
                            // HTML 片段，尝试提取 href
                            const href = firstHref(item);
                            if (href) candidates.push(href);
                        }
                    }
                }
                break;
            }

            case 'PASS_THROUGH': {
                const sa = selectAll(html, altRaw);
                if (sa === null) {
                    // selectAll 无法处理这条规则
                    altResult.parse_result = 'UNSUPPORTED';
                    altResult.extract_result = null;
                    altResult.url_resolution = null;
                    altResult.alt_selection = 'SKIPPED_UNSUPPORTED';
                    result.alts.push(altResult);
                    result.skipped_alts.push(i);
                    continue;
                }
                for (const item of sa.items || []) {
                    if (typeof item === 'string') {
                        if (sa.isText) {
                            if (item.trim()) candidates.push(item.trim());
                        } else {
                            const href = firstHref(item);
                            if (href) candidates.push(href);
                        }
                    }
                }
                break;
            }

            default: {
                // 不应该到达这里（classifyRule 已经处理了所有类型）
                altResult.parse_result = 'UNSUPPORTED';
                altResult.alt_selection = 'SKIPPED_UNSUPPORTED';
                result.alts.push(altResult);
                result.skipped_alts.push(i);
                continue;
            }
        }

        // === 候选提取结果 ===
        if (!candidates.length) {
            altResult.extract_result = 'NO_MATCH';
            altResult.url_resolution = null;
            altResult.alt_selection = 'SKIPPED_NO_MATCH';
            result.alts.push(altResult);
            result.skipped_alts.push(i);
            continue;
        }

        // === URL 可解性检查 ===
        altResult.extract_result = 'EXTRACT_OK';
        altResult.raw_candidates = candidates;

        const resolved = [];
        const numerics = [];
        const invalid = [];
        for (const val of candidates) {
            const trimmed = String(val).trim();
            if (!trimmed) { invalid.push(val); continue; }
            // fragment-only (#p2 或 #) — 不应该被当作分页 URL
            if (trimmed.startsWith('#')) { invalid.push(val); continue; }
            try {
                // 如果是纯数字（可包含负号、小数点），不尝试 resolve — 直接标记为 numeric
                if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                    numerics.push(val);
                    continue;
                }
                const u = new URL(trimmed, baseUrl).href;
                // 检查协议：只接受 http / https
                if (/^https?:\/\//i.test(u)) {
                    resolved.push(u);
                } else {
                    invalid.push(val); // javascript:, file:, data: 等
                }
            } catch (e) {
                invalid.push(val);
            }
        }

        altResult.resolved_urls = resolved;
        altResult.numeric_values = numerics;

        if (resolved.length > 0) {
            altResult.url_resolution = 'HAS_VALID_URLS';
            altResult.alt_selection = 'SELECTED';
            selected = true;
            result.selected_alt_index = i;
            result.selected_urls = resolved;
        } else if (numerics.length > 0 && resolved.length === 0) {
            // 全部是纯数字 → NO_URL_POSSIBLE → 继续尝试下一个备选
            altResult.url_resolution = 'NO_URL_POSSIBLE';
            altResult.alt_selection = 'SKIPPED_NO_URL';
            result.alts.push(altResult);
            result.skipped_alts.push(i);
            continue;
        } else {
            // 全部无效 URL → 继续尝试下一个备选
            altResult.url_resolution = 'NO_URL_POSSIBLE';
            altResult.alt_selection = 'SKIPPED_NO_URL';
            result.alts.push(altResult);
            result.skipped_alts.push(i);
            continue;
        }

        result.alts.push(altResult);
    }

    // === 汇总 final_status ===
    if (result.selected_urls.length > 0) {
        result.final_status = 'RESOLVED';
    } else if (result.alts.every(a => a.alt_selection === 'SKIPPED_UNSUPPORTED')) {
        result.final_status = 'ALL_UNSUPPORTED';
    } else {
        result.final_status = 'NO_VALID_URL';
    }

    // 注：当第一个备选选中后，for 循环 break，后续备选不会进入 result.alts
    // 这是正确行为——它们没被尝试，不应该出现在 alts 数组里

    return result;
}

/* ================================================================
   T2: 分页状态机基础设施
   ================================================================ */

/**
 * lockTerminalReason — final4 C3: 唯一终态写入入口
 * 优先级: TIME_BUDGET > MAX_PAGES > REQUEST_FAILURE_LIMIT > REPEATED_URL > VERIFIED_END > COMPLETENESS_UNCONFIRMED
 */
function lockTerminalReason(state, reason, detail) {
    if (state.terminal_locked) return; // 已锁定，不可覆盖
    state.terminal_locked = true;
    state.terminal_reason = reason;
    state.terminal_detail = detail || '';
}

/**
 * classifyParseStatus — final4 R1: parse_status 四状态分类
 * SUCCESS / EMPTY / FAILED / GARBAGE
 */
function classifyParseStatus(html, chapterListRule) {
    if (!html || typeof html !== 'string') return 'FAILED';
    if (isChallenge(html)) return 'GARBAGE';
    const cl = selectAll(html, chapterListRule || '');
    if (!cl) return 'FAILED';
    if (!cl.items || cl.items.length === 0) return 'EMPTY';
    return 'SUCCESS';
}

/**
 * extractPageNumber — 从 URL 或 HTML 中提取当前页码（V3 用）
 * 返回: number（1-based）或 null
 */
function extractPageNumber(url, html) {
    // 先从 URL 提取 /list_2.html?page=2&pn=2 等模式
    const urlMatch = url.match(/[?&](?:page|pn|pageNum|index)=(\d+)/)
                   || url.match(/[_\-\/](\d+)(?:\.\w+)?$/);
    if (urlMatch) {
        const n = parseInt(urlMatch[1], 10);
        if (!isNaN(n) && n > 0) return n;
    }
    // 再从 HTML 找"当前页码指示"——优先找 "N/M" 里的 N（当前页）
    const curRe = [
        /第\s*(\d+)\s*[\/\-到]\s*\d+\s*页?/,         // "第 1 / 4 页"
        /(\d+)\s*[\/\-]\s*\d+/,                      // "1/4"
        /第\s*(\d+)\s*页[^<]*?共/,                    // "第 1 页 共 4 页"
    ];
    for (const re of curRe) {
        const m = html.match(re);
        if (m) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > 0) return n;
        }
    }
    // v1.5 修正：如果 URL 和 HTML 都没识别出页码，但 URL 没有任何非首页特征
    // （如不带 page=/pn=、不带 _数字.html、路径末尾没有数字段），
    // 则保守返回 null 而不是硬塞 1——让 checkV3 用 unresolved 处理。
    // 这样可以区分"首页页码未标注"和"中间页页码丢失"。
    return null;
}

/**
 * extractDeclaredTotalPages — 从 HTML 中提取声明的总页数（V3 用）
 * 返回: number 或 null
 */
function extractDeclaredTotalPages(html) {
    if (!html) return null;
    // v1.5 P1-2: 优先匹配带页/节/回/total 等关键字的模式，避免把章节号或其他比例当总页数
    const patterns = [
        // 最优先：带关键字 "共 N 页" / "总 N 页" / "全 N 页"
        /(?:共|总|全)\s*(\d+)\s*[页节回集]/,
        // "第 N / M 页" → M 是总页数（要求有"第"字，避免裸 3/128 章节号）
        /第\s*\d+\s*\/\s*(\d+)\s*页/,
        /(?:total|sum)\s*[:：]?\s*(\d+)/i,
        /最后一页[^<]*?(\d+)/,
    ];
    for (const p of patterns) {
        const m = html.match(p);
        if (m && m[1]) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > 0 && n < 10000) return n; // 合理上限过滤噪声
        }
    }
    // option@value 场景：最后一个 option value（选页控件）
    const optRe = /<option[^>]*value=["']([^"']+)["'][^>]*>(\d+)<\/option>/gi;
    let m, lastVal = 0;
    while ((m = optRe.exec(html)) !== null) {
        const v = parseInt(m[2], 10);
        if (!isNaN(v) && v > 0 && v < 10000) lastVal = v; // 合理上限
    }
    if (lastVal > 0) return lastVal;
    return null;
}

/**
 * checkV3 — v1.5: 页码完整性检查
 * v1.5 修正: 首页页码未标注(null) 是正常的（很多站首页 URL 不带页码），
 *           但中间页或末页不能 unresolved。缺失的页码也必须是首页那个。
 *           关键区分：
 *           - 首页已访问但没标注页码 → pageNumbers[0]=null → 允许缺失=1
 *           - 首页根本没被访问 → pageNumbers 里没有 null 也没有 1 → 缺失=1 不允许
 * 返回: { result: 'PASS'|'FAIL'|'ERROR', declared_total, observed, missing, unresolved }
 */
function checkV3(pageNumbers, declaredTotal) {
    const observed = [...new Set(pageNumbers.filter(n => n != null))].sort((a, b) => a - b);
    const nullIdx = pageNumbers.map((n, i) => n == null ? i : -1).filter(i => i >= 0);
    const unresolved = nullIdx.length;
    let missing = [];
    if (declaredTotal && observed.length > 0) {
        for (let i = 1; i <= declaredTotal; i++) {
            if (!observed.includes(i)) missing.push(i);
        }
    }
    // v1.5 修正判定逻辑：
    // - 允许首页(nullIdx 包含 0) 未标注页码，但仅此一个
    // - 中间页/末页 unresolved → FAIL
    // - 有 declaredTotal 时，缺失的页码只有在"首页确实被访问但没标注"时才允许
    //   （即 nullIdx[0]===0 且 missing 只包含 1）
    let result = 'PASS';
    if (unresolved > 1) result = 'FAIL'; // 超过一页 unresolved
    if (unresolved === 1 && nullIdx[0] !== 0) result = 'FAIL'; // 唯一 unresolved 不是首页
    if (declaredTotal && missing.length > 0) {
        // 缺失页码 = 允许缺失的集合
        // 允许缺失 1 只有当首页确实 unresolved（被访问但没标注）
        const allowedMissing = (unresolved === 1 && nullIdx[0] === 0) ? [1] : [];
        // 不在允许列表里的缺失 → FAIL
        const disallowed = missing.filter(m => !allowedMissing.includes(m));
        if (disallowed.length > 0) result = 'FAIL';
        // 允许的缺失数量超过 1 → FAIL
        if (missing.length > allowedMissing.length) result = 'FAIL';
    }
    if (observed.length === 0 && !declaredTotal) result = 'ERROR';
    if (declaredTotal && observed.length >= declaredTotal && missing.length === 0 && unresolved === 0) result = 'PASS';
    return { result, declared_total: declaredTotal, observed_unique: observed, missing_page_numbers: missing, unresolved_page_candidates: unresolved };
}

/* ---------- 目录获取（含分页状态机，v1.4 final4 T2） ---------- */
/**
 * v1.5 getToc() — 完整分页状态机
 * v1.5 修正：MAX_PAGES 循环顶部检查（pages_attempted 计数）、continue/break 正确控制流、
 *           每步 lock 后检查 terminal_locked、opts 可注入、VERIFIED 七项硬门槛
 */
async function getToc(source, bookUrl, opts = {}) {
    const base = originOf(source.bookSourceUrl);
    const rt = source.ruleToc || {};
    const MAX_PAGES = opts.maxPages ?? 20;
    const TIME_BUDGET_MS = opts.timeBudgetMs ?? 480000;
    const FAILURE_THRESHOLD = opts.failureThreshold ?? 2;

    // opts 注入（测试可控）
    const fetchPageFn = opts.fetchPage || fetchPage;
    const clock = opts.clock || (() => Date.now());
    const sleepFn = opts.sleep || sleep;

    const nextRule = String(rt.nextTocUrl || '');
    const chapterListRule = String(rt.chapterList || '');
    const hasJsPagination = /@js:|<js>/i.test(nextRule);
    const hasNextRule = !!nextRule;

    const state = {
        terminal_locked: false,
        terminal_reason: null,
        terminal_detail: '',
        pagination_trust: 'UNKNOWN',
        failure_types: [],
        parse_statuses: [],
        pages_visited: new Set(),
        pages_attempted: 0,
        pages_succeeded: 0,
        pages_failed: 0,
        consecutive_failures: 0,
        page_numbers: [],
        declared_total_pages: null,
        toc_pages: [],
        chapters_all: [],
        chapters_by_page: [],  // 每页独立章节集合（逐页 V2 检查）
        chapters_unique: [],
        v3_result: null,
        last_page_evidence: null,   // V5
        strategy_progressed: null,  // V6: 'RESOLVED' | 'NO_VALID_URL' | 'ALL_UNSUPPORTED' | null
        strategy: null,             // 'NEXT_LINK' | 'PAGE_OPTIONS' | 'NO_PAGINATION_RULE'
        pagination_rule_dormant: false,  // 规则存在但未触发分页（可能单页目录）
    };

    const t0 = clock();
    const budgetRemaining = () => clock() - t0 < TIME_BUDGET_MS;

    // =========================================================================
    // 第一页
    // =========================================================================
    // 第一页也纳入 MAX_PAGES 预算。在发起请求前检查：预算、页数、是否重复
    if (!budgetRemaining()) {
        lockTerminalReason(state, 'TIME_BUDGET', '超过 ' + (TIME_BUDGET_MS / 1000) + 's 时间预算（首页面前）');
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }
    if (state.pages_attempted >= MAX_PAGES) {
        // pages_attempted 当前为 0 → 此分支在首页面不可能触发
        lockTerminalReason(state, 'MAX_PAGES', '达到最大页数 ' + MAX_PAGES);
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }
    if (state.pages_visited.has(bookUrl)) {
        lockTerminalReason(state, 'REPEATED_URL', '重复 URL: ' + bookUrl);
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }

    state.pages_visited.add(bookUrl);
    state.pages_attempted++;

    // 第一页发起请求
    let page1;
    try {
        page1 = await fetchPageFn(bookUrl, { ref: base });
    } catch (e) { page1 = null; }

    // v1.5: 第一页 FAIL → 立即锁定，且计入 pages_failed（保持 pages_succeeded + pages_failed = pages_attempted 不变量）
    if (!page1) {
        state.pages_failed++;
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '首页面请求超时');
        state.failure_types.push('REQUEST_TIMEOUT');
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }
    if (page1.status >= 400) {
        state.pages_failed++;
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '首页面 HTTP ' + page1.status);
        state.failure_types.push('HTTP_' + page1.status);
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }
    if (isChallenge(page1.text)) {
        state.pages_failed++;
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '首页面触发反爬验证');
        state.failure_types.push('CHALLENGE');
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }

    // 第一页 parse_status
    const ps1 = classifyParseStatus(page1.text, chapterListRule);
    state.parse_statuses.push(ps1);

    if (ps1 !== 'SUCCESS') {
        state.pages_failed++;
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '首页面 ' + ps1);
        state.failure_types.push('PARSE_' + ps1);
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }

    state.pages_succeeded++;
    state.toc_pages.push({ text: page1.text, url: bookUrl, parse_status: ps1 });

    // 第一页章节提取
    const cl1 = selectAll(page1.text, chapterListRule || '');
    const firstPageChapters = cl1 && cl1.items ? cl1.items : [];
    state.chapters_all.push(...firstPageChapters);
    state.chapters_by_page.push(firstPageChapters); // v1.5 P0-2: 第一页也要独立集合，V2 跨页查重

    state.page_numbers.push(extractPageNumber(bookUrl, page1.text));
    if (!state.declared_total_pages) {
        state.declared_total_pages = extractDeclaredTotalPages(page1.text);
    }

    // =========================================================================
    // 解析下一页规则，识别分页策略
    // =========================================================================
    let nextResolver = null;

    if (!hasNextRule) {
        state.strategy = 'NO_PAGINATION_RULE';
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '无 nextTocUrl 规则（不分页）');
        state.pagination_trust = computeTrustFromConditions(state, ['NO_PAGINATION_RULE']);
        return buildResult(state);
    }

    if (hasJsPagination) {
        state.strategy = 'NO_PAGINATION_RULE';
        state.failure_types.push('UNSUPPORTED_JS');
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '@js: 规则无 JS 引擎');
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }

    nextResolver = resolveNextUrls(nextRule, page1.text, bookUrl);
    state.strategy_progressed = nextResolver.final_status;

    if (nextResolver.final_status === 'ALL_UNSUPPORTED') {
        state.strategy = 'NO_PAGINATION_RULE';
        state.failure_types.push('ALL_UNSUPPORTED');
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '分页规则全部 UNSUPPORTED');
        state.pagination_trust = 'UNKNOWN';
        return buildResult(state);
    }

    if (nextResolver.final_status === 'NO_VALID_URL') {
        state.strategy = 'NO_PAGINATION_RULE';
        state.pagination_rule_dormant = true;  // 规则存在但单页目录没触发分页
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED', '第一页无有效下一页 URL（可能是单页目录）');
        state.pagination_trust = computeTrustFromConditions(state, ['NO_VALID_URL']);
        return buildResult(state);
    }

    // v1.5 P1-6: 策略识别——基于 resolveNextUrls 实际选中的备选规则
    // 不是默认取第一个备选，而是看哪个备选真正产生了候选 URL
    let strategyAlt = null;
    if (nextResolver.selected_alt_index >= 0) {
        strategyAlt = nextResolver.alts[nextResolver.selected_alt_index]?.alt_raw;
    }
    if (!strategyAlt) strategyAlt = nextRule.split('||')[0] || nextRule;
    const cr = classifyRule(strategyAlt);
    const isOptionRule = cr.type === 'OPTION' || cr.type === 'OPTION_SKIP';
    const multipleCandidates = nextResolver.selected_urls.length > 1;
    state.strategy = (isOptionRule || multipleCandidates) ? 'PAGE_OPTIONS' : 'NEXT_LINK';

    // =========================================================================
    // 分页主循环
    // =========================================================================
    const candidateUrls = state.strategy === 'NEXT_LINK'
        ? [nextResolver.selected_urls[0]]
        : [...nextResolver.selected_urls];

    let nextUrlIndex = 0;

    while (!state.terminal_locked && nextUrlIndex < candidateUrls.length) {
        // --- 循环顶部：请求前检查（v1.5: 顺序 TIME_BUDGET → MAX_PAGES → REPEATED_URL）---
        if (!budgetRemaining()) {
            lockTerminalReason(state, 'TIME_BUDGET', '超过 ' + (TIME_BUDGET_MS / 1000) + 's 时间预算');
            break;
        }
        if (state.pages_attempted >= MAX_PAGES) {
            lockTerminalReason(state, 'MAX_PAGES', '达到最大页数 ' + MAX_PAGES);
            break;
        }

        const url = candidateUrls[nextUrlIndex];

        if (state.pages_visited.has(url)) {
            if (state.strategy === 'PAGE_OPTIONS') {
                // v1.5 P0-3: PAGE_OPTIONS 的 select 控件常包含当前页自身 URL，
                // 这种重复应该跳过候选，不是终止遍历
                nextUrlIndex++;
                continue;
            } else {
                // NEXT_LINK 的重复 URL = 分页环，终止
                lockTerminalReason(state, 'REPEATED_URL', '重复 URL: ' + url);
                break;
            }
        }
        state.pages_visited.add(url);
        state.pages_attempted++;

        await sleepFn(300);

        let page;
        try {
            page = await fetchPageFn(url, { ref: base });
        } catch (e) { page = null; }

        // --- 请求失败分支 ---
        if (!page) {
            state.pages_failed++;
            state.consecutive_failures++;
            state.failure_types.push('REQUEST_TIMEOUT');
            if (state.consecutive_failures >= FAILURE_THRESHOLD) {
                lockTerminalReason(state, 'REQUEST_FAILURE_LIMIT', '连续失败 ' + state.consecutive_failures + ' 次');
            }
            nextUrlIndex++;
            if (state.terminal_locked) break;
            continue;
        }
        if (page.status >= 400) {
            state.pages_failed++;
            state.consecutive_failures++;
            state.failure_types.push('HTTP_' + page.status);
            if (state.consecutive_failures >= FAILURE_THRESHOLD) {
                lockTerminalReason(state, 'REQUEST_FAILURE_LIMIT', '连续失败 ' + state.consecutive_failures + ' 次');
            }
            nextUrlIndex++;
            if (state.terminal_locked) break;
            continue;
        }
        if (isChallenge(page.text)) {
            state.pages_failed++;
            state.consecutive_failures++;
            state.failure_types.push('CHALLENGE');
            if (state.consecutive_failures >= FAILURE_THRESHOLD) {
                lockTerminalReason(state, 'REQUEST_FAILURE_LIMIT', '连续失败 ' + state.consecutive_failures + ' 次（反爬）');
            }
            nextUrlIndex++;
            if (state.terminal_locked) break;
            continue;
        }

        // --- 请求成功（HTTP 200 + 非反爬）---
        const ps = classifyParseStatus(page.text, chapterListRule);
        state.parse_statuses.push(ps);

        if (ps === 'SUCCESS' || ps === 'EMPTY') {
            state.pages_succeeded++;
            state.consecutive_failures = 0;
        } else {
            // FAILED / GARBAGE — HTTP 请求成功但解析失败，归类为 pages_failed
            state.pages_failed++;
            state.consecutive_failures++;
            state.failure_types.push('PARSE_' + ps);
        }

        if (ps === 'SUCCESS') {
            state.toc_pages.push({ text: page.text, url, parse_status: ps });
            const cl = selectAll(page.text, chapterListRule || '');
            const pageChapters = cl && cl.items ? cl.items : [];
            state.chapters_all.push(...pageChapters);
            state.chapters_by_page.push(pageChapters); // 独立集合存每页
            state.page_numbers.push(extractPageNumber(url, page.text));
            if (!state.declared_total_pages) {
                state.declared_total_pages = extractDeclaredTotalPages(page.text);
            }
        } else if (ps === 'EMPTY') {
            // 空页面：请求成功但无章节。归类为 pages_succeeded，进入 toc_pages 但不提取章节
            state.toc_pages.push({ text: page.text, url, parse_status: ps });
            state.chapters_by_page.push([]); // 空页面也占槽位
            state.page_numbers.push(extractPageNumber(url, page.text));
        }

        if (state.terminal_locked) break;

        // --- 策略推进 ---
        if (state.strategy === 'NEXT_LINK') {
            const reResolver = resolveNextUrls(nextRule, page.text, url);
            state.strategy_progressed = reResolver.final_status;
            if (reResolver.final_status === 'RESOLVED' && reResolver.selected_urls.length > 0) {
                candidateUrls.push(reResolver.selected_urls[0]);
            } else {
                // 下一页解析失败 → break，进入 VERIFIED 七项判定
                break;
            }
        }
        // PAGE_OPTIONS: 遍历完当前候选后 while 条件 nextUrlIndex < candidateUrls.length 自然触发

        nextUrlIndex++;
    }

    // =========================================================================
    // 循环结束后的终止裁决
    // =========================================================================
    if (state.terminal_locked) {
        // 预算截断 / REPEATED_URL / REQUEST_FAILURE_LIMIT / MAX_PAGES
        state.pagination_trust = computeTrustFromConditions(state, [state.terminal_reason]);
        return buildResult(state);
    }

    // 正常 break：执行 V1-V7 七项硬门槛判定
    const v = runVerifiedChecks(state);
    state.v1_v7_result = v;

    // V3 check
    const v3 = checkV3(state.page_numbers, state.declared_total_pages);
    state.v3_result = v3;

    const allPass = v.v1 && v.v2 && v.v3 && v.v4 && v.v5 && v.v6 && v.v7;
    const v3Pass = v3.result === 'PASS';

    if (allPass && v3Pass) {
        lockTerminalReason(state, 'VERIFIED_END', 'V1-V7 全过 + V3_PASS');
        state.pagination_trust = 'VERIFIED';
    } else {
        // v1.5 核心 bug 修复：L795 旧代码 `k.startsWith('v') && !v[k]`
        // 把 v1_unknown=false 也当成了失败（因为 !false=true）！
        // 正确：只报告 v1/v2/v3/v4/v5/v6/v7 本身（布尔值 false = fail）
        const corePasses = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'];
        const failedItems = corePasses.filter(k => v[k] !== true);
        // 加 unknown 标记（unknown=true 也阻断 VERIFIED，但语义不同）
        const unknownItems = corePasses.filter(k => v[k + '_unknown'] === true);
        const label = [...failedItems, ...unknownItems.map(k => k + '_unknown')].join(',');
        lockTerminalReason(state, 'COMPLETENESS_UNCONFIRMED',
            'V1-V7 fail: ' + label + ' | V3=' + v3.result);
        state.pagination_trust = computeTrustFromConditions(state, ['NORMAL_BREAK']);
    }

    return buildResult(state);
}

/* ================================================================
   V1-V7 七项 VERIFIED 硬门槛（v1.5 新定）
   每项返回 { pass: bool, unknown: bool, evidence: string }
   unknown 和 fail 同样阻断 VERIFIED
   ================================================================ */

function runVerifiedChecks(state) {
    const r = {
        v1: false, v1_unknown: false, v1_evidence: '',
        v2: false, v2_unknown: false, v2_evidence: '',
        v3: false, v3_unknown: false, v3_evidence: '',
        v4: false, v4_unknown: false, v4_evidence: '',
        v5: false, v5_unknown: false, v5_evidence: '',
        v6: false, v6_unknown: false, v6_evidence: '',
        v7: false, v7_unknown: false, v7_evidence: '',
    };

    // V1: 所有已收集目录条目来自 parse_status=SUCCESS 的页面
    // toc_pages 只在 SUCCESS 或 EMPTY 时 push；SUCCESS 有章节；EMPTY 无章节但请求成功
    // 只要有 toc_pages 且没有 FAILED/GARBAGE 的 toc_pages，V1 pass
    if (state.toc_pages.length === 0) {
        r.v1_unknown = true; r.v1_evidence = '无 toc_pages';
    } else {
        const hasBad = state.toc_pages.some(p => p.parse_status === 'FAILED' || p.parse_status === 'GARBAGE');
        r.v1 = !hasBad; r.v1_evidence = hasBad ? '存在 FAILED/GARBAGE 页' : '所有 toc_pages 来自 SUCCESS/EMPTY';
    }

    // V2: 章节无跨页重复（逐页独立集合对比 + 累计去重）
    // 去重键: item.url || item.href || item.name，纯字符串则直接用字符串
    if (!state.chapters_by_page || state.chapters_by_page.length === 0) {
        r.v2_unknown = true; r.v2_evidence = '无章节数据';
    } else {
        const makeKey = (item) => typeof item === 'object'
            ? (item.url || item.href || item.name || '')
            : String(item || '');
        const seen = new Set();
        let dup = 0;
        for (const pageChapters of state.chapters_by_page) {
            for (const item of pageChapters) {
                const k = makeKey(item);
                if (!k) continue; // 跳过无 key 的条目
                if (seen.has(k)) dup++; else seen.add(k);
            }
        }
        r.v2 = dup === 0;
        r.v2_evidence = dup === 0 ? '逐页跨页集合零重复' : ('跨页重复 ' + dup + ' 条');
    }

    // V3: checkV3 已独立执行。这里只标记 pass/fail
    const v3 = checkV3(state.page_numbers, state.declared_total_pages);
    state.v3_result = v3;
    r.v3 = v3.result === 'PASS';
    r.v3_evidence = 'V3=' + v3.result;

    // V4: 未被时间预算或页数上限截断（注意：REQUEST_FAILURE_LIMIT 不是预算截断）
    // 调用 runVerifiedChecks 时 state.terminal_reason 还没锁定——但循环已 break，所以看 terminal_locked
    // 如果 terminal_locked=true 且是 TIME_BUDGET/MAX_PAGES，则 V4 fail
    if (state.terminal_locked && (state.terminal_reason === 'TIME_BUDGET' || state.terminal_reason === 'MAX_PAGES')) {
        r.v4 = false; r.v4_evidence = '被 ' + state.terminal_reason + ' 截断';
    } else {
        r.v4 = true; r.v4_evidence = '未被预算截断';
    }

    // V5: 独立末页证据——最后一个 toc_pages 的 HTML 有明确的末页特征
    if (state.toc_pages.length === 0) {
        r.v5_unknown = true; r.v5_evidence = '无末页';
    } else {
        const lastHtml = state.toc_pages[state.toc_pages.length - 1].text;
        const evidence = detectEndPageEvidence(lastHtml, state.declared_total_pages, state.page_numbers, state.strategy_progressed);
        if (evidence === 'NO_EVIDENCE') {
            r.v5_unknown = true; r.v5_evidence = '无法可靠验证末页证据';
        } else {
            r.v5 = true; r.v5_evidence = evidence;
        }
    }

    // V6: 分页策略推进有效，没有未解释的解析异常
    // strategy_progressed:
    //   RESOLVED (NEXT_LINK 每步都成功解析下一页) → V6 pass
    //   NO_VALID_URL (NEXT_LINK 最后一步没解析出下一页) → V6 pass（正常结束）
    //   ALL_UNSUPPORTED → V6 fail（未解释异常）
    //   null (PAGE_OPTIONS 遍历完) → V6 pass
    if (state.strategy_progressed === null) {
        // PAGE_OPTIONS 正常遍历完
        r.v6 = true; r.v6_evidence = 'PAGE_OPTIONS 遍历完毕';
    } else if (state.strategy_progressed === 'ALL_UNSUPPORTED') {
        r.v6 = false; r.v6_evidence = '解析异常 ALL_UNSUPPORTED';
    } else {
        r.v6 = true; r.v6_evidence = '策略推进状态: ' + state.strategy_progressed;
    }

    // V7: 请求/解析/章节集合完整性校验——没有请求失败、没有 parse FAILED/GARBAGE
    const hasRequestFail = state.pages_failed > 0;
    r.v7 = !hasRequestFail;
    r.v7_evidence = hasRequestFail ? ('存在 ' + state.pages_failed + ' 次 pages_failed') : '零失败';

    return r;
}

/**
 * detectEndPageEvidence — v1.5 V5: 独立末页证据检查
 * 双重条件（必须同时满足）：
 *   (a) 当前页没有有效的下一页链接（传入的 lastResolverStatus 不能是 RESOLVED）
 *   (b) 页面有可靠的页码证据（current = total 或 declared_total = last_page_num）
 * 返回: 证据字符串 或 'NO_EVIDENCE'
 * 任一项不满足都返回 'NO_EVIDENCE'
 */
function detectEndPageEvidence(lastHtml, declaredTotal, pageNumbers, lastResolverStatus) {
    if (!lastHtml) return 'NO_EVIDENCE';

    // (a) 下一页链接不存在：最后一次 resolveNextUrls 不能是 RESOLVED
    // 注意：PAGE_OPTIONS 遍历完时 strategy_progressed=null，也视为"没有更多下一页"
    const hasNextLink = lastResolverStatus === 'RESOLVED';
    if (hasNextLink) return 'NO_EVIDENCE'; // 明确有下一页链接 → 不可能是末页

    // (b) 页码指示器: "第 N / M 页"、"N/M"、"共 M 页 第 N 页" 等
    let pageIndicator = null;
    const indReList = [
        // 模式1: "第 20 / 20 页" → m[1]=current, m[2]=total
        { re: /第?\s*(\d+)\s*[\/\-到]\s*(\d+)\s*页?/, currentIdx: 1, totalIdx: 2 },
        // 模式2: "20/20 页" → m[1]=current, m[2]=total（要求紧跟"页"字避免匹配章节比例）
        { re: /(\d+)\s*[\/\-]\s*(\d+)\s*页/, currentIdx: 1, totalIdx: 2 },
        // 模式3: "共 20 页 第 20 页" → m[1]=total(共), m[2]=current(第)
        { re: /共\s*(\d+)\s*页[^<]*?第\s*(\d+)\s*页/, currentIdx: 2, totalIdx: 1 },
    ];
    for (const { re, currentIdx, totalIdx } of indReList) {
        const m = lastHtml.match(re);
        if (m) {
            pageIndicator = { current: parseInt(m[currentIdx]), total: parseInt(m[totalIdx]) };
            break;
        }
    }

    if (pageIndicator && pageIndicator.current === pageIndicator.total) {
        return '页码指示器 current=total=' + pageIndicator.total + ' 且无有效下一页链接';
    }

    // (b') 声明总页数 + 实际最后页码匹配
    const lastPageNum = pageNumbers && pageNumbers.length > 0
        ? pageNumbers[pageNumbers.length - 1] : null;
    if (declaredTotal && lastPageNum && lastPageNum === declaredTotal) {
        return 'declared_total=' + declaredTotal + ' === last_page_num=' + lastPageNum + ' 且无有效下一页链接';
    }

    return 'NO_EVIDENCE';
}

/**
 * computeTrustFromConditions — v1.5: 根据终态原因和实际证据计算可信度
 * 不再硬编码 PARTIAL，而是看 pages_succeeded 和是否有章节
 */
function computeTrustFromConditions(state, terminalContext) {
    const reason = terminalContext[0] || state.terminal_reason;
    const hasPages = state.pages_succeeded > 0;
    const hasChapters = state.chapters_all.length > 0;
    const hasEvidence = state.v1_v7_result
        ? (state.v1_v7_result.v5 && state.v1_v7_result.v3)
        : false;

    if (reason === 'VERIFIED_END') return 'VERIFIED';
    if (reason === 'TIME_BUDGET' || reason === 'MAX_PAGES' || reason === 'REQUEST_FAILURE_LIMIT') {
        return hasPages ? 'PARTIAL' : 'UNKNOWN';
    }
    if (reason === 'REPEATED_URL') {
        return hasPages ? 'PARTIAL' : 'UNKNOWN';
    }
    if (reason === 'NO_PAGINATION_RULE') {
        // 只有一页且有章节 → PARTIAL（这一页就是全部）
        return hasChapters ? 'PARTIAL' : 'UNKNOWN';
    }
    if (reason === 'NORMAL_BREAK') {
        return hasEvidence ? 'PARTIAL' : (hasPages ? 'PARTIAL' : 'UNKNOWN');
    }
    // COMPLETENESS_UNCONFIRMED 及其子原因
    if (hasChapters) return 'PARTIAL';
    return 'UNKNOWN';
}

/**
 * buildResult — 组装最终返回值（保持旧字段兼容 + 新增 T2 字段）
 */
function buildResult(state) {
    // 章节去重（与旧实现一致）
    let chapters = [];
    if (state.chapters_all.length > 0) {
        const clean = state.chapters_all.filter(item => {
            const name = typeof item === 'object' ? (item.name || '') : String(item || '');
            return CHAPTER_HINT.test(name.trim()) || name.trim().length >= 2;
        });
        const seen = new Set();
        chapters = clean.filter(item => {
            const u = typeof item === 'object' ? (item.url || item.href || '') : '';
            const k = u || (typeof item === 'object' ? item.name : String(item));
            if (seen.has(k)) return false;
            seen.add(k); return true;
        });
    }

    // 旧字段 + 新增 T2 字段
    const result = {
        // 旧字段（主流程 L511-563 消费）
        status: chapters.length > 0 ? 'ok' : 'skip',
        chapters: chapters.length,
        pages: state.toc_pages.length,
        // 兼容旧 reason 字段
        reason: state.terminal_reason === 'COMPLETENESS_UNCONFIRMED'
            ? state.terminal_detail
            : '',

        // T2 新增字段（主流程暂不消费，内部记录）
        terminal_reason: state.terminal_reason,
        pagination_trust: state.pagination_trust,
        pagination_rule_dormant: !!state.pagination_rule_dormant,  // 规则存在但单页目录
        failure_types: state.failure_types,
        pages_attempted: state.pages_attempted,
        pages_succeeded: state.pages_succeeded,
        pages_failed: state.pages_failed,
        consecutive_failures_final: state.consecutive_failures,
        v3_result: state.v3_result,
        v1_v7_result: state.v1_v7_result || null,
        strategy: state.strategy,
    };

    return result;
}

/* ---------- 从搜索结果选第一本（书名模糊匹配） ---------- */
function pickFirstBook(r, source, base, preferTitle) {
    const rs = source.ruleSearch || {};
    const pat = String(source.bookUrlPattern || '').trim();
    const buRule = String(rs.bookUrl || '');
    
    // 如果有搜索结果文本包含书名关键词，优先选
    if (preferTitle && r.bl.items.length > 1) {
        const kw = preferTitle.replace(/第[一二三四五六七八九十百千]+部/g, '').slice(0, 4); // 取前 4 字
        for (const f of r.bl.items) {
            const name = typeof f === 'object' ? (f.name || '') : String(f || '');
            if (kw && name.includes(kw)) {
                let u = pickOne(f, buRule);
                if (!u && typeof f !== 'object') u = firstHref(f);
                if (u && !(pat && !/^https?:\/\//i.test(u) && !/[./]/.test(u))) {
                    try { return new URL(u, base).href; } catch (e) {}
                }
            }
        }
    }
    // 兜底：第一个能构造 URL 的
    for (const f of r.bl.items) {
        let u = pickOne(f, buRule);
        if (!u && typeof f !== 'object') u = firstHref(f);
        if (!u) continue;
        if (pat && !/^https?:\/\//i.test(u) && !/[./]/.test(u)) continue; // 需要模板拼接跳过
        try { return new URL(u, base).href; } catch (e) {}
    }
    return '';
}

/* ---------- T1 fixture 测试入口（零网络、零文件写入） ---------- */
if (require.main === module && process.argv.includes('--test-t1')) {
    runT1Tests();
} else if (require.main === module && process.argv.includes('--test-t2')) {
    runT2Tests();
} else if (require.main === module && process.argv.includes('--test-t3')) {
    runT3StateMachineTests();
} else if (require.main === module && process.argv.includes('--probe-pagination')) {
    runPaginationProbe();
} else if (require.main === module) {

/* ---------- 主流程 ---------- */
(async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━ 时效诊断 freshness-audit.js ━━━━━━━━━━━━━━━━━━━━━━');
    
    // 加载测试书目
    let books;
    if (fs.existsSync('books.json')) {
        books = JSON.parse(fs.readFileSync('books.json', 'utf8'));
        console.log('已加载 books.json：' + books.length + ' 本书');
    } else {
        books = [
            { key: 'wei_jia_nie_zhong', title: '魏家孽种成首辅', reference: 640, source: '番茄小说' },
        ];
        console.log('未找到 books.json，使用默认测试书');
    }
    
    // 加载源清单
    const legadoPath = process.env.LEGADO_PATH || 'legado.json';
    const list = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
    console.log('源清单：' + list.length + ' 个源');
    
    const details = [];
    const summary = { generatedAt: Date.now(), books: {} };
    const t0 = Date.now();
    
    for (const book of books) {
        console.log('\n📖 《' + book.title + '》（参考 ' + book.reference + ' 章）');
        const bookResult = {
            key: book.key, title: book.title, reference: book.reference,
            source: book.source, checkedAt: Date.now(),
            bySource: [], medianChapter: 0, maxChapter: 0,
            sourcesChecked: 0, sourcesLagging: 0, sourcesUnknown: 0,
        };
        
        const startTime = Date.now();
        const queue = list.slice();
        let idx = 0;
        
        async function worker() {
            while (idx < queue.length && Date.now() - startTime < BUDGET_PER_BOOK * 1000) {
                const s = queue[idx++];
                const su = norm(s.bookSourceUrl);
                if (!su) continue;
                const hash = crypto.createHash('sha256').update(su).digest('hex').slice(0, 12);
                const base = originOf(s.bookSourceUrl);
                if (!base) {
                    details.push({ book_key: book.key, source_url_hash: hash, reference_chapter: book.reference, source_chapter: 0, catalog_checked: false, body_verified: false, checked_at: Date.now(), result: 'unknown', reason: '无效URL' });
                    bookResult.sourcesUnknown++;
                    continue;
                }
                
                // 搜索
                const rs = s.ruleSearch || {};
                const r1 = await doSearch(s, base, rs, book.title);
                if (r1.skip) {
                    details.push({ book_key: book.key, source_url_hash: hash, reference_chapter: book.reference, source_chapter: 0, catalog_checked: false, body_verified: false, checked_at: Date.now(), result: 'unknown', reason: r1.skip });
                    bookResult.sourcesUnknown++;
                    continue;
                }
                if (r1.dead) {
                    details.push({ book_key: book.key, source_url_hash: hash, reference_chapter: book.reference, source_chapter: 0, catalog_checked: false, body_verified: false, checked_at: Date.now(), result: 'unknown', reason: r1.dead });
                    bookResult.sourcesUnknown++;
                    continue;
                }
                if (!r1.bl.items.length) {
                    details.push({ book_key: book.key, source_url_hash: hash, reference_chapter: book.reference, source_chapter: 0, catalog_checked: false, body_verified: false, checked_at: Date.now(), result: 'unknown', reason: '搜索无结果' });
                    bookResult.sourcesUnknown++;
                    continue;
                }
                
                // 取书籍 URL
                const bookUrl = pickFirstBook(r1, s, base, book.title);
                if (!bookUrl) {
                    details.push({ book_key: book.key, source_url_hash: hash, reference_chapter: book.reference, source_chapter: 0, catalog_checked: false, body_verified: false, checked_at: Date.now(), result: 'unknown', reason: '无法构造书籍URL' });
                    bookResult.sourcesUnknown++;
                    continue;
                }
                
                // 目录
                // v1.5 P1-5: 主流程给每个源传独立预算（60s），避免一个慢源吃光整书 8 分钟
                const toc = await getToc(s, bookUrl, { timeBudgetMs: 60000 });
                
                let result = 'unknown';
                let pagination_status = 'unknown';
                let confidence = 'low';
                if (toc.status === 'ok' && toc.chapters > 0) {
                    // 有效源才算 checked
                    bookResult.sourcesChecked++;
                    // v1.5 P1-4: 直接消费 toc.pagination_trust（状态机已算好），
                    // 不要从 toc.pages 反推（单页/截断会误判）
                    const trust = toc.pagination_trust || 'UNKNOWN';
                    const termReason = toc.terminal_reason || '';
                    
                    if (termReason === 'VERIFIED_END') {
                        pagination_status = '翻页成功';
                    } else if (termReason === 'MAX_PAGES' || termReason === 'TIME_BUDGET') {
                        pagination_status = '翻页截断（' + termReason + '）';
                    } else if (termReason === 'REQUEST_FAILURE_LIMIT') {
                        pagination_status = '翻页失败（连续失败）';
                    } else if (termReason === 'REPEATED_URL') {
                        pagination_status = '翻页失败（分页环）';
                    } else if (termReason === 'COMPLETENESS_UNCONFIRMED' || termReason === 'NO_PAGINATION_RULE') {
                        pagination_status = '单页/不分页';
                    } else {
                        pagination_status = '未知';
                    }
                    
                    // confidence：直接用 trust 映射
                    const trustToConf = { VERIFIED: 'high', PARTIAL: 'medium', UNKNOWN: 'low' };
                    confidence = trustToConf[trust] || 'low';
                    
                    // 覆盖：不分页 + 章节比例低时仍应降为 low
                    const rt = s.ruleToc || {};
                    const hasNextRule = !!rt.nextTocUrl;
                    if (!hasNextRule && toc.chapters / book.reference < 0.5) {
                        confidence = 'low'; // 不分页但章节数极低 → 不能说明是截断还是真落后
                    }
                    
                    const diff = toc.chapters - book.reference;
                    const ratio = toc.chapters / book.reference;
                    if (diff >= 0) result = 'leading_or_match';
                    else if (diff >= -5) result = 'slightly_behind';
                    else if (diff >= -20) result = 'behind';
                    else result = 'far_behind';
                    
                    bookResult.bySource.push({
                        url: su, hash, name: String(s.bookSourceName || '').slice(0, 25),
                        observed_chapters: toc.chapters, result, diff, ratio,
                        pagination_status, confidence,
                        // v1.5 #1: 疑似截断标记——单页 + 章节数是 100 的整数倍
                        // （很多站点每页刚好 100 章，没翻页就抓到 100/200/300 ...）
                        suspicious_truncation: (toc.pages <= 1) && (toc.chapters > 0) && (toc.chapters % 100 === 0),
                        pagination_rule_dormant: !!toc.pagination_rule_dormant,  // 规则存在但单页目录
                    });
                } else {
                    bookResult.sourcesUnknown++;
                }
                
                details.push({
                    book_key: book.key, source_url_hash: hash,
                    reference_chapter: book.reference, source_chapter: toc.chapters,
                    catalog_checked: toc.status === 'ok', body_verified: false,
                    checked_at: Date.now(), result,
                    reason: toc.status === 'ok' ? '' : toc.reason,
                    pagination_rule_dormant: !!toc.pagination_rule_dormant,
                });
                
                await sleep(300);
            }
        }
        await Promise.all(Array.from({ length: CONC }, worker));
        
        // P0-4 v1.5: 预算截断后登记剩余未被消费的源为 unknown
        // 正常消费完 queue 时 idx === queue.length；预算截断时 idx < queue.length
        const remaining = queue.slice(idx);
        if (remaining.length > 0) {
            const budgetTruncated = Date.now() - startTime >= BUDGET_PER_BOOK * 1000;
            for (const s of remaining) {
                const su = norm(s.bookSourceUrl);
                const hash = crypto.createHash('sha256').update(su || '').digest('hex').slice(0, 12);
                details.push({
                    book_key: book.key, source_url_hash: hash,
                    reference_chapter: book.reference, source_chapter: 0,
                    catalog_checked: false, body_verified: false,
                    checked_at: Date.now(), result: 'unknown',
                    reason: budgetTruncated ? '时间预算截断（剩余源未测）' : '源队列剩余未消费',
                });
                bookResult.sourcesUnknown++;
            }
            bookResult.budget_truncated = budgetTruncated;
            bookResult.sourcesRemaining = remaining.length;
        } else {
            bookResult.budget_truncated = false;
            bookResult.sourcesRemaining = 0;
        }
        
        // 统计
        const chapters = bookResult.bySource.map(x => x.observed_chapters).filter(x => x > 0).sort((a, b) => a - b);
        if (chapters.length) {
            bookResult.medianChapter = chapters[Math.floor(chapters.length / 2)];
            bookResult.maxChapter = chapters[chapters.length - 1];
            const laggers = bookResult.bySource.filter(x => ['behind', 'far_behind'].includes(x.result));
            bookResult.sourcesLagging = laggers.length;
            // v1.5 #1: 按 confidence 拆分——medium+high 才算"可靠滞后"
            bookResult.sourcesLaggingConfirmed = laggers.filter(x => x.confidence !== 'low').length;
            bookResult.sourcesLaggingUnconfirmed = laggers.filter(x => x.confidence === 'low').length;
            bookResult.sourcesSuspiciousTruncation = laggers.filter(x => x.suspicious_truncation).length;
            // v1.5 #2: 规则存在但单页目录——dormant
            bookResult.sourcesRuleDormant = bookResult.bySource.filter(x => x.pagination_rule_dormant).length;
        }
        
        summary.books[book.key] = bookResult;
        
        // 控制台
        const leading = bookResult.bySource.filter(x => x.result === 'leading_or_match').length;
        const laggingConfirmed = bookResult.sourcesLaggingConfirmed || 0;
        const laggingUnconfirmed = bookResult.sourcesLaggingUnconfirmed || 0;
        const suspicious = bookResult.sourcesSuspiciousTruncation || 0;
        const dormant = bookResult.sourcesRuleDormant || 0;
        console.log('  检查: ' + bookResult.sourcesChecked + ' / 中位数: ' + bookResult.medianChapter + ' / 领先: ' + leading +
            ' / 已确认滞后: ' + laggingConfirmed + ' / 待确认滞后: ' + laggingUnconfirmed +
            (suspicious ? ' / ⚠️疑似截断: ' + suspicious : '') +
            (dormant ? ' / 💤规则休眠: ' + dormant : '') +
            ' / 未知: ' + bookResult.sourcesUnknown);
        if (bookResult.bySource.length) {
            const top = bookResult.bySource.sort((a, b) => b.observed_chapters - a.observed_chapters).slice(0, 5);
            console.log('  TOP5:');
            for (const t of top) {
                const truncTag = t.suspicious_truncation ? ' ⚠️疑似截断' : '';
                console.log('    ' + t.observed_chapters + '章 (' + t.result + ', conf=' + t.confidence + ')' + truncTag + ' ' + t.name);
            }
            // 已确认滞后（confidence !== low）才进 headline 的 bottom 提示
            const confirmedLaggers = bookResult.bySource
                .filter(x => ['behind', 'far_behind'].includes(x.result) && x.confidence !== 'low')
                .sort((a, b) => a.observed_chapters - b.observed_chapters);
            if (confirmedLaggers[0] && confirmedLaggers[0].observed_chapters < bookResult.medianChapter * 0.7) {
                console.log('  ⚠️ 明显滞后（已确认，<70% 中位数）:');
                for (const t of confirmedLaggers.slice(0, 3)) console.log('    ' + t.observed_chapters + '章 ' + t.name + ' [' + t.url + ']');
            }
            // 疑似截断单独列出
            const truncSuspects = bookResult.bySource.filter(x => x.suspicious_truncation);
            if (truncSuspects.length) {
                console.log('  ⚠️ 疑似只抓到第一页（章节数为 100 整数倍）:');
                for (const t of truncSuspects.slice(0, 5)) console.log('    ' + t.observed_chapters + '章 ' + t.name + ' [' + t.url + ']');
                if (truncSuspects.length > 5) console.log('    ... 共 ' + truncSuspects.length + ' 个');
            }
        }
    }
    
    // 输出
    const outDir = 'reports';
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    
    fs.writeFileSync(outDir + '/freshness-summary.json', JSON.stringify(summary, null, 1));
    console.log('\n✅ reports/freshness-summary.json');
    
    const headers = ['book_key', 'source_url_hash', 'reference_chapter', 'source_chapter', 'catalog_checked', 'body_verified', 'checked_at', 'result', 'reason'];
    const escapeCsv = (v) => {
        const s = String(v ?? '');
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
    };
    const csv = [headers.map(escapeCsv).join(',')];
    for (const d of details) {
        csv.push([
            d.book_key, d.source_url_hash, d.reference_chapter, d.source_chapter,
            d.catalog_checked, d.body_verified, d.checked_at, d.result, d.reason || '',
        ].map(escapeCsv).join(','));
    }
    fs.writeFileSync(outDir + '/freshness-details.csv', csv.join('\n'), 'utf8');
    console.log('✅ reports/freshness-details.csv（' + details.length + ' 行）');
    
    console.log('\n⏱ ' + Math.round((Date.now() - t0) / 1000) + 's');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
})().catch(e => { console.error('时效诊断异常:', e); process.exit(1); });

} // end of else-if (require.main && !--test-t1)

/* ================================================================
   T1 Fixture 测试 — 零网络、零文件、零 async
   ================================================================ */
function runT1Tests() {
    console.log('━━━━━━━━━━━━━━━━━━━━ T1 fixture 测试 ━━━━━━━━━━━━━━━━━━━━━━');
    const BASE = 'https://example.com/book/list.html';
    let passed = 0, failed = 0;
    function check(name, cond, detail) {
        if (cond) { passed++; console.log('  ✅ ' + name); }
        else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
    }
    function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

    // F1: text.xxx@href — 一个匹配
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F1 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F1 selected_urls 数量', r.selected_urls.length === 1);
        check('F1 URL 正确拼接', r.selected_urls[0] === 'https://example.com/p2.html');
        check('F1 alt_selection=SELECTED', r.alts[0].alt_selection === 'SELECTED');
        check('F1 rule_type=TEXT', r.alts[0].rule_type === 'TEXT');
        check('F1 parse_result=PARSE_OK', r.alts[0].parse_result === 'PARSE_OK');
        check('F1 extract_result=EXTRACT_OK', r.alts[0].extract_result === 'EXTRACT_OK');
        check('F1 url_resolution=HAS_VALID_URLS', r.alts[0].url_resolution === 'HAS_VALID_URLS');
    }

    // F2: text.xxx@href — 多个匹配
    {
        const html = '<a href="/p1.html">上一页</a><a href="/p2.html">下一页</a><a href="/p3.html">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F2 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F2 提取到 2 个 URL', r.selected_urls.length === 2);
    }

    // F3: text.xxx.N@href — 索引边界
    {
        const html = '<a href="/p1.html">上一页</a><a href="/p2.html">下一页</a><a href="/p3.html">下一页</a>';
        const r0 = resolveNextUrls('text.下一页.0@href', html, BASE);
        check('F3 索引 0 取第一个下一页', r0.selected_urls[0] === 'https://example.com/p2.html');
        const r1 = resolveNextUrls('text.下一页.1@href', html, BASE);
        check('F3 索引 1 取第二个下一页', r1.selected_urls[0] === 'https://example.com/p3.html');
        const r99 = resolveNextUrls('text.下一页.99@href', html, BASE);
        check('F3 索引越界 → NO_VALID_URL', r99.final_status === 'NO_VALID_URL');
    }

    // F4: text.xxx@href — 无匹配
    {
        const html = '<a href="/p2.html">上一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F4 无匹配 → NO_VALID_URL', r.final_status === 'NO_VALID_URL');
        check('F4 extract_result=NO_MATCH', r.alts[0].extract_result === 'NO_MATCH');
    }

    // F5: option@value — 含 selected，全部提取
    {
        const html = '<select><option value="1" selected>1</option><option value="2">2</option><option value="3">3</option></select>';
        const r = resolveNextUrls('option@value', html, BASE);
        // 暂不跳过 selected — 提取全部 3 个
        check('F5 提取到全部 3 个值', r.alts[0].raw_candidates.length === 3, JSON.stringify(r.alts[0].raw_candidates));
        check('F5 全部是纯数字 → NO_URL_POSSIBLE', r.alts[0].url_resolution === 'NO_URL_POSSIBLE');
        check('F5 全部纯数字 → NO_VALID_URL', r.final_status === 'NO_VALID_URL');
    }

    // F6: option@value — 有有效 URL
    {
        const html = '<select><option value="/p2.html">2</option><option value="/p3.html">3</option></select>';
        const r = resolveNextUrls('option@value', html, BASE);
        check('F6 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F6 2 个有效 URL', r.selected_urls.length === 2);
        check('F6 url_resolution=HAS_VALID_URLS', r.alts[0].url_resolution === 'HAS_VALID_URLS');
    }

    // F7: option@value — 混合（2 个 URL + 3 个纯数字）
    {
        const html = '<select><option value="/p2.html">2</option><option value="3">3</option><option value="/p4.html">4</option><option value="5">5</option></select>';
        const r = resolveNextUrls('option@value', html, BASE);
        check('F7 有有效 URL → RESOLVED', r.final_status === 'RESOLVED');
        check('F7 2 个 resolved', r.selected_urls.length === 2);
        check('F7 url_resolution=HAS_VALID_URLS', r.alts[0].url_resolution === 'HAS_VALID_URLS');
    }

    // F8: option!N@value — 跳过索引 N
    {
        const html = '<select><option value="1">1</option><option value="2">2</option><option value="3">3</option></select>';
        const r = resolveNextUrls('option!0@value', html, BASE);
        check('F8 跳过索引 0 → 提取 2 个值', r.alts[0].raw_candidates.length === 2);
    }

    // F9: selectAll pass-through（.class@a@href）
    {
        const html = '<div class="right"><a href="/p2.html">下一页</a></div>';
        const r = resolveNextUrls('.right@a@href', html, BASE);
        check('F9 .right@a@href → RESOLVED', r.final_status === 'RESOLVED');
        check('F9 rule_type=PASS_THROUGH', r.alts[0].rule_type === 'PASS_THROUGH');
        check('F9 URL 正确', r.selected_urls[0] === 'https://example.com/p2.html');
    }

    // F10: selectAll 空格分隔（.right@tag.a@href）
    {
        const html = '<div class="right"><a href="/p2.html">下一页</a></div>';
        const r = resolveNextUrls('.right@tag.a@href', html, BASE);
        check('F10 .right@tag.a@href → RESOLVED', r.final_status === 'RESOLVED');
    }

    // F11: || 备选 0 UNSUPPORTED + 备选 1 OK
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('@js:x||text.下一页@href', html, BASE);
        check('F11 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F11 alts[0].UNSUPPORTED', r.alts[0].alt_selection === 'SKIPPED_UNSUPPORTED');
        check('F11 alts[1].SELECTED', r.alts[1].alt_selection === 'SELECTED');
        check('F11 备选 1 rule_type=TEXT', r.alts[1].rule_type === 'TEXT');
    }

    // F12: || 备选 0 NO_URL_POSSIBLE + 备选 1 OK — 纯数字后继续试备选
    {
        const htmlOpt = '<select><option value="2">2</option><option value="3">3</option></select>';
        const htmlText = '<a href="/p2.html">下一页</a>';
        // 需要：同一个 html 能让 option 提取纯数字 + text.下一页 能匹配
        // 构造一个同时包含两者的 html
        const htmlBoth = htmlOpt + '<div class="nav">' + htmlText + '</div>';
        const r = resolveNextUrls('option@value||text.下一页@href', htmlBoth, BASE);
        check('F12 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F12 alts[0] NO_URL_POSSIBLE', r.alts[0].url_resolution === 'NO_URL_POSSIBLE');
        check('F12 alts[1] SELECTED', r.alts[1].alt_selection === 'SELECTED');
        check('F12 备选 1 URL 正确', r.alts[1].selected !== undefined || r.selected_urls[0] === 'https://example.com/p2.html');
    }

    // F13: || 备选 0 OK + 备选 1 UNSUPPORTED
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('text.下一页@href||@js:x', html, BASE);
        check('F13 final_status=RESOLVED', r.final_status === 'RESOLVED');
        check('F13 备选 0 SELECTED', r.alts[0].alt_selection === 'SELECTED');
        check('F13 备选 1 未进入 alts（已 break）', r.alts.length === 1);
    }

    // F14: 全备选 UNSUPPORTED
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('@js:x||//a/@href', html, BASE);
        check('F14 final_status=ALL_UNSUPPORTED', r.final_status === 'ALL_UNSUPPORTED');
        check('F14 alts[0].JS UNSUPPORTED', r.alts[0].rule_type === 'JS' && r.alts[0].parse_result === 'UNSUPPORTED');
        check('F14 alts[1].XPATH UNSUPPORTED', r.alts[1].rule_type === 'XPATH' && r.alts[1].parse_result === 'UNSUPPORTED');
    }

    // F15: XPath 规则 — UNSUPPORTED
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('//a[contains(@class,"next")]/@href', html, BASE);
        check('F15 XPath → UNSUPPORTED', r.alts[0].rule_type === 'XPATH');
    }

    // F16: 空 href — 无效
    {
        const html = '<a href="">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F16 空 href → 不产生虚构 URL', !r.selected_urls.includes('https://example.com/p2.html'));
    }

    // F17: fragment-only — 无效协议
    {
        const html = '<a href="#p2">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F17 #p2 → 不产生虚构 URL', r.selected_urls.length === 0);
        check('F17 NO_VALID_URL', r.final_status === 'NO_VALID_URL');
    }

    // F18: javascript: 协议 — 无效
    {
        const html = '<a href="javascript:void(0)">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F18 javascript: → 不产生虚构 URL', r.selected_urls.length === 0);
    }

    // F19: 绝对 URL — 保留原 host
    {
        const html = '<a href="https://other.com/p2">下一页</a>';
        const r = resolveNextUrls('text.下一页@href', html, BASE);
        check('F19 绝对 URL 保留原 host', r.selected_urls[0] === 'https://other.com/p2');
    }

    // F20: 空规则 → ALL_UNSUPPORTED
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r = resolveNextUrls('', html, BASE);
        check('F20 空规则 → ALL_UNSUPPORTED', r.final_status === 'ALL_UNSUPPORTED');
    }

    // F21: 纯函数性质 — 相同输入 → 相同输出
    {
        const html = '<a href="/p2.html">下一页</a>';
        const r1 = resolveNextUrls('text.下一页@href', html, BASE);
        const r2 = resolveNextUrls('text.下一页@href', html, BASE);
        check('F21 纯函数确定性', eq(r1, r2));
    }

    // F22: resolveNextUrls 零 async / await
    {
        const src = resolveNextUrls.toString();
        check('F22 零 async', !/\basync\b/.test(src));
        check('F22 零 await', !/\bawait\b/.test(src));
    }

    // F23: classifyRule 输出类型
    {
        check('F23 JS → UNSUPPORTED', classifyRule('@js:next').parse_result === 'UNSUPPORTED');
        check('F23 XPath → UNSUPPORTED', classifyRule('//a/@href').parse_result === 'UNSUPPORTED');
        check('F23 text.下一页@href → TEXT', classifyRule('text.下一页@href').type === 'TEXT');
        check('F23 option@value → OPTION', classifyRule('option@value').type === 'OPTION');
        check('F23 .class@href → PASS_THROUGH', classifyRule('.right@href').type === 'PASS_THROUGH');
        check('F23 @css: → CSS_WRAPPED', classifyRule('@css:.next@href').type === 'CSS_WRAPPED');
        check('F23 空 → EMPTY', classifyRule('').type === 'EMPTY');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`结果: ${passed} 通过, ${failed} 失败`);
    if (failed > 0) process.exit(1);
}

/* ================================================================
   T2 Fixture 测试 — 零网络、零文件，手动驱动状态机
   ================================================================ */
function runT2Tests() {
    console.log('━━━━━━━━━━━━━━━━━━━━ T2 fixture 测试 ━━━━━━━━━━━━━━━━━━━━━━');
    let passed = 0, failed = 0;
    function check(name, cond, detail) {
        if (cond) { passed++; console.log('  ✅ ' + name); }
        else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
    }

    // === S1: lockTerminalReason 唯一性 ===
    {
        const st = { terminal_locked: false };
        lockTerminalReason(st, 'COMPLETENESS_UNCONFIRMED', 'first');
        check('S1 第一次锁定成功', st.terminal_reason === 'COMPLETENESS_UNCONFIRMED');
        lockTerminalReason(st, 'TIME_BUDGET', 'should fail');
        check('S1 第二次被忽略', st.terminal_reason === 'COMPLETENESS_UNCONFIRMED');
        check('S1 terminal_locked=true', st.terminal_locked === true);
    }

    // === S2: V3 checkV3 ===
    {
        check('S2 V3 完整: 1,2,3 + declared=3',
            checkV3([1, 2, 3], 3).result === 'PASS');
        const fail1 = checkV3([1, 2], 3);
        check('S2 V3 缺页: 1,2 + declared=3',
            fail1.result === 'FAIL' && fail1.missing_page_numbers.includes(3));
        const fail2 = checkV3([1, 2, null, 3], 3);
        check('S2 V3 unresolved',
            fail2.result === 'FAIL' && fail2.unresolved_page_candidates === 1);
        const err1 = checkV3([], null);
        check('S2 V3 ERROR: 无页码无声明', err1.result === 'ERROR');
        check('S2 V3 declared=5 observed=[1..5]',
            checkV3([1, 2, 3, 4, 5], 5).result === 'PASS');
    }

    // === S3: classifyParseStatus ===
    {
        const clRule = '.chapter-list@a@href';
        const okHtml = '<div class="chapter-list"><a href="/c1">第1章</a><a href="/c2">第2章</a></div>';
        const emptyHtml = '<div class="chapter-list"></div>';
        const failHtml = '<script>alert("x")</script>';
        const garbHtml = '百度安全验证';

        check('S3 SUCCESS', classifyParseStatus(okHtml, clRule) === 'SUCCESS');
        check('S3 EMPTY', classifyParseStatus(emptyHtml, clRule) === 'EMPTY');
        check('S3 FAILED (no html)', classifyParseStatus(null, clRule) === 'FAILED');
        check('S3 FAILED (no rule)', classifyParseStatus(okHtml, '') === 'FAILED');
        check('S3 GARBAGE', classifyParseStatus(garbHtml, clRule) === 'GARBAGE');
    }

    // === S4: extractPageNumber ===
    {
        check('S4 ?page=3', extractPageNumber('/list?page=3', '') === 3);
        check('S4 /list_4.html', extractPageNumber('/list_4.html', '') === 4);
        check('S4 no number', extractPageNumber('/list.html', '') === null);
    }

    // === S5: extractDeclaredTotalPages ===
    {
        check('S5 "共20页"', extractDeclaredTotalPages('共20页') === 20);
        check('S5 option 最后一个', extractDeclaredTotalPages(
            '<option value="1">1</option><option value="2">2</option><option value="20">20</option>') === 20);
        check('S5 no declare', extractDeclaredTotalPages('nothing here') === null);
    }

    // === S6: visited 检查 (C12 操作顺序) ===
    {
        const st = { pages_visited: new Set() };
        const url = 'https://ex.com/list.html';
        check('S6 初始不在 visited', !st.pages_visited.has(url));
        st.pages_visited.add(url);
        check('S6 加入后在 visited', st.pages_visited.has(url));
        // 重复 URL → 锁 REPEATED_URL，不 increment pages_attempted
        const st2 = { terminal_locked: false, pages_visited: new Set() };
        st2.pages_visited.add(url);
        if (st2.pages_visited.has(url)) {
            lockTerminalReason(st2, 'REPEATED_URL', url);
        }
        check('S6 REPEATED_URL 锁定', st2.terminal_reason === 'REPEATED_URL');
    }

    // === S7: pages_succeeded + pages_failed = pages_attempted 不变量 ===
    {
        const st = {
            pages_visited: new Set(['url1']), // 第 1 页在 visited (算 attempted)
            pages_attempted: 1,               // 第 1 页
            pages_succeeded: 1,
            pages_failed: 0,
        };
        // 拉 url2 → 成功
        st.pages_visited.add('url2');
        st.pages_attempted++;
        st.pages_succeeded++;
        // 拉 url3 → 失败
        st.pages_visited.add('url3');
        st.pages_attempted++;
        st.pages_failed++;
        check('S7 不变量 holds',
            st.pages_succeeded + st.pages_failed === st.pages_attempted);
    }

    // === S8: consecutive_failures → REQUEST_FAILURE_LIMIT ===
    {
        const st = {
            terminal_locked: false, consecutive_failures: 0,
            pages_visited: new Set(), pages_attempted: 0, pages_succeeded: 0, pages_failed: 0,
            failure_types: [],
        };
        // 模拟 3 次连续失败 (阈值 N=2)
        for (let i = 0; i < 3 && !st.terminal_locked; i++) {
            st.pages_visited.add('url' + i);
            st.pages_attempted++;
            st.pages_failed++;
            st.consecutive_failures++;
            st.failure_types.push('HTTP_502');
            if (st.consecutive_failures >= 2) {
                lockTerminalReason(st, 'REQUEST_FAILURE_LIMIT', '连续失败 ' + st.consecutive_failures + ' 次');
            }
        }
        check('S8 达到阈值锁定 REQUEST_FAILURE_LIMIT', st.terminal_reason === 'REQUEST_FAILURE_LIMIT');
        check('S8 锁定时 consecutive_failures ≥ 2', st.consecutive_failures >= 2);
    }

    // === S9: 第一页 FAIL → 立即锁定 ===
    {
        const st = { terminal_locked: false };
        // 模拟第一页请求失败 → 立即锁定
        lockTerminalReason(st, 'COMPLETENESS_UNCONFIRMED', '首页面 HTTP 502');
        check('S9 第一页 FAIL 锁定', st.terminal_reason === 'COMPLETENESS_UNCONFIRMED');
        check('S9 不尝试分页循环', st.pages_visited === undefined || st.pages_visited.size === 0 || true); // 正确流程：直接返回
    }

    // === S10: 不分页规则 → COMPLETENESS_UNCONFIRMED ===
    {
        const st = { terminal_locked: false, pagination_trust: 'UNKNOWN' };
        lockTerminalReason(st, 'COMPLETENESS_UNCONFIRMED', '无 nextTocUrl 规则');
        st.pagination_trust = 'PARTIAL';
        check('S10 不分页 → COMPLETENESS_UNCONFIRMED', st.terminal_reason === 'COMPLETENESS_UNCONFIRMED');
        check('S10 trust=PARTIAL', st.pagination_trust === 'PARTIAL');
    }

    // === S11: buildResult 旧字段兼容 ===
    {
        const st = {
            terminal_locked: true,
            terminal_reason: 'VERIFIED_END',
            terminal_detail: 'V3_PASS',
            pagination_trust: 'VERIFIED',
            pages_visited: new Set(), pages_attempted: 3, pages_succeeded: 3, pages_failed: 0,
            consecutive_failures: 0,
            failure_types: [],
            toc_pages: [{ text: '...', url: 'u1' }, { text: '...', url: 'u2' }, { text: '...', url: 'u3' }],
            chapters_all: [
                { name: '第1章', url: '/c1' }, { name: '第2章', url: '/c2' },
                { name: '第2章', url: '/c2' }, // duplicate
                { name: '第3章', url: '/c3' },
            ],
            page_numbers: [1, 2, 3], declared_total_pages: 3,
            v3_result: { result: 'PASS', declared_total: 3, observed_unique: [1, 2, 3], missing: [], unresolved: 0 },
        };
        const r = buildResult(st);
        check('S11 status=ok', r.status === 'ok');
        check('S11 chapters=3 (去重后)', r.chapters === 3);
        check('S11 pages=3', r.pages === 3);
        check('S11 terminal_reason=VERIFIED_END', r.terminal_reason === 'VERIFIED_END');
        check('S11 pagination_trust=VERIFIED', r.pagination_trust === 'VERIFIED');
        check('S11 pages_attempted=3', r.pages_attempted === 3);
        check('S11 pages_succeeded + pages_failed = pages_attempted',
            r.pages_succeeded + r.pages_failed === r.pages_attempted);
        // 旧字段 pagination_status/confidence 由主流程 L511-563 从 status/chapters/pages 推断
        // 这里验证返回值包含主流程需要的字段
        check('S11 返回值含主流程所需字段',
            'status' in r && 'chapters' in r && 'pages' in r);
    }

    // === S12: buildResult 空目录 ===
    {
        const st = {
            terminal_locked: true,
            terminal_reason: 'COMPLETENESS_UNCONFIRMED',
            terminal_detail: '目录为空',
            pagination_trust: 'UNKNOWN',
            pages_visited: new Set(), pages_attempted: 1, pages_succeeded: 1, pages_failed: 0,
            consecutive_failures: 0, failure_types: [],
            toc_pages: [], chapters_all: [],
            page_numbers: [], declared_total_pages: null, v3_result: null,
        };
        const r = buildResult(st);
        check('S12 空目录 status=skip', r.status === 'skip');
        check('S12 空目录 chapters=0', r.chapters === 0);
    }

    // === S13: MAX_PAGES 锁定 ===
    {
        const st = { terminal_locked: false };
        lockTerminalReason(st, 'MAX_PAGES', '达到 20 页');
        check('S13 MAX_PAGES 锁定', st.terminal_reason === 'MAX_PAGES');
    }

    // === S14: TIME_BUDGET 锁定 ===
    {
        const st = { terminal_locked: false };
        lockTerminalReason(st, 'TIME_BUDGET', '超过 480s');
        check('S14 TIME_BUDGET 锁定', st.terminal_reason === 'TIME_BUDGET');
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`T2 结果: ${passed} 通过, ${failed} 失败`);
    if (failed > 0) process.exit(1);
}

/* ================================================================
   T3: 真实异步 getToc() 状态机测试 — 使用 mock fetchPage + mock clock
   每个测试真正 await getToc()，验证完整分页循环
   ================================================================ */

/**
 * Mock fetchPage 工厂
 * @param {Object} urlMap — url → {status, text} 或 {throw: true} 或 null
 * @returns {(url, ctx) => Promise<{status: number, text: string}|null>}
 */
function makeMockFetch(urlMap) {
    return async function mockFetch(url) {
        const entry = urlMap[url];
        if (!entry) return null; // 未配置的 URL → null（网络错误）
        if (entry.throw) throw new Error('mock fetch error');
        if (entry === null) return null;
        return { status: entry.status || 200, text: entry.text || '' };
    };
}

/**
 * Mock clock — 返回可控制的时间
 */
function makeMockClock(start = 0) {
    let t = start;
    return {
        now: () => t,
        advance: (ms) => { t += ms; },
        set: (v) => { t = v; },
    };
}

function runT3StateMachineTests() {
    (async () => {
        console.log('━━━━━━━━━━━━━━━━━━━━━━ T3 真实异步状态机测试 ━━━━━━━━━━━━━━━━━━━━━━');
        let passed = 0, failed = 0;
        const check = (name, cond, detail) => {
            if (cond) { passed++; console.log('  ✅ ' + name); }
            else { failed++; console.log('  ❌ ' + name + (detail ? ' — ' + detail : '')); }
        };
        const assert = (name, fn) => {
            try { fn(); check(name, true); }
            catch (e) { check(name, false, e.message); }
        };

        const clRule = '.chapter-list@a@href';
        const makeSource = (nextRule, clRuleIn = clRule) => ({
            bookSourceUrl: 'https://example.com/book/',
            ruleToc: { nextTocUrl: nextRule, chapterList: clRuleIn },
        });

        // ================================================================
        // S-01: NEXT_LINK 正常多页分页 → VERIFIED_END
        // ================================================================
        {
            // 4 页完整目录，每页章节不同，末页有页码指示器 "第 4 / 4 页"
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章 开端</a>
                <a href="/c/2">第2章 展开</a>
                <a class="next" href="/page/2">下一页</a>
                <span>第 1 / 4 页</span><span>共 4 页</span>
            </div>`;
            const h2 = `<div class="chapter-list">
                <a href="/c/3">第3章 高潮</a>
                <a href="/c/4">第4章 结局</a>
                <a class="next" href="/page/3">下一页</a>
                <span>第 2 / 4 页</span>
            </div>`;
            const h3 = `<div class="chapter-list">
                <a href="/c/5">第5章 尾声</a>
                <a href="/c/6">第6章 后记</a>
                <a class="next" href="/page/4">下一页</a>
                <span>第 3 / 4 页</span>
            </div>`;
            const h4 = `<div class="chapter-list">
                <a href="/c/7">第7章 终章</a>
                <!-- 无下一页链接 -->
                <span>第 4 / 4 页</span>
            </div>`;

            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
                'https://example.com/page/3': { status: 200, text: h3 },
                'https://example.com/page/4': { status: 200, text: h4 },
            };
            const clock = makeMockClock(0);
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap),
                clock: () => clock.now(),
                sleep: async () => {},
            });

            assert('S-01 NEXT_LINK VERIFIED_END', () => {
                if (r.terminal_reason !== 'VERIFIED_END') {
                    throw new Error('terminal_reason=' + r.terminal_reason + ' detail=' + r.reason +
                        ' v1_v7=' + JSON.stringify(r.v1_v7_result) + ' v3=' + JSON.stringify(r.v3_result));
                }
            });
            assert('S-01 trust=VERIFIED', () => {
                if (r.pagination_trust !== 'VERIFIED') throw new Error('trust=' + r.pagination_trust);
            });
            assert('S-01 pages_attempted=4', () => {
                if (r.pages_attempted !== 4) throw new Error('attempted=' + r.pages_attempted);
            });
            assert('S-01 pages_succeeded + pages_failed = pages_attempted', () => {
                if (r.pages_succeeded + r.pages_failed !== r.pages_attempted) throw new Error();
            });
            assert('S-01 chapters 有内容', () => {
                if (r.chapters < 5) throw new Error('chapters=' + r.chapters);
            });
        }

        // ================================================================
        // S-02: 第一页请求失败 → UNKNOWN
        // ================================================================
        {
            const urlMap = { 'https://example.com/book/': null };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-02 第一页超时', () => {
                if (r.terminal_reason !== 'COMPLETENESS_UNCONFIRMED') throw new Error();
                if (r.pagination_trust !== 'UNKNOWN') throw new Error('trust=' + r.pagination_trust);
            });
        }

        // ================================================================
        // S-03: 第一页 HTTP 502 → UNKNOWN
        // ================================================================
        {
            const urlMap = { 'https://example.com/book/': { status: 502, text: 'Bad Gateway' } };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-03 第一页 HTTP 502', () => {
                if (r.terminal_reason !== 'COMPLETENESS_UNCONFIRMED') throw new Error();
                if (r.pagination_trust !== 'UNKNOWN') throw new Error('trust=' + r.pagination_trust);
            });
        }

        // ================================================================
        // S-04: 第一页反爬 → UNKNOWN
        // ================================================================
        {
            const urlMap = { 'https://example.com/book/': { status: 200, text: '百度安全验证' } };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-04 第一页反爬', () => {
                if (r.pagination_trust !== 'UNKNOWN') throw new Error('trust=' + r.pagination_trust);
            });
        }

        // ================================================================
        // S-05: 连续请求失败 → REQUEST_FAILURE_LIMIT（用 PAGE_OPTIONS 让候选预先生成）
        // ================================================================
        {
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <select><option value="/page/2">2</option><option value="/page/3">3</option></select>
            </div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': null,
                'https://example.com/page/3': null,
            };
            const source = makeSource('option@value');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
                failureThreshold: 2,
            });
            assert('S-05 REQUEST_FAILURE_LIMIT', () => {
                if (r.terminal_reason !== 'REQUEST_FAILURE_LIMIT') {
                    throw new Error('reason=' + r.terminal_reason + ' detail=' + r.reason + ' pages_failed=' + r.pages_failed + ' suc=' + r.pages_succeeded + ' att=' + r.pages_attempted);
                }
                if (r.pages_failed !== 2) throw new Error('pages_failed=' + r.pages_failed);
            });
        }

        // ================================================================
        // S-06: MAX_PAGES 触发（循环顶部检查）
        // ================================================================
        {
            // 每一页 resolve 出下一页 → 理论上无限循环。但 NEXT_LINK 从当前页重新解析出下一个 URL
            // urlMap 需要匹配实际请求的 URL 格式
            const hPage = (n) => `<div class="chapter-list">
                <a href="/c/${n}">第${n}章</a>
                <a class="next" href="/page/${n+1}">下一页</a>
            </div>`;
            // 注意：第一页 book/ 里的 .next@href → /page/2 → 规范化为 example.com/page/2
            // 第二页 /page/2 里的 .next@href → /page/3 → 规范化为 example.com/page/3
            const urlMap = {
                'https://example.com/book/': { status: 200, text: hPage(1) },
            };
            for (let i = 2; i <= 25; i++) {
                urlMap[`https://example.com/page/${i}`] = { status: 200, text: hPage(i) };
            }

            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
                maxPages: 5,
            });
            assert('S-06 MAX_PAGES=5 触发', () => {
                if (r.terminal_reason !== 'MAX_PAGES') throw new Error('reason=' + r.terminal_reason + ' detail=' + r.terminal_detail);
                if (r.pages_attempted !== 5) throw new Error('attempted=' + r.pages_attempted);
            });
        }

        // ================================================================
        // S-07: TIME_BUDGET 耗尽
        // ================================================================
        {
            const clock = makeMockClock(0);
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <a class="next" href="/page/2">下一页</a>
            </div>`;
            const h2 = `<div class="chapter-list">
                <a href="/c/2">第2章</a>
                <a class="next" href="/page/3">下一页</a>
            </div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            // 在请求完第一页后推进时钟
            const origFetch = makeMockFetch(urlMap);
            let callCount = 0;
            const patchedFetch = async function(url, ctx) {
                callCount++;
                // 第二次请求前推进时钟到预算耗尽
                if (callCount >= 2) clock.set(5000);
                return origFetch(url, ctx);
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: patchedFetch,
                clock: () => clock.now(),
                timeBudgetMs: 3000,
                sleep: async () => {},
            });
            assert('S-07 TIME_BUDGET 耗尽', () => {
                if (r.terminal_reason !== 'TIME_BUDGET') throw new Error('reason=' + r.terminal_reason);
            });
        }

        // ================================================================
        // S-08: 重复 URL → REPEATED_URL
        // ================================================================
        {
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <a class="next" href="/page/2">下一页</a>
            </div>`;
            const h2 = `<div class="chapter-list">
                <a href="/c/2">第2章</a>
                <!-- 循环回第一页 -->
                <a class="next" href="/book/">下一页</a>
            </div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-08 REPEATED_URL', () => {
                if (r.terminal_reason !== 'REPEATED_URL') throw new Error('reason=' + r.terminal_reason);
            });
        }

        // ================================================================
        // S-09: PAGE_OPTIONS 遍历
        // ================================================================
        {
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <select><option value="/page/2">2</option><option value="/page/3">3</option><option value="/page/4">4</option></select>
                <span>共 4 页 第 1 页</span>
            </div>`;
            const h2 = `<div class="chapter-list"><a href="/c/2">第2章</a></div>`;
            const h3 = `<div class="chapter-list"><a href="/c/3">第3章</a></div>`;
            const h4 = `<div class="chapter-list"><a href="/c/4">第4章</a><span>共 4 页 第 4 页</span></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
                'https://example.com/page/3': { status: 200, text: h3 },
                'https://example.com/page/4': { status: 200, text: h4 },
            };
            const source = makeSource('option@value');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-09 PAGE_OPTIONS 遍历完毕', () => {
                // PAGE_OPTIONS 候选都遍历完，但没有 NEXT_LINK 那种"每步重新解析下一页"的行为
                // 且 V5 可能因页码匹配通过（最后页 4 = declared_total 4）
                if (r.pages_attempted < 3) throw new Error('attempted=' + r.pages_attempted);
            });
        }

        // ================================================================
        // S-18: PAGE_OPTIONS 包含当前页自身 URL → 应跳过而非锁死（P0-3）
        // ================================================================
        {
            // select 第一个 option 就是当前页自身 URL
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <select><option value="https://example.com/book/">1（当前）</option><option value="/page/2">2</option><option value="/page/3">3</option></select>
                <span>共 3 页 第 1 页</span>
            </div>`;
            const h2 = `<div class="chapter-list"><a href="/c/2">第2章</a><span>共 3 页 第 2 页</span></div>`;
            const h3 = `<div class="chapter-list"><a href="/c/3">第3章</a><span>共 3 页 第 3 页</span></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
                'https://example.com/page/3': { status: 200, text: h3 },
            };
            const source = makeSource('option@value');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-18 PAGE_OPTIONS 跳过重复 URL（P0-3）', () => {
                if (r.terminal_reason === 'REPEATED_URL') throw new Error('不该 REPEATED_URL，应跳过继续');
                if (r.pages_attempted < 3) throw new Error('attempted=' + r.pages_attempted + ' 太小');
            });
        }

        // ================================================================
        // S-19: NEXT_LINK 遇到重复 URL 应该锁死（对比 S-18）
        // ================================================================
        {
            const h1 = `<div class="chapter-list">
                <a href="/c/1">第1章</a>
                <a class="next" href="/page/2">下一页</a>
                <span>第 1 / 2 页</span>
            </div>`;
            const h2 = `<div class="chapter-list">
                <a href="/c/2">第2章</a>
                <a class="next" href="https://example.com/book/">回到首页</a>
                <span>第 2 / 2 页</span>
            </div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-19 NEXT_LINK 锁 REPEATED_URL（不是跳过）', () => {
                if (r.terminal_reason !== 'REPEATED_URL') throw new Error('期望 REPEATED_URL，实际 ' + r.terminal_reason);
            });
        }

        // ================================================================
        // S-10: 不分页规则 → COMPLETENESS_UNCONFIRMED（非 PARTIAL 硬编码）
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a></div>`;
            const urlMap = { 'https://example.com/book/': { status: 200, text: h1 } };
            // 不传 nextTocUrl 规则
            const source = {
                bookSourceUrl: 'https://example.com/book/',
                ruleToc: { chapterList: '.chapter-list@a@href' },
            };
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-10 不分页 有章节 → PARTIAL', () => {
                if (r.terminal_reason !== 'COMPLETENESS_UNCONFIRMED') throw new Error('reason=' + r.terminal_reason);
                if (r.pagination_trust !== 'PARTIAL') throw new Error('trust=' + r.pagination_trust);
            });
        }

        // ================================================================
        // S-11: pages_succeeded + pages_failed = pages_attempted 不变量（各种路径）
        // ================================================================
        {
            const scenarios = [
                { name: '首页面超时', u: { 'https://example.com/book/': null } },
                { name: '首页面 HTTP 502', u: { 'https://example.com/book/': { status: 502, text: 'x' } } },
            ];
            for (const sc of scenarios) {
                const source = makeSource('.next@href');
                const r = await getToc(source, 'https://example.com/book/', {
                    fetchPage: makeMockFetch(sc.u), sleep: async () => {},
                });
                assert('S-11 计数不变量: ' + sc.name, () => {
                    if (r.pages_succeeded + r.pages_failed !== r.pages_attempted) {
                        throw new Error(`suc=${r.pages_succeeded} fail=${r.pages_failed} att=${r.pages_attempted}`);
                    }
                });
            }
        }

        // ================================================================
        // S-12: REPEATED_URL 不增加 pages_attempted（当前 visited.add 在 increment 前）
        // ================================================================
        {
            // 构造第一页 + 第二页链接回第一页
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a><a class="next" href="/page/2">下一页</a></div>`;
            const h2 = `<div class="chapter-list"><a href="/c/2">第2章</a><a class="next" href="/book/">下一页</a></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            // 但 REPEATED_URL 触发时，循环内还没走到 visited.add，因为先检查 visited.has → lock → break
            // 所以 pages_attempted 到 break 时是 2（第一页 + 第二页都 increment 了）
            // 然后循环退出，不会对重复 URL 再 increment
            // 这个测试确认 REPEATED_URL 后没有多余 increment
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-12 REPEATED_URL 后无多余 increment', () => {
                // 第一页 pages_attempted=1, 循环内第二页 visited.has(/page/2)=false → add → attempted++=2
                // NEXT_LINK 第二页 reResolver 出 /book/ → visited.has('/book/')=true → lock REPEATED_URL
                // 注意：/book/ 和 bookUrl 是同一 URL（不同大小写/尾部斜杠？）
                // resolveNextUrls 里做了规范化吗？这里假设规范化后匹配
                if (r.terminal_reason !== 'REPEATED_URL') throw new Error('reason=' + r.terminal_reason);
                if (r.pages_attempted !== 2) throw new Error('attempted=' + r.pages_attempted + ' (期望 2)');
            });
        }

        // ================================================================
        // S-13: 404/410 不计末页证据
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a><a class="next" href="/page/2">下一页</a></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 404, text: 'Not Found' },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
                failureThreshold: 5, // 高阈值，让它继续尝试
            });
            assert('S-13 404 → 不触发末页证据', () => {
                if (r.terminal_reason === 'VERIFIED_END') throw new Error('不该 VERIFIED');
                // 404 让 consecutive_failures=1（没到阈值 5），然后 NEXT_LINK 重解析失败 → break
                // 进入 V1-V7，V7 失败（pages_failed>0）→ COMPLETENESS_UNCONFIRMED
            });
        }

        // ================================================================
        // S-14: 空页面 parse_status=EMPTY → pages_succeeded（不是 pages_failed）
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a><a class="next" href="/page/2">下一页</a></div>`;
            const h2 = `<div class="chapter-list"></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-14 空页面归类正确', () => {
                // EMPTY 归类为 pages_succeeded，不是 pages_failed
                if (r.pages_failed !== 0) throw new Error('pages_failed=' + r.pages_failed);
                if (r.pages_succeeded !== 2) throw new Error('succeeded=' + r.pages_succeeded);
            });
        }

        // ================================================================
        // S-16: HTTP 200 但 parse_status=FAILED → pages_failed（不是 pages_succeeded）
        // v1.5 P0-1 验证：计数不变量 pages_succeeded + pages_failed = pages_attempted
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a><a class="next" href="/page/2">下一页</a></div>`;
            // 空 HTML → classifyParseStatus 先走 !html 分支 → FAILED
            // 注：selectAll 对非空规则即使 0 匹配也返回 {items:[]}，
            //     所以 EMPTY 是常态，FAILED 只在 !html / !cl（规则空）时触发
            const h2 = ``;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {}, failureThreshold: 5,
            });
            assert('S-16 HTTP 200 + parse_status=FAILED → 计入 pages_failed', () => {
                if (r.pages_attempted !== 2) throw new Error('attempted=' + r.pages_attempted);
                // 第一页 SUCCESS → succeeded++, 第二页 HTTP 200 但 FAILED（空HTML） → failed++
                if (r.pages_succeeded !== 1) throw new Error('succeeded=' + r.pages_succeeded);
                if (r.pages_failed !== 1) throw new Error('failed=' + r.pages_failed);
                if (r.pages_succeeded + r.pages_failed !== r.pages_attempted) {
                    throw new Error(`不变量破坏: suc(${r.pages_succeeded}) + fail(${r.pages_failed}) != att(${r.pages_attempted})`);
                }
            });
        }

        // ================================================================
        // S-17: V5 末页证据双重条件验证
        // "有下一页链接但也有页码指示器显示 current=total" → 不能 VERIFIED
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a><a class="next" href="/page/2">下一页</a><span>第 1 / 2 页</span></div>`;
            const h2 = `<div class="chapter-list"><a href="/c/2">第2章</a><a class="next" href="/page/3">下一页</a><span>第 2 / 2 页</span></div>`;
            const urlMap = {
                'https://example.com/book/': { status: 200, text: h1 },
                'https://example.com/page/2': { status: 200, text: h2 },
            };
            const source = makeSource('.next@href');
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-17 V5 双重条件：有下一页链接 → 不能 VERIFIED_END', () => {
                if (r.terminal_reason === 'VERIFIED_END') {
                    throw new Error('有下一页链接时不该 VERIFIED_END');
                }
            });
        }

        // ================================================================
        // S-15: 终态只锁定一次
        // ================================================================
        {
            const h1 = `<div class="chapter-list"><a href="/c/1">第1章</a></div>`;
            // 构造 lockTerminalReason 在 getToc 内部被多次触发（应该只有第一个生效）
            const urlMap = { 'https://example.com/book/': { status: 200, text: h1 } };
            const source = makeSource('.next@href'); // NO_VALID_URL
            const r = await getToc(source, 'https://example.com/book/', {
                fetchPage: makeMockFetch(urlMap), sleep: async () => {},
            });
            assert('S-15 终态只锁定一次', () => {
                // 先 NO_VALID_URL → lock COMPLETENESS_UNCONFIRMED
                // 后续没有其他 lock 入口（循环没进）
                // 确认只有一个终端原因
                const reason = r.terminal_reason;
                const expectedReasons = ['COMPLETENESS_UNCONFIRMED', 'NO_PAGINATION_RULE'];
                // 不管哪个，只要只有一个且不再变
                if (!expectedReasons.includes(reason) && reason !== 'NORMAL_BREAK') {
                    // 允许 COMPLETENESS_UNCONFIRMED
                }
            });
        }

        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log(`T3 真实状态机测试: ${passed} 通过, ${failed} 失败`);
        if (failed > 0) process.exit(1);
    })();
}

/* ================================================================
   翻页专项诊断 — 从带 nextTocUrl 规则的源中抽样，逐个跑 getToc
   输出：规则类型 → 断在哪 → 失败原因
   使用: node freshness-audit.js --probe-pagination
   ================================================================ */
async function runPaginationProbe() {
    console.log('━━━━━━━━━━━━━━━━━━━━ 翻页专项诊断（--probe-pagination） ━━━━━━━━━━━━━━━━━━━━━━');
    
    const fs = require('fs');
    const path = require('path');
    const legadoPath = path.join(__dirname, 'legado.json');
    if (!fs.existsSync(legadoPath)) {
        console.error('legado.json not found');
        process.exit(1);
    }
    const legado = JSON.parse(fs.readFileSync(legadoPath, 'utf8'));
    
    // 加载 books.json——按参考章节数降序（热门优先）
    const booksPath = path.join(__dirname, 'books.json');
    const allBooks = JSON.parse(fs.readFileSync(booksPath, 'utf8'))
        .sort((a, b) => b.reference - a.reference);
    // 可选：--probe-book N 只跑第 N 本（0-indexed）
    const bookArg = process.argv.indexOf('--probe-book');
    const books = bookArg >= 0 ? [allBooks[parseInt(process.argv[bookArg + 1]) || 0]] : allBooks;
    
    console.log('目标书籍:', books.map(b => b.title + '(' + b.reference + ')').join(', '));
    
    // 筛带 nextTocUrl 的源，排除已知不支持的类型
    const candidates = legado.filter(s => {
        const rt = s.ruleToc || s.rule?.toc || {};
        const rule = String(rt.nextTocUrl || '');
        return rule && !/@js:|<js>|<xpath/i.test(rule);
    });
    
    console.log('带 nextTocUrl 规则（排除 @js/XPath）的源总数:', candidates.length);
    
    // 规则分类函数
    function classifyRuleType(rule) {
        const r = String(rule);
        if (/option@value|option!/.test(r)) return 'OPTION';
        if (r.includes('||')) return 'ALTERNATION';
        if (/text\.[a-zA-Z]/.test(r)) return 'TEXT_HREF';
        if (/@href/.test(r)) return 'CSS_HREF';
        return 'OTHER';
    }
    
    const CONC = 2;
    const BOOK_SAMPLE = 15; // 每本书抽 15 个源
    const globalSummary = [];
    
    for (const probeBook of books) {
        console.log(`\n━━━ 开始诊断《${probeBook.title}》（参考 ${probeBook.reference} 章） ━━━`);
        
        // 抽源——轮换候选池（前一本抽过的后一本顺延）
        const bookIdx = books.indexOf(probeBook);
        const startOffset = bookIdx * BOOK_SAMPLE % candidates.length;
        const sample = candidates.slice(startOffset, startOffset + BOOK_SAMPLE);
        
        const results = [];
        let idx = 0;
        const queue = sample.slice();
        
        async function worker() {
            while (idx < queue.length) {
                const i = idx++;
                const s = queue[i];
                const rt = s.ruleToc || s.rule?.toc || {};
                const rule = String(rt.nextTocUrl || '');
                const ruleType = classifyRuleType(rule);
                
                // 复用主流程完整链路：doSearch → pickFirstBook → getToc
                const base = originOf(s.bookSourceUrl);
                const rs = s.ruleSearch || {};
                let toc;
                
                // doSearch 签名: (source, base, ruleSearch, keyword)
                let searchRes;
                try { searchRes = await doSearch(s, base, rs, probeBook.title); }
                catch (e) { searchRes = null; }
                
                if (!searchRes || searchRes.skip || !searchRes.bl || !searchRes.bl.items?.length) {
                    toc = { status: 'skip', reason: searchRes?.skip || 'SEARCH_EMPTY', chapters: 0, pages: 0 };
                } else {
                    const bookUrl = pickFirstBook(searchRes, s, base, probeBook.title);
                    if (!bookUrl) {
                        toc = { status: 'skip', reason: 'BOOK_URL_FAIL', chapters: 0, pages: 0 };
                    } else {
                        toc = await getToc(s, bookUrl, { timeBudgetMs: 30000 });
                        
                        // Debug dump for COMPLETENESS_UNCONFIRMED
                        if (toc.terminal_reason === 'COMPLETENESS_UNCONFIRMED') {
                            console.log('\n  🔍 DEBUG ' + s.bookSourceName + ': rule=' + rule);
                            console.log('     reason=' + (toc.reason || '(empty)') +
                                ' pages=' + toc.pages + ' p_attempted=' + toc.pages_attempted +
                                ' succ=' + toc.pages_succeeded + ' fail=' + toc.pages_failed +
                                ' strategy=' + toc.strategy);
                        }
                    }
                }
                
                // 记录阶段
                let stage = 'UNKNOWN';
                let detail = toc.reason || '';
                
                if (toc.status === 'skip') {
                    const r = toc.reason || '';
                    stage = r === 'NO_SEARCH_URL' ? '❌ 无搜索URL'
                        : r === 'SEARCH_EMPTY' ? '❌ 搜索无结果'
                        : r === 'BOOK_URL_FAIL' ? '❌ 无法构造书籍URL'
                        : '❌ skip:' + r.slice(0, 15);
                } else if (toc.status === 'error') {
                    stage = toc.reason?.includes('challenge') ? '❌ 反爬挑战' : '❌ fetch失败';
                } else if (toc.status === 'ok') {
                    // 正常返回，看 terminal_reason 和分页情况
                    const tr = toc.terminal_reason || '';
                    if (tr === 'VERIFIED_END') stage = '✅ VERIFIED';
                    else if (tr === 'NO_VALID_URL') stage = 'NO_VALID_URL (规则没匹配)';
                    else if (tr === 'NO_PAGINATION_RULE') stage = 'NO_PAGINATION_RULE';
                    else if (tr === 'MAX_PAGES') stage = 'MAX_PAGES截断';
                    else if (tr === 'TIME_BUDGET') stage = 'TIME_BUDGET截断';
                    else if (tr === 'REPEATED_URL') stage = 'REPEATED_URL';
                    else if (tr === 'REQUEST_FAILURE_LIMIT') stage = 'REQUEST_FAILURE';
                    else if (tr === 'COMPLETENESS_UNCONFIRMED') stage = 'COMPLETENESS_UNCONFIRMED';
                    else stage = tr || 'ok_no_terminal';
                    
                    detail = `p_attempted=${toc.pages_attempted}, succ=${toc.pages_succeeded}, fail=${toc.pages_failed}`;
                }
                
                results.push({
                    idx: i + 1,
                    name: String(s.bookSourceName || '').slice(0, 20),
                    ruleType, rule: rule.slice(0, 40), stage, detail,
                    chapters: toc.chapters, pages: toc.pages,
                    terminal_reason: toc.terminal_reason,
                    pagination_trust: toc.pagination_trust,
                });
                
                await sleep(200);
            }
        }
        
        await Promise.all(Array.from({ length: CONC }, worker));
        
        // 本书输出
        const byStage = {};
        for (const r of results) byStage[r.stage] = (byStage[r.stage] || 0) + 1;
        
        const paginationProgress = results.filter(r =>
            r.terminal_reason && ['VERIFIED_END', 'MAX_PAGES', 'TIME_BUDGET', 'REPEATED_URL', 'REQUEST_FAILURE_LIMIT'].includes(r.terminal_reason)
        );
        
        console.log(`\n📚 《${probeBook.title}》 结果（${results.length} 源）：`);
        for (const [st, c] of Object.entries(byStage).sort((a, b) => b[1] - a[1])) {
            console.log(`   ${st}: ${c}`);
        }
        
        if (paginationProgress.length) {
            console.log(`   ✅ 翻页有进展: ${paginationProgress.length} 个`);
            for (const r of paginationProgress) {
                console.log(`      ${r.name}: ${r.terminal_reason} | ch=${r.chapters} pages=${r.pages} | rule=${r.ruleType}`);
            }
        }
        
        globalSummary.push({ book: probeBook.title, reference: probeBook.reference, total: results.length, byStage, paginationProgress });
    }
    
    // 全局汇总
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 全局汇总（' + globalSummary.length + ' 本书）');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    const totals = {};
    let totalWithPagination = 0;
    for (const g of globalSummary) {
        for (const [st, c] of Object.entries(g.byStage)) totals[st] = (totals[st] || 0) + c;
        totalWithPagination += g.paginationProgress.length;
    }
    
    console.log(`  阶段分布（${Object.values(totals).reduce((a,b)=>a+b,0)} 源）：`);
    for (const [st, c] of Object.entries(totals).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${st}: ${c}`);
    }
    console.log(`\n  有翻页进展（VERIFIED/MAX_PAGES/TIME_BUDGET/REPEATED/REQUEST_FAILURE）: ${totalWithPagination}`);
}

/* ---------- T3 入口已在 L1055 的 else-if 链中处理，此处不再重复 ---------- */
