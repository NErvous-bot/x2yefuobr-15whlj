// zjread（纸间）源专属探针 —— 该源为全加密API规则（@js:），静态测试器无法覆盖，
// 此脚本按其真实协议实测：会话协商→搜索→目录→验证码→正文，判断源是否仍然存活。
// 2026-10-09 协议升级适配：challenge 新增 codeChallenge(SVG图片码, <text>明文)，
// verify 请求改为 {payload: b64(JSON({challenge,solution})), code: 图片码答案}。
// 纯诊断：结果写 reports/zj-probe.json + GITHUB_STEP_SUMMARY，任何异常 exit 0 不阻塞发布。
const fs = require("fs");
const crypto = require("node:crypto");

const BASE = "https://www.zjread.cc";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const b64 = (b) => Buffer.from(b).toString("base64");
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64");
const hmac = (k, m) => crypto.createHmac("sha256", k).update(m).digest();
const sha256hex = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// 服务端实际密钥派生方向（2026-10-08 实测确认）：PRK = HMAC(key=sid, msg=key_material)
const derive = (km, sid, info, len = 32) => Buffer.from(crypto.hkdfSync("sha256", km, sid, info, len));
// SVG 图片码答案提取：<text> 明文字符按 x 排序拼接（服务端 SVG 未做字符转形状，可全自动）
const svgCode = (cc) => {
  try {
    const dataUri = String((cc && cc.image) || "");
    const b64part = dataUri.indexOf(",") >= 0 ? dataUri.substring(dataUri.indexOf(",") + 1) : dataUri;
    const svg = Buffer.from(b64part, "base64").toString("utf8");
    const chars = [];
    const re = /<text x="(\d+)"[^>]*>([^<]*)<\/text>/g;
    let m;
    while ((m = re.exec(svg))) chars.push([Number(m[1]), m[2]]);
    chars.sort((a, b) => a[0] - b[0]);
    return chars.map((c) => c[1]).join("");
  } catch (e) { return ""; }
};

