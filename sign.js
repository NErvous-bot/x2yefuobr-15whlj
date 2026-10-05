/**
 * sign.js — ECDSA P-256 (SHA256withECDSA) 签名，App端内置公钥验签
 * 用 node 内置 crypto 替代 openssl：不受 runner 镜像 openssl 版本波动影响；
 * 私钥不落盘；签名后立即自验签，失败即 exit 1（防止 0 字节签名被静默提交）。
 */
'use strict';
const fs = require('fs'), crypto = require('crypto');

const b64 = process.env.ED25519_KEY || '';
const pem = Buffer.from(b64, 'base64').toString('utf8');
if (!pem.includes('PRIVATE KEY')) {
  console.error('× ED25519_KEY secret 无效（解码后不含 PEM 私钥）');
  process.exit(1);
}
const key = crypto.createPrivateKey(pem);
let fail = false;
for (const f of ['legado.json', 'replaceRule.json']) {
  const data = fs.readFileSync(f);
  const sig = crypto.createSign('SHA256').update(data).sign(key);
  fs.writeFileSync(f + '.sig', sig.toString('base64'));
  const ok = crypto.createVerify('SHA256').update(data).verify(key, sig);
  console.log((ok ? '√' : '×') + ' ' + f + '.sig：DER ' + sig.length + ' 字节，自验签' + (ok ? '通过' : '失败'));
  if (!ok || sig.length < 8) fail = true;
}
// version.txt：两个成品的内容指纹（md5，各一行，共约70字节）。App 端每天
// 只下载这个小文件做轻量比对，内容没变不拉全量书源。md5 随内容确定，
// 健康检查等无关提交不会误触发；App 拿不到指纹时自动回退全量下载。
const md5hex = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex');
fs.writeFileSync('version.txt', md5hex('legado.json') + '\n' + md5hex('replaceRule.json') + '\n');
console.log('√ version.txt：内容指纹已生成（legado ' + md5hex('legado.json').slice(0, 8) + '…）');
process.exit(fail ? 1 : 0);
