package io.nervous.sourcesync;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.URI;
import java.net.URL;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

/**
 * Sync worker: fetch book source JSON from GitHub, then write into
 * Legado reader app via its ContentProvider (batched inserts).
 *
 * v3.6：
 *  - 全部下载改为字节级处理并验签原始字节（彻底排除任何转码差异）；
 *  - 请求追加随机 cb 参数穿透代理/CDN 缓存——带缓存的 WiFi 代理曾把
 *    旧版 json 和新签名混搭发给 App 导致验签失败，现在每次强制回源；
 *  - 全程 setProgressAsync 上报进度（界面实时显示当前第几条线路）。
 *
 * v3.15：
 *  - 每天自动检查：先下载约70字节内容指纹（version.txt，书源+规则两个 md5），
 *    内容没变当天不下载全量书源（无更新只刷新状态行，不发通知）；
 *  - 数量兜底：新书源数少于上次一半视为仓库数据异常，拒绝导入保护书架。
 *
 * v5.0（纯减法，架构：GitHub 决策，APK 交付，阅读使用）：
 *  - 删除本地健康层（60源域名探针/按探测结果改写 enabled/health.json 缓存）：
 *    健康裁决全部在 GitHub 端 fuse/health/score 完成；真机实测该层在 vivo 深链
 *    路径上从不执行，属死代码；
 *  - 新增书源 12 项 / 规则 4 项 JSON 结构校验，畸形数据拒绝导入（深链路径同样受保护）；
 *  - 文案如实：深链只代表「已唤起阅读」，导入需用户在手机上点「确认」，不宣称自动完成。
 */
public class SyncWorker extends Worker {

    /** 仓库地址逐字符 ^ 0x5A 存储，防 dex 字符串直搜（运行时解码） */
    private static final int[] REPO_ENC = {
            20, 31, 40, 44, 53, 47, 41, 119, 56, 53, 46, 117, 34, 104,
            35, 63, 60, 47, 53, 56, 40, 119, 107, 111, 45, 50, 54, 48
    };

    /**
     * EC P-256 公钥（X509 SPKI, base64）。私钥只在仓库 Actions 的 Secrets 里。
     * 注意：不用 Ed25519——部分 Android 13 机型的 Ed25519 KeyFactory 无法从
     * X.509 编码导入公钥（抛 InvalidKeySpecException），ECDSA 全版本原生支持。
     */
    private static final String PUB_B64 =
            "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEYJwAmT/ACOVylm2nMFauKPsuFG6lAxXm9Vqe1ztgalp3udP0JgsZjLC3velPRa9YBq+8xdexXD4DfQae8kOKQg==";

    private static final String GH_RAW = "https://raw.githubusercontent.com/";
    private static final String GH_JSD = "https://cdn.jsdelivr.net/gh/";

    private static String[] anchorUrls(String repo) {
        return new String[]{
                GH_RAW + repo + "/main/urls.txt",
                GH_JSD + repo + "@main/urls.txt",
                "https://ghproxy.net/" + GH_RAW + repo + "/main/urls.txt"
        };
    }

    private static String[] defaultLines(String repo) {
        return new String[]{
                "https://ghproxy.net/" + GH_RAW + repo + "/main/legado.json",
                "https://ghfast.top/" + GH_RAW + repo + "/main/legado.json",
                "https://gh-proxy.com/" + GH_RAW + repo + "/main/legado.json",
                GH_JSD + repo + "@main/legado.json",
                GH_RAW + repo + "/main/legado.json"
        };
    }

    private static final int BATCH = 80;

    /** 接口诊断信息（探针失败时写进结果，用户截图即可远程定位） */
    private String authorityDiag = "";

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    private void prog(String msg) {
        try { setProgressAsync(new androidx.work.Data.Builder().putString("msg", msg).build()); }
        catch (Exception ignored) {}
    }

