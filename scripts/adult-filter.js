'use strict';
/**
 * 成人向判定（公开仓库必须排除）。
 *
 * 设计原则：宁可漏判（交给后续人工）也不要误伤。
 * 实测教训：宽口径把「🏷 起点小说」判成成人向——因为名字里的「欲」被
 * 正则 /欲/ 命中。所以不能用单字，必须用「明确指向成人站」的证据。
 *
 * 三层判据，命中任一即排除：
 *   1) 域名黑名单（成人站固定域名，最可靠）
 *   2) 名称中的明确成人词（多字词，避免单字误伤）
 *   3) 分组/注释里的明确成人标记
 *
 * 用法：const { isAdult } = require('./adult-filter');  if (isAdult(s)) skip;
 */

// 成人站域名特征（子串匹配主机名）
const ADULT_HOSTS = [
    'po18',          // PO18 系列（po18bl / po18vip / po18m / mpo18 ...）
    'popo.tw',       // POPO 原创市集
    'sadfuns',       // 废文
    'haitang',       // 海棠（注意：haitangshuwu.info 是普通书屋，见下方白名单）
    'rouwen',        // 肉文屋
    'rourou',        // 肉肉屋
    'yuwangshe',     // 欲望社
    'yswnovel',      // 新御书屋
    'mpo18',
    'pixiv',         // 插画站，多数书源抓的是成人向小说
    'longfuxs',      // 黑暗小说网
    '18shuku',
    'gb84',          // 18文学
];

// 明确成人词（多字，避免单字误伤）
const ADULT_WORDS = [
    'po18', 'popo', '腐小说', '小黄书', '肉肉屋', '肉文', '成人小说', '成人文学',
    '18禁', '18文学', '情色', '色情', '黄文', '黄书', '废文', '海棠文学',
    '御书屋', '欲望社', '黑岩', '里番', '福利姬', '啪文', '撸文',
];

// 已知的反例（名字含成人词但实为普通站）
const ADULT_WHITELIST = [
    'haitangshuwu',   // 海棠书屋 = 普通小说站
];

function hostOf(u) {
    try {
        return new URL(String(u).replace(/#.*$/, '')).host.toLowerCase();
    } catch (e) {
        return '';
    }
}

function isAdult(s) {
    if (!s) return false;
    const host = hostOf(s.bookSourceUrl);
    if (host && !ADULT_WHITELIST.some((w) => host.includes(w))) {
        if (ADULT_HOSTS.some((h) => host.includes(h))) return true;
    }
    const blob = [
        s.bookSourceName || '',
        s.bookSourceGroup || '',
        s.bookSourceComment || '',
    ].join(' ');
    const low = blob.toLowerCase();
    return ADULT_WORDS.some((w) => low.includes(w));
}

module.exports = { isAdult, ADULT_HOSTS, ADULT_WORDS, ADULT_WHITELIST };