const stages = {};
async function main() {
  const get = async (p) => (await fetch(BASE + p, { headers: { "User-Agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15000) })).json();

  stages["会话协商"] = "run";
  const boot = await get("/api/bootstrap");
  const sid = String(boot.data.session_id);
  const km = unb64(boot.data.key_material);
  const aesKey = derive(km, Buffer.from(sid), "novel-api-aes-v1");
  const hmacKey = derive(km, Buffer.from(sid), "novel-hmac-v1");
  stages["会话协商"] = "ok";

  const call = async (path, params, meta) => {
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
    const enc = Buffer.concat([c.update(JSON.stringify(params), "utf8"), c.final(), c.getAuthTag()]);
    const body = JSON.stringify({ version: 1, algorithm: "AES-256-GCM", data: b64(enc), nonce: b64(nonce) });
    const ts = String(Math.floor(Date.now() / 1000));
    const xn = b64u(crypto.randomBytes(18));
    const sig = hmac(hmacKey, ["POST", path, ts, xn, sha256hex(body), sid].join("\n"));
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA, "X-Session-ID": sid, "X-Timestamp": ts, "X-Nonce": xn, "X-Signature": b64(sig), "X-Key-Version": "1" },
      body, signal: AbortSignal.timeout(15000),
    });
    const resp = JSON.parse(await r.text());
    if (resp.code !== 0) throw new Error("code=" + resp.code + " " + (resp.message || ""));
    const n2 = unb64(resp.nonce), d2 = unb64(resp.data);
    let key = aesKey;
    if (resp.key_mode === "chapter") {
      const info = Buffer.concat([Buffer.from([meta.bid, meta.cid, String(resp.version || 1)].join("\n"), "utf8"), n2]);
      key = Buffer.from(crypto.hkdfSync("sha256", km, info, "novel-chapter-aes-v1", 32));
    }
    const tag = d2.subarray(d2.length - 16), ct = d2.subarray(0, d2.length - 16);
    const dec = crypto.createDecipheriv("aes-256-gcm", key, n2);
    dec.setAuthTag(tag);
    return JSON.parse(Buffer.concat([dec.update(ct), dec.final()]).toString("utf8"));
  };

  stages["搜索"] = "run";
  const s = await call("/api/search", { keyword: "凡人", page: 1 });
  const arr = Array.isArray(s.data) ? s.data : s.data?.list || [];
  if (!arr.length) throw new Error("搜索无结果");
  stages["搜索"] = "ok(" + arr.length + "条)";

  stages["目录"] = "run";
  const bid = String(arr[0].id || arr[0].book_id);
  const cat = await call("/api/book/catalog", { book_id: bid });
  const chs = Array.isArray(cat.data) ? cat.data : cat.data?.list || [];
  if (!chs.length) throw new Error("目录为空");
  stages["目录"] = "ok(" + chs.length + "章)";

  stages["验证码"] = "run";
  const cid = String(chs[Math.floor(chs.length / 2)].id || chs[Math.floor(chs.length / 2)].chapter_id);
  const ch = await get("/api/captcha/altcha/challenge");
  const p = ch.data || ch;
  let counter = 0, dk = "";
  const prefix = String(p.parameters.keyPrefix).toLowerCase();
  for (let i = 0; i <= 200000; i++) {
    const cx = ((i >>> 24) & 255).toString(16).padStart(2, "0") + ((i >>> 16) & 255).toString(16).padStart(2, "0") + ((i >>> 8) & 255).toString(16).padStart(2, "0") + (i & 255).toString(16).padStart(2, "0");
    let u = crypto.createHash("sha256").update(Buffer.from(p.parameters.salt + p.parameters.nonce + cx, "hex")).digest("hex");
    for (let j = 1; j < (p.parameters.cost >= 1 ? p.parameters.cost : 1); j++) u = crypto.createHash("sha256").update(Buffer.from(u, "hex")).digest("hex");
    if (u.startsWith(prefix)) { counter = i; dk = u.slice(0, p.parameters.keyLength * 2); break; }
  }
  if (!dk) throw new Error("ALTCHA 20万次内未解出");
  const code = svgCode(p.codeChallenge);
  const payload = b64(Buffer.from(JSON.stringify({ challenge: ch, solution: { counter, derivedKey: dk, time: 1 } }), "utf8"));
  const vBody = code ? { payload, code } : { payload };
  const vt = await call("/api/captcha/altcha/verify", vBody);
  const token = (vt.data || vt).captcha_token;
  if (!token) throw new Error("未返回captcha_token");
  stages["验证码"] = "ok(图片码" + code.length + "位)";

  stages["正文"] = "run";
  // 多位置采样：部分书（尤合集类）大量章节正文为空，前/中/后多点取样避免误判
  let paras = [];
  const tryIdx = [...new Set([0.08, 0.3, 0.5, 0.7].map(f => Math.floor(chs.length * f)))];
  for (const off of tryIdx) {
    const cxx = String(chs[off].id || chs[off].chapter_id);
    const ct2 = await call("/api/book/content", { chapter_id: cxx, captcha_token: token }, { bid, cid: cxx });
    paras = ((ct2.data || ct2).paragraphs || []).map((o) => (typeof o === "object" ? (o.text ?? "") : String(o))).filter(Boolean);
    if (paras.length) break;
  }
  if (!paras.length) throw new Error("正文为空(采样" + tryIdx.length + "章均无内容)");
  stages["正文"] = "ok(" + paras.length + "段)";

  return true;
}

(async () => {
  const out = { checkedAt: new Date().toISOString(), ok: false, stages, message: "" };
  try {
    await main();
    out.ok = true;
    out.message = "全部通过";
    console.log("✓ zjread（纸间）源探针正常：" + Object.entries(stages).map(([k, v]) => k + v).join("，"));
  } catch (e) {
    for (const k of Object.keys(stages)) if (stages[k] === "run") { stages[k] = "FAIL"; out.message = "死亡于[" + k + "]阶段: " + e.message; break; }
    console.log("✗ zjread（纸间）源探针失败：" + out.message);
  }
  const line = out.ok ? "✅ zjread（纸间）探针正常，源存活（" + Object.entries(stages).map(([k, v]) => k + v).join("，") + "）" : "🚨 zjread（纸间）源疑似死亡 —— " + out.message;
  console.log(line);
  try { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + "\n"); } catch (e) {}
  try { fs.mkdirSync("reports", { recursive: true }); fs.writeFileSync("reports/zj-probe.json", JSON.stringify(out, null, 2)); } catch (e) { console.log("写入reports失败(忽略):" + e.message); }
  process.exit(0); // 纯诊断，绝不阻塞发布
})();