    /**
     * 发现并验证阅读App的 ReaderProvider authority（依据官方源码实测）：
     *  - authority = 包名 + ".readerProvider"，随包名动态注册；
     *  - 路由 bookSources/query 是天然存活探针：路由匹配即返回非空 cursor，
     *    不匹配/接口不存在则返回 null 或抛异常——据此区分真假接口；
     *  - 官方 ReaderProvider.match 失败时 insert 静默返回 null，从不抛
     *    Unknown URL——该异常只会来自「authority 根本没注册」，即当时
     *    手机上装的阅读版不含此接口。
     */
    private String resolveAuthority() {
        List<String> cands = new ArrayList<>();
        try {
            android.content.pm.PackageManager pm = getApplicationContext().getPackageManager();
            for (android.content.pm.PackageInfo p : pm.getInstalledPackages(
                    android.content.pm.PackageManager.GET_PROVIDERS)) {
                if (p.providers == null) continue;
                for (android.content.pm.ProviderInfo pi : p.providers) {
                    if (pi.authority == null) continue;
                    for (String a : pi.authority.split(";")) {
                        if (a.endsWith(".readerProvider") && !cands.contains(a)) cands.add(a);
                    }
                }
            }
        } catch (Exception ignored) {}
        // 兜底硬编码（覆盖官方 release/releaseA 与旧 io. 前缀版）
        for (String h : new String[]{
                "com.legado.app.release.readerProvider",
                "io.legado.app.release.readerProvider",
                "com.legado.app.releaseA.readerProvider"}) {
            if (!cands.contains(h)) cands.add(h);
        }
        for (String a : cands) {
            try {
                android.database.Cursor c = getApplicationContext().getContentResolver()
                        .query(Uri.parse("content://" + a + "/bookSources/query?url=_probe"),
                                null, null, null, null);
                if (c != null) {
                    c.close();
                    prog("已定位阅读App接口：" + a);
                    return a;
                }
                authorityDiag += a + "=无响应 ";
            } catch (Exception e) {
                authorityDiag += a + "=" + e.getClass().getSimpleName() + " ";
                android.util.Log.w("SyncWorker", "接口探针失败 " + a + ": " + e.getMessage());
            }
        }
        return null;
    }

    /**
     * 唤起阅读App的官方在线导入入口（OnLineImportActivity，源码注释原文：
     * 「格式: legado://import/{path}?src={url}」）。
     * kind = bookSource / replaceRule，阅读App 自己下载并导入。
     * 真机实测（含 vivo）：必定拉起阅读并弹出导入确认框，需用户点「确认」——
     * 不存在无确认的静默导入路径。本方法返回 true 只代表「已成功唤起」，
     * 不代表导入已完成（阅读无跨进程回执，App 无法确认结果）。
     * 手动同步（本App在前台）必唤起成功；后台定时同步若被系统拦截，返回 false
     * 并在结果里引导用户点「立即同步」。
     */
    private boolean fireOnlineImport(String kind, String url) {
        try {
            android.content.Intent it = new android.content.Intent(android.content.Intent.ACTION_VIEW);
            it.setData(Uri.parse("legado://import/" + kind + "?src="
                    + java.net.URLEncoder.encode(url, "UTF-8")));
            it.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getApplicationContext().startActivity(it);
            return true;
        } catch (Exception e) {
            android.util.Log.w("SyncWorker", "唤起导入失败: " + e.getMessage());
            return false;
        }
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();

        // 0) v3.15 起每天自动检查：先做轻量指纹探测（约70字节的 version.txt，
        //    内容为书源+规则两个 md5）。两个 md5 都与本地一致 → 当天到此为止
        //    （只刷新「上次」状态行，不发通知不下载全量）；探测失败且 7 天内
        //    有成功记录 → 多为瞬时网络问题，交给 WorkManager 退避重试；
        //    连续 7 天没检查成功、指纹有变化（有更新）、或手动「立即同步」
        //    → 走全量下载写入
        if (!"manual".equals(getInputData().getString("mode"))) {
            android.content.SharedPreferences sp0 = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE);
            long lastOk = sp0.getLong("lastOk", 0);
            boolean stale = System.currentTimeMillis() - lastOk > 7L * 24 * 3600 * 1000;
            prog("正在检查是否有更新…");
            String[] fp = fetchFingerprint(decodeRepo());
            if (fp != null && fp[0].equals(sp0.getString("fpJson", null))
                    && fp[1].equals(sp0.getString("fpRules", null))) {
                sp0.edit().putLong("lastOk", System.currentTimeMillis()).apply();
                saveQuiet("今日检查：无更新，书源已是最新");
                return Result.success();
            }
            if (fp == null && !stale) {
                saveQuiet("今日检查失败（网络），稍后自动重试");
                return Result.retry();
            }
            // 指纹有变化（有更新）或连续7天没检查成功：继续全量流程
        }

