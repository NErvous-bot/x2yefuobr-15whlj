/**
 * verify-sign.js — 只验签、不改任何文件。
 *
 * 用途：作为「push 之后」的独立检查关。update.yml 的签名步骤虽然自验签，
 * 但如果有人手工改 legado.json / replaceRule.json 绕过签名流程，仓库里就会
 * 长期存在「App 全部验签失败」而 CI 全绿的假安全状态。这一关把该状态直接标红。
 *
 * 公钥与 App 内置 PUB_B64（SyncWorker.java）完全一致。
 */
'use strict';
const fs = require('fs'), crypto = require('crypto');

const APP_PUB_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYJwAmT/ACOVylm2nMFauKPsuFG6lAxXm9Vqe1ztgalp3udP0JgsZjLC3velPRa9YBq+8xdexXD4DfQae8kOKQg==';
const pub = crypto.createPublicKey({
  key: Buffer.from(APP_PUB_B64, 'base64'),
  format: 'der',
  type: 'spki',
});

const md5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
let fail = false;

for (const f of ['legado.json', 'replaceRule.json']) {
  const sigPath = f + '.sig';
  if (!fs.existsSync(f)) {
    console.error('× 缺少成品文件 ' + f);
    fail = true;
    continue;
  }
  if (!fs.existsSync(sigPath)) {
    console.error('× 缺少签名文件 ' + sigPath + '（手机端会拒绝该文件）');
    fail = true;
    continue;
  }
  let ok = false, sigLen = 0;
  try {
    const sig = Buffer.from(fs.readFileSync(sigPath, 'utf8').trim(), 'base64');
    sigLen = sig.length;
    ok = sig.length > 8 && crypto.verify('SHA256', fs.readFileSync(f), pub, sig);
    if (!ok) console.error('× ' + sigPath + ' 签名不符（内容被改过，或签名不是这对密钥签的）');
  } catch (e) {
    console.error('× ' + sigPath + ' 验签异常：' + e.message);
  }
  console.log((ok ? '√ ' : '× ') + f + '.sig ' + sigLen + ' 字节，验签' + (ok ? '通过' : '失败'));
  if (!ok) fail = true;
}

// version.txt 必须与成品内容一致，否则手机端每天比对指纹都会误判「无更新」
if (!fs.existsSync('version.txt')) {
  console.error('× 缺少 version.txt（手机端会退化为每天全量下载）');
  fail = true;
} else {
  const want = md5('legado.json') + '\n' + md5('replaceRule.json');
  const got = fs.readFileSync('version.txt', 'utf8').trim();
  const same = got === want;
  console.log((same ? '√ ' : '× ') + 'version.txt 与成品内容' + (same ? '一致' : '不一致（手机端会漏掉本次更新）'));
  if (!same) fail = true;
}

process.exit(fail ? 1 : 0);