        // 1) 刷新镜像名单
        prog("正在刷新镜像名单…");
        List<String> lines = refreshLines();

        // 2) 下载书源（逐线路「下载+验签」双确认，验签不过=线路不可信，换线）
        StringBuilder err = new StringBuilder();
        String json = fetchVerified("legado.json", lines, err);
        if (json == null) {
            done(false, "失败：" + err + "，稍后自动重试");
            return Result.retry();
        }

        // 3) 内容没变就跳过写入（省电）；顺带同步规则并记录内容指纹
        //    （走到这里多半是规则单独更新，或镜像指纹瞬时不一致）
        File cache = new File(getApplicationContext().getFilesDir(), "last.json");
        if (cache.exists() && md5(cache).equals(md5(json))) {
            String ruleMsg = syncRules(lines);
            saveFingerprints(md5(json));
            ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
                    .edit().putLong("lastOk", System.currentTimeMillis()).apply();
            done(true, "书源无变化，跳过写入｜" + ruleMsg);
            return Result.success();
        }

        // 3.5) v5.0 结构校验：12 项检查任一不过即拒绝本轮导入（确定性坏数据不重试）。
        //      位于接口探针/深链分支之前，provider 写入与深链兜底两条路径都受保护。
        JSONArray all;
        int total;
        try {
            all = new JSONArray(json);
        } catch (Exception e) {
            done(false, "书源数据异常（解析失败），已跳过本次更新");
            return Result.success();
        }
        int oldCount = 0;
        if (cache.exists()) {
            try { oldCount = new JSONArray(readFile(cache)).length(); } catch (Exception ignored) {}
        }
        String vmsg = validateBookSources(all, oldCount);
        if (vmsg != null) {
            done(false, "书源结构异常，已拒绝本次更新保护书架：" + vmsg);
            return Result.success();
        }
        total = all.length();

        // 4) 发现并验证阅读App接口（探针通过才写入）
        String authority = resolveAuthority();
        if (authority == null) {
            // 兜底：唤起阅读App官方在线导入（legado://import/bookSource 深链，
            // 阅读App 自己下载并弹出确认框，用户点确认后导入）
            String src = defaultLines(decodeRepo())[0] + "?cb=" + System.currentTimeMillis();
            boolean fired = fireOnlineImport("bookSource", src);
            if (fired) {
                writeFile(cache, json);
                String ruleMsg = syncRules(lines);
                saveFingerprints(md5(json));
                done(true, "接口探针全不通过（" + authorityDiag.trim()
                        + "），已唤起阅读导入，请在手机上点「确认」｜" + ruleMsg);
            } else {
                done(false, "失败：未找到阅读App，请先安装阅读App再同步｜" + authorityDiag.trim());
            }
            return Result.success();
        }
        try {
            prog("验签通过，正在写入阅读App…");
            // 官方路由表（源码实测）：书源批量写入 = bookSources/insert，body 键名 json
            Uri uri = Uri.parse("content://" + authority + "/bookSources/insert");
            int finalTotal = total;
            for (int i = 0; i < finalTotal; i += BATCH) {
                JSONArray part = new JSONArray();
                for (int j = i; j < Math.min(i + BATCH, finalTotal); j++) {
                    part.put(all.get(j));
                }
                ContentValues v = new ContentValues();
                v.put("json", part.toString());
                getApplicationContext().getContentResolver().insert(uri, v);
                prog("正在写入书源 " + Math.min(i + BATCH, finalTotal) + "/" + finalTotal + "…");
            }
            OutputStream os = new FileOutputStream(cache);
            os.write(json.getBytes("UTF-8"));
            os.close();
            String ruleMsg = syncRules(lines);
            saveFingerprints(md5(json));
            ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
                    .edit().putLong("lastOk", System.currentTimeMillis()).apply();
            done(true, "成功：已写入" + finalTotal + "个书源｜" + ruleMsg);
            return Result.success();
        } catch (Exception e) {
            // provider 写入中途失败（版本差异/权限拦截）：唤起官方在线导入兜底
            String src = defaultLines(decodeRepo())[0] + "?cb=" + System.currentTimeMillis();
            boolean fired = fireOnlineImport("bookSource", src);
            String m = e.getMessage();
            done(fired,
                    (fired ? "写入异常，已唤起阅读导入，请在手机上点「确认」，原因：" : "失败：")
                            + (m == null ? e.getClass().getSimpleName() : m));
            return Result.success();
        }
    }

    /**
     * 带 Ed25519 验签的下载：对每条线路，同时取「文件 + 文件.sig」，
     * 验签通过才返回内容；任何一环失败都换下一条线路（fail closed）。
     * 请求带随机 cb 参数穿透代理/CDN 缓存，保证 body 与 sig 来自同一
     * 份回源数据，杜绝「旧内容配新签名」的缓存错位。
     */
    private String fetchVerified(String fileName, List<String> lines, StringBuilder err) {
        int total = lines.size(), fail = 0;
        String lastWhy = "";
        for (int i = 0; i < total; i++) {
            String url = lines.get(i).replace("legado.json", fileName);
            String host = hostOf(url);
            prog("正在尝试线路 " + (i + 1) + "/" + total + "：" + host.trim());
            String cb = (url.contains("?") ? "&" : "?") + "cb=" + System.currentTimeMillis();
            byte[] body = fetchBytes(url + cb);
            if (body == null) { fail++; lastWhy = host.trim() + " 下载失败"; continue; }
            byte[] sigB = fetchBytes(url + ".sig" + cb);
            if (sigB == null) { fail++; lastWhy = host.trim() + " 无签名"; continue; }
            String vr = verify(body, new String(sigB, java.nio.charset.StandardCharsets.UTF_8).trim());
            if (vr == null) return new String(body, java.nio.charset.StandardCharsets.UTF_8);
            fail++; lastWhy = host.trim() + " " + vr;
        }
        err.append(fail).append("/").append(total).append("条线路不可信，末次：").append(lastWhy);
        return null;
    }

    /**
     * 验证 ECDSA P-256 签名（签名 = openssl dgst -sha256 -sign 输出的 DER 编码
     * 的 base64，与 Java「SHA256withECDSA」格式一致）。
     * 直接对下载的原始字节验签，不做任何字符串转码。
     * @return null=通过；其他=失败原因
     */
    private String verify(byte[] content, String sigB64) {
        try {
            byte[] pub = Base64.getDecoder().decode(PUB_B64);
            PublicKey pk = KeyFactory.getInstance("EC")
                    .generatePublic(new X509EncodedKeySpec(pub));
            Signature sg = Signature.getInstance("SHA256withECDSA");
            sg.initVerify(pk);
            sg.update(content);
            if (sg.verify(Base64.getDecoder().decode(sigB64))) return null;
            return "签名不符";
        } catch (Exception e) {
            return "验签异常:" + e.getClass().getSimpleName();
        }
    }

    private String hostOf(String url) {
        try { return new URL(url).getHost() + " "; }
        catch (Exception e) { return "? "; }
    }

    /**
     * 同步全局净化规则。官方 ReaderProvider 路由表（源码实测）只有
     * 书源/rss/书籍三类路由，【没有】净化规则路由——之前用 provider 写
     * 规则的路从来不存在。v3.13 起规则变化时唤起阅读App官方在线导入
     * 深链（legado://import/replaceRule），阅读App 自行下载并自动导入。
     * 失败只汇报，不影响书源同步。
     */
    private String syncRules(List<String> lines) {
        try {
            StringBuilder err = new StringBuilder();
            String rjson = fetchVerified("replaceRule.json", lines, err);
            if (rjson == null) return "规则未同步：" + err;

            // v5.0 规则结构校验（先于唤起导入，畸形规则不投递）
            String rv = validateReplaceRules(rjson);
            if (rv != null) return "规则未同步：结构异常（" + rv + "）";

            File rcache = new File(getApplicationContext().getFilesDir(), "last_rules.json");
            if (rcache.exists() && md5(rcache).equals(md5(rjson))) {
                return "规则无变化";
            }

            String src = defaultLines(decodeRepo())[0].replace("legado.json", "replaceRule.json")
                    + "?cb=" + System.currentTimeMillis();
            boolean fired = fireOnlineImport("replaceRule", src);
            if (!fired) {
                // 后台同步时系统拦截界面启动——引导用户手动同步（前台必唤起）
                return "规则有更新：请打开本App点「立即同步」并在手机上确认";
            }
            OutputStream os = new FileOutputStream(rcache);
            os.write(rjson.getBytes("UTF-8"));
            os.close();
            return "规则更新：已唤起阅读导入，请在手机上点「确认」";
        } catch (Exception e) {
            return "规则未同步：异常";
        }
    }

    /** 刷新下载线路：云端拉 urls.txt → 成功则缓存并返回新名单；失败则用本地缓存；再退内置兜底。 */
    private List<String> refreshLines() {
        String repo = decodeRepo();
        File cache = new File(getApplicationContext().getFilesDir(), "lines.txt");
        List<String> current = parseLines(readFile(cache));
        if (current.isEmpty()) current = toList(defaultLines(repo));
        for (String a : anchorUrls(repo)) {
            String txt = fetch(a);
            if (txt == null) continue;
            List<String> fresh = parseLines(txt);
            if (fresh.size() >= 3) {              // 名单至少3条才算有效
                if (!fresh.equals(current)) writeFile(cache, txt);
                return fresh;
            }
        }
        return current;
    }

    /**
     * 轻量版本探测：下载 version.txt（两行 md5 内容指纹，约70字节，CI 签名时
     * 生成）。md5 随内容确定——健康检查等无关提交不会误触发全量下载。
     * 逐线路尝试直到拿到合法指纹；全部失败返回 null（调用方按「不确定」处理）。
     */
    private String[] fetchFingerprint(String repo) {
        for (String base : defaultLines(repo)) {
            String txt = fetch(base.replace("legado.json", "version.txt")
                    + "?cb=" + System.currentTimeMillis());
            if (txt == null) continue;
            String[] ps = txt.trim().split("\\s+");
            if (ps.length == 2 && ps[0].matches("[0-9a-f]{32}")
                    && ps[1].matches("[0-9a-f]{32}")) return ps;
        }
        return null;
    }

    /** 记录本地已确认的内容指纹：书源取刚处理完的内容 md5；规则取本地规则
     *  缓存（缓存只在规则内容成功拉取后才写入，天然代表「已拿到最新」）。 */
    private void saveFingerprints(String jsonMd5) {
        try {
            android.content.SharedPreferences sp =
                    getApplicationContext().getSharedPreferences("sync", Context.MODE_PRIVATE);
            sp.edit().putString("fpJson", jsonMd5).apply();
            File rcache = new File(getApplicationContext().getFilesDir(), "last_rules.json");
            if (rcache.exists()) sp.edit().putString("fpRules", md5(rcache)).apply();
        } catch (Exception ignored) {}
    }

    /** 运行时解码仓库地址 */
    private static String decodeRepo() {
        StringBuilder sb = new StringBuilder();
        for (int c : REPO_ENC) sb.append((char) (c ^ 0x5A));
        return sb.toString();
    }

    /** 解析名单文本：只接受 https:// 且指向 legado.json 的行。 */
    private List<String> parseLines(String txt) {
        List<String> out = new ArrayList<>();
        if (txt == null) return out;
        for (String s : txt.split("\n")) {
            s = s.trim();
            if (!s.isEmpty() && !s.startsWith("#") && s.contains("legado.json")
                    && s.startsWith("https://")) out.add(s);
        }
        return out;
    }

    private List<String> toList(String[] arr) {
        List<String> out = new ArrayList<>();
        for (String s : arr) out.add(s);
        return out;
    }

    private String readFile(File f) {
        try {
            FileInputStream fis = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
            fis.close();
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return null;
        }
    }

    private void writeFile(File f, String text) {
        try {
            OutputStream os = new FileOutputStream(f);
            os.write(text.getBytes("UTF-8"));
            os.close();
        } catch (Exception ignored) {}
    }

    /** Download url content as raw bytes, return null on failure. */
    private byte[] fetchBytes(String urlStr) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            // 优先级：HTTP_PROXY 环境变量 > 系统 Wifi 代理/PAC > 直连
            Proxy proxy = pickProxy(url);
            conn = (HttpURLConnection) (proxy == Proxy.NO_PROXY
                    ? url.openConnection()
                    : url.openConnection(proxy));
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(20000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36");
            InputStream in = conn.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toByteArray();
        } catch (Exception e) {
            return null;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private String fetch(String urlStr) {
        byte[] b = fetchBytes(urlStr);
        return b == null ? null : new String(b, java.nio.charset.StandardCharsets.UTF_8);
    }

    /** 智能选代理：环境变量 HTTP_PROXY/HTTPS_PROXY > 系统 ProxySelector > 直连 */
    private Proxy pickProxy(URL url) {
        try {
            String envKey = "HTTPS_PROXY";
            String env = System.getenv(envKey);
            if (env == null || env.isEmpty()) {
                envKey = "HTTP_PROXY";
                env = System.getenv(envKey);
            }
            if (env != null && !env.isEmpty()) {
                java.net.URI u = java.net.URI.create(env.contains("://") ? env : "http://" + env);
                String h = u.getHost();
                int p = u.getPort() == -1 ? 8888 : u.getPort();
                if (h != null) return new Proxy(Proxy.Type.HTTP, new java.net.InetSocketAddress(h, p));
            }
        } catch (Exception ignored) {}
        try {
            URI uri = url.toURI();
            java.util.List<Proxy> proxies = ProxySelector.getDefault().select(uri);
            if (proxies != null && !proxies.isEmpty()) {
                Proxy p = proxies.get(0);
                if (p != null && p.address() != null) return p;
            }
        } catch (Exception ignored) {}
        return Proxy.NO_PROXY;
    }

    private String md5(String text) {
        try {
            byte[] d = MessageDigest.getInstance("MD5").digest(text.getBytes("UTF-8"));
            StringBuilder sb = new StringBuilder();
            for (byte b : d) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private String md5(File file) {
        return md5(readFile(file));
    }

    /** 只刷新「上次」状态行、不滚动历史：每日无更新/检查失败用，避免刷掉真实记录 */
    private void saveQuiet(String msg) {
        try {
            getApplicationContext().getSharedPreferences("sync", Context.MODE_PRIVATE)
                    .edit().putString("last", new java.text.SimpleDateFormat(
                            "MM-dd HH:mm", java.util.Locale.CHINA).format(new java.util.Date())
                            + " " + msg).apply();
        } catch (Exception ignored) {}
    }

    /** 保存本次结果，并滚动保留最近5条历史（界面可查，排查不再靠记忆） */
    private void save(String msg) {
        try {
            android.content.SharedPreferences sp =
                    getApplicationContext().getSharedPreferences("sync", Context.MODE_PRIVATE);
            String line = new java.text.SimpleDateFormat(
                    "MM-dd HH:mm", java.util.Locale.CHINA).format(new java.util.Date())
                    + " " + msg;
            List<String> hist = new ArrayList<>();
            String old = sp.getString("hist", null);
            if (old != null) for (String s : old.split("\n")) if (!s.isEmpty()) hist.add(s);
            hist.add(0, line);
            while (hist.size() > 5) hist.remove(hist.size() - 1);
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < hist.size(); i++) {
                if (i > 0) sb.append('\n');
                sb.append(hist.get(i));
            }
            sp.edit().putString("last", line).putString("hist", sb.toString()).apply();
        } catch (Exception ignored) {}
    }

    /**
     * 同步终态收尾：写历史记录 + 发系统通知（成功/失败一眼可见，
     * 点通知打开本App）。「未到窗口跳过」不打扰；通知权限未授予时静默跳过。
     */
    private void done(boolean ok, String msg) {
        save(msg);
        try {
            Context ctx = getApplicationContext();
            android.app.NotificationManager nm = (android.app.NotificationManager)
                    ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.createNotificationChannel(new android.app.NotificationChannel(
                    "sync", "同步结果", android.app.NotificationManager.IMPORTANCE_HIGH));
            android.app.PendingIntent pi = android.app.PendingIntent.getActivity(ctx, 1,
                    new android.content.Intent(ctx, MainActivity.class),
                    android.app.PendingIntent.FLAG_IMMUTABLE
                            | android.app.PendingIntent.FLAG_UPDATE_CURRENT);
            android.app.Notification n = new android.app.Notification.Builder(ctx, "sync")
                    .setSmallIcon(android.R.drawable.stat_notify_sync)
                    .setContentTitle(ok ? "书源同步完成" : "书源同步失败")
                    .setContentText(msg)
                    .setStyle(new android.app.Notification.BigTextStyle().bigText(msg))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(1001, n);
        } catch (Exception ignored) {}
    }

    // ============================================================
    // v5.0 JSON 结构校验：GitHub 成品在 CI 已过同款校验，这里是导入前最后一道防线
    // ============================================================

    /**
     * 书源 12 项结构校验。数量/必填字段/类型/缺失率/重复率/单条体积/数量骤降。
     * @return null=通过；非空=拒绝原因（确定性坏数据不重试，保护书架）
     */
    private String validateBookSources(JSONArray arr, int oldCount) {
        final int n = arr.length();
        if (n < 100) return "数量过少(" + n + "<100)";                                   // C2
        int missRule = 0, dup = 0;
        java.util.HashSet<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < n; i++) {
            Object o;
            try { o = arr.get(i); } catch (Exception e) { return "第" + i + "条读取失败"; }
            if (!(o instanceof JSONObject)) return "第" + i + "条不是对象";              // C3
            JSONObject s = (JSONObject) o;
            if (s.toString().length() > 100_000) return "第" + i + "条体积异常(>100KB)";// C11
            String url = s.optString("bookSourceUrl", "").trim();
            if (url.isEmpty()) return "第" + i + "条缺少bookSourceUrl";                 // C4
            if (!url.startsWith("http://") && !url.startsWith("https://"))
                return "第" + i + "条URL协议异常";                                       // C5
            if (s.optString("bookSourceName", "").trim().isEmpty())
                return "第" + i + "条缺少bookSourceName";                                // C6
            Object en = s.has("enabled") ? s.opt("enabled") : null;
            if (en != null && !(en instanceof Boolean))
                return "第" + i + "条enabled类型异常";                                   // C8
            Object ty = s.has("bookSourceType") ? s.opt("bookSourceType") : null;
            if (ty != null) {
                if (!(ty instanceof Number)) return "第" + i + "条bookSourceType类型异常";// C9
                int t = ((Number) ty).intValue();
                if (t < 0 || t > 3 || t != ((Number) ty).doubleValue())
                    return "第" + i + "条bookSourceType越界";
            }
            String rule = s.optString("ruleContent", "");
            if (rule.isEmpty()) missRule++;                                              // C7
            if (!seen.add(url)) dup++;                                                   // C10
        }
        if (missRule * 2 > n) return "ruleContent缺失率过高(" + missRule + "/" + n + ")";
        if (dup * 5 > n) return "URL重复率过高(" + dup + "/" + n + ")";
        if (oldCount > 0 && n < oldCount / 2)
            return "数量异常下降(" + n + "/" + oldCount + ")";                           // C12
        return null;
    }

    /**
     * 净化规则 4 项结构校验：数组非空 / 元素对象 / 必填 pattern / 单条体积。
     * @return null=通过；非空=拒绝原因
     */
    private String validateReplaceRules(String text) {
        JSONArray arr;
        try { arr = new JSONArray(text); } catch (Exception e) { return "解析失败"; }    // R1
        if (arr.length() < 1) return "规则数为0";                                        // R2
        for (int i = 0; i < arr.length(); i++) {
            Object o;
            try { o = arr.get(i); } catch (Exception e) { return "第" + i + "条读取失败"; }
            if (!(o instanceof JSONObject)) return "第" + i + "条不是对象";              // R3
            JSONObject r = (JSONObject) o;
            if (r.optString("pattern", "").trim().isEmpty())
                return "第" + i + "条缺少pattern";                                       // R4
            if (r.toString().length() > 20_000) return "第" + i + "条体积异常(>20KB)";
        }
        return null;
    }
}
