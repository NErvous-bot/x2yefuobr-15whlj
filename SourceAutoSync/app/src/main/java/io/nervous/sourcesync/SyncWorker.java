package io.nervous.sourcesync;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONException;
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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

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
 * v3.19：
 *  - 写入回查改用单源路由 bookSource/query?url=，避免复数路由把全部源塞进
 *    一个 cursor 行（374 源≈2.5MB）超过 CursorWindow 2MB 上限，造成
 *    「实际写入成功、回查却报失败」的假阴性；
 *  - 只有回查真正通过才记 lastVerified，防止一次兜底导入后永久跳过写入。
 *
 * v3.20（稳定性/可观测性收口）：
 *  - 回查抽查首/中/尾三条；深链兜底不再一劳永逸（规则 24h 后可再唤起，
 *    删除失败清单 7 天过期）；urls.txt 只接受指向本仓库的线路；
 *  - 下载线路失败 15 分钟冷却、连接超时 20s→8s；jsDelivr 走 purge 而非无效
 *    的 cb 参数；全部线路签名不符时直连 raw 源站重试一次；
 *  - 指纹改为多线路投票（2 票一致才采信），避免 CDN 滞后导致漏更新；
 *  - 每日检查改为一次性任务链，固定在 05:00；错误文案区分网络失败与验签/缓存不符。
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

    /** 本地健康缓存条目：每个源的手机端可达性记录 */
    static class HealthEntry {
        long lastCheck;          // 上次探测时间戳（ms）
        int failCount;           // 连续失败次数
        boolean localAvailable;  // 上次探测结果
        long retryAfter;         // 下次允许重试的时间戳（ms）

        HealthEntry(long lastCheck, int failCount, boolean localAvailable, long retryAfter) {
            this.lastCheck = lastCheck;
            this.failCount = failCount;
            this.localAvailable = localAvailable;
            this.retryAfter = retryAfter;
        }

        JSONObject toJson() throws JSONException {
            JSONObject o = new JSONObject();
            o.put("lastCheck", lastCheck);
            o.put("failCount", failCount);
            o.put("localAvailable", localAvailable);
            o.put("retryAfter", retryAfter);
            return o;
        }

        static HealthEntry fromJson(JSONObject o) {
            return new HealthEntry(
                    o.optLong("lastCheck", 0),
                    o.optInt("failCount", 0),
                    o.optBoolean("localAvailable", false),
                    o.optLong("retryAfter", 0)
            );
        }
    }

    /** 接口诊断信息（探针失败时写进结果，用户截图即可远程定位） */
    private String authorityDiag = "";

    /** 最近一条验签通过的下载线路；深链兜底时复用它，避免写死 ghproxy 单点 */
    private String lastGoodLine = "";

    /**
     * 线路冷却表：host → 解禁时间戳。一次同步里同一线路最多被尝试 3 次
     * （指纹、书源、规则），死线路每次都要白等 8s 超时；失败后短期拉黑，
     * 后续步骤直接跳过。手动同步不受冷却限制（用户明确要求马上重试）。
     */
    private static final Map<String, Long> LINE_COOLDOWN = new ConcurrentHashMap<>();
    private static final long COOLDOWN_MS = 15 * 60 * 1000L;

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
     * kind = bookSource / replaceRule。阅读App 自己下载并导入，
     * ImportXxxDialog(url, true) 的 true = autoImport，全程无需用户确认。
     * 手动同步（本App在前台）必成；后台定时同步若被系统拦截，返回 false
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

    /** 深链兜底地址：优先用刚验签成功的线路，其次内置第一条（防单条镜像挂掉就导入失败） */
    private String fallbackUrl(String fileName) {
        String base = lastGoodLine.isEmpty() ? defaultLines(decodeRepo())[0] : lastGoodLine;
        return base.replace("legado.json", fileName) + "?cb=" + System.currentTimeMillis();
    }

    /**
     * 写入后回查：provider 的 insert 恒返回 null（官方 ReaderProvider 源码里固定 return null），
     * 唯一可靠的成功信号是「回查能看到刚写入的样本源」。
     *
     * 必须用单源路由 bookSource/query?url= 回查：复数路由 bookSources/query
     * 会把全部书源序列化成一个 cursor 行，当前仓库 374 源约 2.5MB，超过
     * Android CursorWindow 2MB 上限时会直接抛异常，造成「写入成功却回查失败」
     * 的假阴性（v3.18 线上现象）。单源路由的 data 是对象，这里兼容数组形态。
     */
    private boolean verifyWritten(String authority, JSONArray written) {
        int n = written.length();
        if (n == 0) return true;
        // 只抽查第 1 条时，尾部批次整体没写进（binder 截断/中途异常）也照样
        // 判「成功」。v3.20 起抽查首/中/尾三条，代价仍只有 3 次单源查询。
        int[] idx = n == 1 ? new int[]{0} : new int[]{0, n / 2, n - 1};
        for (int i : idx) {
            JSONObject src = written.optJSONObject(i);
            if (src == null) continue;
            if (!verifyOne(authority, src.optString("bookSourceUrl", ""))) return false;
        }
        return true;
    }

    /** 单源回查：provider 返回 isSuccess=true 且 data 里能找到该 bookSourceUrl */
    private boolean verifyOne(String authority, String sample) {
        if (sample.isEmpty()) return true;
        android.database.Cursor c = null;
        try {
            Uri uri = Uri.parse("content://" + authority + "/bookSource/query")
                    .buildUpon().appendQueryParameter("url", sample).build();
            c = getApplicationContext().getContentResolver()
                    .query(uri, null, null, null, null);
            if (c == null || !c.moveToFirst()) return false;
            String raw = c.getString(0);
            if (raw == null || raw.isEmpty()) return false;
            JSONObject o = new JSONObject(raw);
            if (!o.optBoolean("isSuccess", false)) return false;
            JSONObject one = o.optJSONObject("data");
            if (one != null) return sample.equals(one.optString("bookSourceUrl", ""));
            JSONArray arr = o.optJSONArray("data");
            if (arr == null) return false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject s = arr.optJSONObject(i);
                if (s != null && sample.equals(s.optString("bookSourceUrl", ""))) return true;
            }
            return false;
        } catch (Exception e) {
            android.util.Log.w("SyncWorker", "写入回查异常: " + e.getMessage());
            return false;
        } finally {
            if (c != null) try { c.close(); } catch (Exception ignored) {}
        }
    }

    /**
     * 对比上次写入的书源与本次清单，找出「仓库已剔除」的旧源。
     * 只返回 {bookSourceUrl} 最小对象：官方 ReaderProvider 的
     * bookSources/delete 会 GSON 反序列化后只取 bookSourceUrl 删除
     * （SourceHelp.deleteBookSources），字段越少 binder 传输越安全。
     */
    private JSONArray diffSources(JSONArray oldArr, JSONArray newArr) {
        Set<String> keep = new java.util.HashSet<>();
        for (int i = 0; i < newArr.length(); i++) {
            JSONObject o = newArr.optJSONObject(i);
            if (o != null) keep.add(o.optString("bookSourceUrl", ""));
        }
        JSONArray out = new JSONArray();
        Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < oldArr.length(); i++) {
            JSONObject o = oldArr.optJSONObject(i);
            if (o == null) continue;
            String url = o.optString("bookSourceUrl", "");
            if (url.isEmpty() || keep.contains(url) || !seen.add(url)) continue;
            try {
                out.put(new JSONObject().put("bookSourceUrl", url));
            } catch (JSONException ignored) {}
        }
        return out;
    }

    /**
     * 与上次遗留的删除失败清单合并，并排除本次清单里仍然存在的 URL——
     * 已被仓库重新收录的源不能因为旧失败记录又被删掉。
     *
     * 每条记录带首次入队时间 ts：超过 7 天仍删不掉的（阅读App版本差异/
     * 源被用户手动加回）直接放弃，避免「永远删不掉」的条目每天重试一次。
     */
    private JSONArray mergePending(JSONArray removed, JSONArray newArr) {
        long now = System.currentTimeMillis();
        Set<String> keep = new java.util.HashSet<>();
        for (int i = 0; i < newArr.length(); i++) {
            JSONObject o = newArr.optJSONObject(i);
            if (o != null) keep.add(o.optString("bookSourceUrl", ""));
        }
        JSONArray pending = new JSONArray();
        File pf = pendingDeleteFile();
        if (pf.exists()) {
            try { pending = new JSONArray(readFile(pf)); } catch (Exception ignored) {}
        }
        JSONArray out = new JSONArray();
        Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < pending.length() + removed.length(); i++) {
            JSONObject o = i < pending.length()
                    ? pending.optJSONObject(i)
                    : removed.optJSONObject(i - pending.length());
            if (o == null) continue;
            String url = o.optString("bookSourceUrl", "");
            if (url.isEmpty() || keep.contains(url) || !seen.add(url)) continue;
            long ts = o.optLong("ts", now);
            if (now - ts > 7L * 24 * 3600 * 1000) continue;
            try { out.put(new JSONObject().put("bookSourceUrl", url).put("ts", ts)); }
            catch (JSONException ignored) {}
        }
        return out;
    }

    private File pendingDeleteFile() {
        return new File(getApplicationContext().getFilesDir(), "pending-delete.json");
    }

    /** 删除失败清单落盘，下次同步重试；全部成功则清掉文件。 */
    private void savePendingDelete(JSONArray failed) {
        try {
            File pf = pendingDeleteFile();
            if (failed.length() == 0) {
                if (pf.exists()) pf.delete();
                return;
            }
            writeFile(pf, failed.toString());
        } catch (Exception ignored) {}
    }

    /**
     * 删除阅读App中已不在仓库的旧源：官方路由 bookSources/delete，
     * ReaderProvider.delete() 把 selection 当 JSON 数组反序列化后按
     * bookSourceUrl 逐个删除，不会误删用户自建源。分批发送避免 binder
     * 事务超限；返回失败条目供下次重试（不影响本次写入结果）。
     */
    private JSONArray deleteSources(String authority, JSONArray removed) {
        long now = System.currentTimeMillis();
        Uri uri = Uri.parse("content://" + authority + "/bookSources/delete");
        JSONArray failed = new JSONArray();
        for (int i = 0; i < removed.length(); i += 100) {
            JSONArray part = new JSONArray();
            for (int j = i; j < Math.min(i + 100, removed.length()); j++) {
                JSONObject o = removed.optJSONObject(j);
                if (o != null) part.put(o);
            }
            try {
                getApplicationContext().getContentResolver().delete(uri, part.toString(), null);
            } catch (Exception e) {
                android.util.Log.w("SyncWorker", "清理已下架源失败: " + e.getMessage());
                for (int j = 0; j < part.length(); j++) {
                    JSONObject o = part.optJSONObject(j);
                    if (o == null) continue;
                    try {
                        // 保留首次入队时间，供 7 天过期判断；provider 只取 bookSourceUrl，多带字段无害
                        failed.put(new JSONObject().put("bookSourceUrl", o.optString("bookSourceUrl", ""))
                                .put("ts", o.optLong("ts", now)));
                    } catch (JSONException ignored) {}
                }
            }
        }
        return failed;
    }

    @NonNull
    @Override
    public Result doWork() {
        Result r;
        try {
            r = doSync();
        } catch (Exception e) {
            String m = e.getMessage();
            done(false, "失败：" + (m == null ? e.getClass().getSimpleName() : m));
            r = Result.failure();
        }
        // 固定 05:00：24h 周期任务每次从「上次执行完成」重新计时，越跑越偏；
        // v3.20 改成一次性任务链——本轮成功后自行预约下一次 05:00 的检查。
        if (r instanceof Result.Success
                && !"manual".equals(getInputData().getString("mode"))) {
            scheduleNextDaily();
        }
        return r;
    }

    /** 预约下一次每日检查：唯一任务名 daily-next，重复预约以最后一次为准 */
    private void scheduleNextDaily() {
        try {
            androidx.work.WorkManager.getInstance(getApplicationContext())
                    .enqueueUniqueWork("daily-next",
                            androidx.work.ExistingWorkPolicy.REPLACE,
                            new androidx.work.OneTimeWorkRequest.Builder(SyncWorker.class)
                                    .setInitialDelay(delayUntilNext5am(), TimeUnit.MILLISECONDS)
                                    .setConstraints(new androidx.work.Constraints.Builder()
                                            .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                                            .build())
                                    .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,
                                            30, TimeUnit.MINUTES)
                                    .build());
        } catch (Exception ignored) {}
    }

    /** 距下一个 05:00 的毫秒数；与 MainActivity 共用同一份算法 */
    static long delayUntilNext5am() {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.set(java.util.Calendar.HOUR_OF_DAY, 5);
        cal.set(java.util.Calendar.MINUTE, 0);
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
            cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }
        return cal.getTimeInMillis() - System.currentTimeMillis();
    }

    /**
     * 每日轻量检查（仅非手动模式）：两个指纹都与本地一致 → 直接返回 success；
     * 探测失败但 7 天内有成功记录 → 返回 retry（多为瞬时网络问题）；
     * 需要继续全量流程时返回 null。
     */
    private Result checkFingerprintOrNull() {
        if ("manual".equals(getInputData().getString("mode"))) return null;
        Context ctx = getApplicationContext();
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
        return null;
    }

    private Result doSync() {
        Context ctx = getApplicationContext();

        // 0) 每天自动检查：先做轻量指纹探测（约70字节的 version.txt，内容为
        //    书源+规则两个 md5）。没变化当天到此为止；探测失败且 7 天内有过
        //    成功记录 → 交给 WorkManager 退避重试；否则走全量下载写入。
        Result skip = checkFingerprintOrNull();
        if (skip != null) return skip;

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
        // 只有上一轮「写入 + 回查」都成功才允许按 md5 跳过。兜底深链导入
        // 无法确认阅读App真的落库，不写 lastVerified，下次仍会重新写入校验。
        boolean lastVerified = ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
                .getBoolean("lastVerified", false);
        if (cache.exists() && md5(cache).equals(md5(json)) && lastVerified) {
            String ruleMsg = syncRules(lines);
            saveFingerprints(md5(json));
            ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
                    .edit().putLong("lastOk", System.currentTimeMillis()).apply();
            done(true, "书源无变化，跳过写入｜" + ruleMsg);
            return Result.success();
        }

        // 3.5) 数量兜底：新书源数少于上次的一半，视为仓库数据异常（上游事故/
        //      投毒），拒绝导入保护书架——深链兜底导入同样受此保护
        JSONArray oldArr = new JSONArray();
        if (cache.exists()) {
            try { oldArr = new JSONArray(readFile(cache)); } catch (Exception ignored) {}
        }
        int oldCount = oldArr.length();
        JSONArray all;
        int total;
        try {
            all = new JSONArray(json);
            total = all.length();
        } catch (Exception e) {
            done(false, "书源数据异常（解析失败），已跳过本次更新");
            return Result.success();
        }
        if (oldCount > 0 && total < oldCount / 2) {
            done(false, "书源数量异常下降（" + total + "/" + oldCount + "），已拒绝本次更新保护书架");
            return Result.success();
        }

        // 3.6) 本地健康层：手机可达性 → 动态 enabled
        //      不动 GitHub 原始 JSON（last.json 存原样），
        //      本地状态单独存 health.json，两者合并后才写入 Legado
        prog("正在本地探测可达性…");
        Map<String, HealthEntry> healthCache = loadHealthCache();
        JSONArray finalSources = applyLocalHealth(all, healthCache);
        int locallyDead = countDisabled(finalSources);
        prog("本地暂不可达 " + locallyDead + "/" + total + "，写入 " + finalSources.length() + " 源");

        // 4) 发现并验证阅读App接口（探针通过才写入）
        String authority = resolveAuthority();
        if (authority == null) {
            // 兜底：唤起阅读App官方在线导入（legado://import/bookSource 深链，
            // autoImport=true 全自动，阅读App 自己下载，无需文件中转）
            String src = fallbackUrl("legado.json");
            boolean fired = fireOnlineImport("bookSource", src);
            if (fired) {
                writeFile(cache, json);
                // 深链导入无法确认落库，清掉验证标记，下次仍走 provider 写入+回查
                ctx.getSharedPreferences("sync", Context.MODE_PRIVATE).edit()
                        .putBoolean("lastVerified", false).apply();
                // 兜底路径也要落健康缓存，否则每轮都重复探测同一批源
                saveHealthCache(healthCache);
                String ruleMsg = syncRules(lines);
                saveFingerprints(md5(json));
                done(true, "接口探针全不通过（" + authorityDiag.trim()
                        + "），已唤起阅读App自动导入｜" + ruleMsg);
            } else {
                done(false, "失败：未找到阅读App，请先安装阅读App再同步｜" + authorityDiag.trim());
            }
            return Result.success();
        }
        int finalTotal = finalSources.length();
        try {
            prog("验签通过，正在写入阅读App…");
            String delMsg = writeViaProvider(authority, finalSources, oldArr);
            OutputStream os = new FileOutputStream(cache);
            os.write(json.getBytes("UTF-8"));
            os.close();
            // 保存本地健康缓存（仅在成功写入后）
            saveHealthCache(healthCache);
            String ruleMsg = syncRules(lines);
            saveFingerprints(md5(json));
            ctx.getSharedPreferences("sync", Context.MODE_PRIVATE)
                    .edit().putLong("lastOk", System.currentTimeMillis())
                    .putBoolean("lastVerified", true).apply();
            done(true, "成功：已写入" + finalTotal + "源（本地禁用" + locallyDead + "）"
                    + delMsg + "｜" + ruleMsg);
            return Result.success();
        } catch (Exception e) {
            // provider 写入中途失败（版本差异/权限拦截）：唤起官方在线导入兜底
            String src = fallbackUrl("legado.json");
            boolean fired = fireOnlineImport("bookSource", src);
            saveHealthCache(healthCache);
            ctx.getSharedPreferences("sync", Context.MODE_PRIVATE).edit()
                    .putBoolean("lastVerified", false).apply();
            String m = e.getMessage();
            done(fired,
                    (fired ? "写入异常已转自动导入，原因：" : "失败：")
                            + (m == null ? e.getClass().getSimpleName() : m));
            return Result.success();
        }
    }

    /**
     * 通过 provider 写入全部书源，并清理仓库已剔除的源。
     * @return 清理结果文案（没有清理时为空串）；写入/回查失败抛异常，由调用方兜底
     */
    private String writeViaProvider(String authority, JSONArray finalSources, JSONArray oldArr)
            throws Exception {
        // 官方路由表（源码实测）：书源批量写入 = bookSources/insert，body 键名 json
        Uri uri = Uri.parse("content://" + authority + "/bookSources/insert");
        int total = finalSources.length();
        for (int i = 0; i < total; i += BATCH) {
            JSONArray part = new JSONArray();
            for (int j = i; j < Math.min(i + BATCH, total); j++) {
                part.put(finalSources.get(j));
            }
            ContentValues v = new ContentValues();
            v.put("json", part.toString());
            getApplicationContext().getContentResolver().insert(uri, v);
            prog("正在写入书源 " + Math.min(i + BATCH, total) + "/" + total + "…");
        }
        // 官方 Provider 的 insert 无论成败都 return null（源码固定 return null），
        // 不能靠返回值判断；写完后抽查首/中/尾确认真的落库
        if (!verifyWritten(authority, finalSources)) {
            throw new IllegalStateException("写入后回查失败：阅读App未保存这批书源");
        }
        // 清理仓库已剔除的源：provider 的 insert 只增不删，不主动清理会让
        // 已判死/已下架的源永远留在手机里（本地可达性只探测域名存活，
        // 识别不出「站点改版导致正文永久失效」的源）。
        // 只删「上次写入过、本次已不在仓库」的源，按 bookSourceUrl 精确
        // 匹配；用户自建源不在 last.json 里，不受影响。
        JSONArray merged = mergePending(diffSources(oldArr, finalSources), finalSources);
        JSONArray stillFailed = merged.length() == 0
                ? new JSONArray() : deleteSources(authority, merged);
        savePendingDelete(stillFailed);
        int cleaned = merged.length() - stillFailed.length();
        return cleaned == 0 ? ""
                : "，已清理已下架 " + cleaned + " 源"
                + (stillFailed.length() == 0 ? ""
                : "（" + stillFailed.length() + " 个失败，下次同步自动重试）");
    }

    /**
     * 带 ECDSA 验签的下载：对每条线路，同时取「文件 + 文件.sig」，
     * 验签通过才返回内容；任何一环失败都换下一条线路（fail closed）。
     *
     * 缓存穿透（v3.20）：
     *  - 普通线路追加随机 cb 参数，保证 body 与 sig 来自同一份回源数据；
     *  - jsDelivr 的缓存键是路径而非 query，cb 对它完全无效（线上实测持续
     *    返回「新 json + 旧 sig」），验签失败时先调官方 purge 再重试一次；
     *  - 全部线路都因签名不符失败时，再直连 raw 源站试一次；
     *  - 失败线路按 host 冷却 15 分钟，后续步骤（规则/指纹）不再白等超时。
     */
    private String fetchVerified(String fileName, List<String> lines, StringBuilder err) {
        int total = lines.size(), netFail = 0, sigFail = 0;
        String lastWhy = "";
        boolean manual = "manual".equals(getInputData().getString("mode"));
        for (int i = 0; i < total; i++) {
            String line = lines.get(i);
            String host = hostName(line);
            if (!manual && cooling(host)) {
                prog("跳过冷却中的线路：" + host);
                continue;
            }
            String url = line.replace("legado.json", fileName);
            prog("正在尝试线路 " + (i + 1) + "/" + total + "：" + host);
            // jsDelivr 忽略 query 参数，cb 加了也没用（还会让 .sig 与 body 落到不同缓存键）
            String cb = jsdelivr(url) ? "" : (url.contains("?") ? "&" : "?")
                    + "cb=" + System.currentTimeMillis();
            byte[] body = fetchBytes(url + cb);
            if (body == null) { netFail++; markFail(host); lastWhy = host + " 下载失败"; continue; }
            byte[] sigB = fetchBytes(url + ".sig" + cb);
            if (sigB == null) { netFail++; markFail(host); lastWhy = host + " 无签名"; continue; }
            String vr = verify(body, new String(sigB, java.nio.charset.StandardCharsets.UTF_8).trim());
            if (vr == null) {
                markOk(host);
                lastGoodLine = line;   // 记住验签通过的线路，供深链兜底复用
                return new String(body, java.nio.charset.StandardCharsets.UTF_8);
            }
            if (jsdelivr(url) && purgeJsdelivr(url)) {
                // purge 是异步的，立刻重试一次；命中就继续用，没命中换线路
                byte[] b2 = fetchBytes(url);
                byte[] s2 = fetchBytes(url + ".sig");
                if (b2 != null && s2 != null) {
                    String vr2 = verify(b2,
                            new String(s2, java.nio.charset.StandardCharsets.UTF_8).trim());
                    if (vr2 == null) {
                        markOk(host);
                        lastGoodLine = line;
                        return new String(b2, java.nio.charset.StandardCharsets.UTF_8);
                    }
                }
            }
            sigFail++;
            lastWhy = host + " " + vr;
        }
        // 签名不符多半是 CDN 把旧内容和新签名混搭：直连源站（raw）再试一次
        if (sigFail > 0) {
            prog("直连源站重试：" + fileName);
            String ts = "?cb=" + System.currentTimeMillis();
            String raw = GH_RAW + decodeRepo() + "/main/" + fileName;
            byte[] body = fetchBytes(raw + ts);
            byte[] sigB = body == null ? null : fetchBytes(raw + ".sig" + ts);
            if (body != null && sigB != null
                    && verify(body, new String(sigB, java.nio.charset.StandardCharsets.UTF_8).trim()) == null) {
                markOk(hostName(raw));
                lastGoodLine = raw;
                return new String(body, java.nio.charset.StandardCharsets.UTF_8);
            }
        }
        // 全部线路都在冷却期（本轮前面步骤刚踩过）：给明确文案，别报「0 条失败」
        if (netFail == 0 && sigFail == 0) {
            err.append("全部线路仍在冷却期，稍后自动重试");
            return null;
        }
        err.append(netFail).append(" 条网络失败、").append(sigFail).append(" 条验签/缓存不符")
                .append("（共 ").append(total).append(" 条线路，末次：").append(lastWhy).append("）");
        return null;
    }

    /** host 是否为 jsDelivr（它的缓存忽略 query，只能用 purge 接口穿透） */
    private boolean jsdelivr(String url) {
        return url.contains("cdn.jsdelivr.net");
    }

    /** 调 jsDelivr 官方 purge 让边缘节点失效；返回是否请求成功 */
    private boolean purgeJsdelivr(String url) {
        int i = url.indexOf("/gh/");
        if (i < 0) return false;
        String path = url.substring(i);
        int q = path.indexOf('?');
        if (q >= 0) path = path.substring(0, q);
        return fetch("https://purge.jsdelivr.net" + path) != null;
    }

    private String hostName(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return ""; }
    }

    private boolean cooling(String host) {
        Long until = LINE_COOLDOWN.get(host);
        return until != null && System.currentTimeMillis() < until;
    }

    private void markFail(String host) {
        if (!host.isEmpty()) LINE_COOLDOWN.put(host, System.currentTimeMillis() + COOLDOWN_MS);
    }

    private void markOk(String host) {
        if (!host.isEmpty()) LINE_COOLDOWN.remove(host);
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

    /**
     * 同步全局净化规则。官方 ReaderProvider 路由表（源码实测）只有
     * 书源/rss/书籍三类路由，【没有】净化规则路由——之前用 provider 写
     * 规则的路从来不存在。v3.13 起规则变化时唤起阅读App官方在线导入
     * 深链（legado://import/replaceRule），阅读App 自行下载并自动导入。
     * 失败只汇报，不影响书源同步。
     *
     * v3.20：深链唤起无法确认阅读App是否真的导入（后台可能被系统拦截），
     * 旧实现唤起后立刻写 last_rules.json，导致之后永远显示「规则无变化」、
     * 再也不会重试。现在记录「已唤起的内容 md5 + 时间」：同一份内容 24h 内
     * 不重复打扰，超过 24h 且仍未确认则再唤起一次，最多 3 次后转为提示手动。
     */
    private String syncRules(List<String> lines) {
        try {
            StringBuilder err = new StringBuilder();
            String rjson = fetchVerified("replaceRule.json", lines, err);
            if (rjson == null) return "规则未同步：" + err;

            String remoteMd5 = md5(rjson);
            File rcache = new File(getApplicationContext().getFilesDir(), "last_rules.json");
            android.content.SharedPreferences sp =
                    getApplicationContext().getSharedPreferences("sync", Context.MODE_PRIVATE);
            String firedMd5 = sp.getString("rulesFiredMd5", null);
            long firedAt = sp.getLong("rulesFiredAt", 0);
            boolean firedSame = remoteMd5.equals(firedMd5);
            long sinceFire = System.currentTimeMillis() - firedAt;

            if (rcache.exists() && md5(rcache).equals(remoteMd5) && !firedSame) {
                return "规则无变化";
            }
            if (firedSame && sinceFire < 24L * 3600 * 1000) {
                return "规则已唤起导入（24h内不重复）";
            }
            int tries = firedSame ? sp.getInt("rulesFireTries", 0) : 0;
            if (tries >= 3) {
                return "规则有更新：请打开本App点「立即同步」完成导入";
            }
            String src = fallbackUrl("replaceRule.json");
            boolean fired = fireOnlineImport("replaceRule", src);
            if (!fired) {
                // 后台同步时系统拦截界面启动——引导用户手动同步（前台必成）
                return "规则有更新：请打开本App点「立即同步」完成导入";
            }
            OutputStream os = new FileOutputStream(rcache);
            os.write(rjson.getBytes("UTF-8"));
            os.close();
            sp.edit().putString("rulesFiredMd5", remoteMd5)
                    .putLong("rulesFiredAt", System.currentTimeMillis())
                    .putInt("rulesFireTries", tries + 1).apply();
            return "规则更新：已唤起阅读App自动导入";
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
     *
     * v3.20：旧实现「第一条能解析的线路说了算」，jsDelivr 缓存滞后时会拿到
     * 旧指纹，判定「无更新」而漏掉真实更新。现在多线路投票，2 票一致才算
     * 采信；只剩单一意见时直接用；分歧且含 raw 源站时以源站为准。
     */
    private String[] fetchFingerprint(String repo) {
        Map<String, Integer> votes = new java.util.LinkedHashMap<>();
        Map<String, String[]> fps = new HashMap<>();
        String[] rawFp = null;
        for (String base : defaultLines(repo)) {
            String host = hostName(base);
            if (cooling(host)) continue;
            String txt = fetch(base.replace("legado.json", "version.txt")
                    + "?cb=" + System.currentTimeMillis());
            if (txt == null) { markFail(host); continue; }
            String[] ps = parseFingerprint(txt);
            if (ps == null) { markFail(host); continue; }
            markOk(host);
            String key = ps[0] + " " + ps[1];
            Integer n = votes.get(key);
            votes.put(key, n == null ? 1 : n + 1);
            if (!fps.containsKey(key)) fps.put(key, ps);
            if ("raw.githubusercontent.com".equals(host)) rawFp = ps;
            if (votes.get(key) >= 2) return ps;      // 两条线路一致，直接采信
        }
        String best = null;
        int bestN = 0;
        for (Map.Entry<String, Integer> e : votes.entrySet()) {
            if (e.getValue() > bestN) { bestN = e.getValue(); best = e.getKey(); }
        }
        if (best != null && (bestN >= 2 || votes.size() == 1)) return fps.get(best);
        if (rawFp != null) return rawFp;             // 分歧时以 GitHub 源站为准
        return null;
    }

    /** 解析 version.txt：必须正好两行 32 位小写 md5，否则视为无效内容 */
    private String[] parseFingerprint(String txt) {
        String[] ps = txt.trim().split("\\s+");
        if (ps.length == 2 && ps[0].matches("[0-9a-f]{32}")
                && ps[1].matches("[0-9a-f]{32}")) return ps;
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

    /**
     * 解析名单文本：只接受 https:// 且指向本仓库 legado.json 的行。
     * v3.20 起加了仓库路径校验——旧实现任何 https 链接都收，一旦 urls.txt
     * 被投毒（或缓存被篡改），App 会去作者指定的任意站点下载，虽仍要验签，
     * 但没必要给外部地址发请求。
     */
    private List<String> parseLines(String txt) {
        List<String> out = new ArrayList<>();
        if (txt == null) return out;
        String repo = decodeRepo();
        for (String s : txt.split("\n")) {
            s = s.trim();
            if (!s.isEmpty() && !s.startsWith("#") && s.contains("legado.json")
                    && s.startsWith("https://") && s.contains(repo)) out.add(s);
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
            // 连接超时 8s（旧 20s 让死线路把整轮同步拖到分钟级；读超时仍 20s，
            // 国内镜像首字节慢但一旦开始传输就很快）
            conn.setConnectTimeout(8000);
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
        // 同一轮失败后的 WorkManager 自动重试不再弹通知：网络差时否则每次退避都刷一条
        if (!ok && getRunAttemptCount() > 0) return;
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
                    .setContentTitle(ok ? "同步器：同步完成" : "同步器：同步失败")
                    .setContentText(msg)
                    .setStyle(new android.app.Notification.BigTextStyle().bigText(msg))
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(1001, n);
        } catch (Exception ignored) {}
    }

    // ============================================================
    // 本地健康层：CI 评分 + 手机可达性 → 动态 enabled
    // 不动 GitHub 原始 JSON，本地状态单独存 health.json
    // ============================================================

    /** 本地健康缓存文件 */
    private File healthFile() {
        return new File(getApplicationContext().getFilesDir(), "health.json");
    }

    /** 读健康缓存，返回空 Map 若无/损坏 */
    private Map<String, HealthEntry> loadHealthCache() {
        Map<String, HealthEntry> map = new HashMap<>();
        try {
            File f = healthFile();
            if (!f.exists()) return map;
            String txt = readFile(f);
            if (txt == null || txt.isEmpty()) return map;
            JSONObject obj = new JSONObject(txt);
            java.util.Iterator<String> keys = obj.keys();
            while (keys.hasNext()) {
                String k = keys.next();
                map.put(k, HealthEntry.fromJson(obj.getJSONObject(k)));
            }
        } catch (Exception ignored) {}
        return map;
    }

    /** 写健康缓存（仅在成功写入 Legado 后调用，避免探测失败污染） */
    private void saveHealthCache(Map<String, HealthEntry> cache) {
        try {
            JSONObject obj = new JSONObject();
            for (Map.Entry<String, HealthEntry> e : cache.entrySet()) {
                obj.put(e.getKey(), e.getValue().toJson());
            }
            writeFile(healthFile(), obj.toString());
        } catch (Exception ignored) {}
    }

    /** 统计 JSONArray 中 enabled=false 的源数 */
    private int countDisabled(JSONArray arr) {
        int n = 0;
        for (int i = 0; i < arr.length(); i++) {
            try { if (!arr.getJSONObject(i).optBoolean("enabled", true)) n++; }
            catch (Exception ignored) {}
        }
        return n;
    }

    /**
     * 合并 CI 源 + 本地健康缓存 + 手机轻量探测 → 最终可写入 Legado 的源列表
     *
     * 策略：
     *  - CI 评分筛选：weight > 0 保留（当前 CI 全部 > 0，预留未来 weight=0 给死源）
     *  - 缓存命中（24h 内且未在冷却期）：直接用上次探测结果
     *  - 缓存失效或冷却期到期：加入本轮探测队列，每次最多 60 个
     *  - 优先探测：上次判死且 retryAfter 到期的源（自动恢复）
     *  - 探测失败：enabled=false，按 failCount 指数退避重试（1h→6h→24h）
     */
    private JSONArray applyLocalHealth(JSONArray sources, Map<String, HealthEntry> cache) {
        long now = System.currentTimeMillis();

        // Step 1: 分类所有源
        List<JSONObject> toProbe = new ArrayList<>();
        Map<String, Boolean> cachedResult = new HashMap<>(); // url → localAvailable
        JSONArray ciAliveOnly = new JSONArray();

        for (int i = 0; i < sources.length(); i++) {
            try {
                JSONObject src = sources.getJSONObject(i);
                // CI 评分筛选：weight == 0 的源 CI 已判死，直接跳过
                if (src.optInt("weight", 0) == 0) continue;
                ciAliveOnly.put(src);

                String url = src.optString("bookSourceUrl", "");
                if (url.isEmpty()) continue;

                HealthEntry h = cache.get(url);
                if (h != null) {
                    long age = now - h.lastCheck;
                    // 缓存有效（24h 内且未在冷却期）→ 直接用
                    if (age < 24 * 3600 * 1000 && now >= h.retryAfter) {
                        cachedResult.put(url, h.localAvailable);
                        continue;
                    }
                    // 冷却期还没到 → 沿用上一次结果（不额外探测）
                    if (now < h.retryAfter) {
                        cachedResult.put(url, h.localAvailable);
                        continue;
                    }
                }
                // 无缓存或缓存失效 → 加入探测队列
                toProbe.add(src);
            } catch (Exception ignored) {}
        }

        // Step 2: 从探测队列里优先挑"上次判死且到期"的，最多 100 个
        // （旧上限 60 个/天，372 源要 6 天才能轮一遍；16 线程 × 3s 足够覆盖）
        toProbe.sort((a, b) -> {
            try {
                HealthEntry ha = cache.get(a.optString("bookSourceUrl", ""));
                HealthEntry hb = cache.get(b.optString("bookSourceUrl", ""));
                // 上次判死 → 排前面（自动恢复优先）
                boolean ad = ha != null && !ha.localAvailable;
                boolean bd = hb != null && !hb.localAvailable;
                if (ad != bd) return ad ? -1 : 1;
                // 上次判死中，failCount 多的排后面（退避更深）
                if (ad && bd) return ha.failCount - hb.failCount;
                // 其余按 lastCheck 升序轮转：最久没测的先测。
                // （旧实现这里 return 0，稳定排序后每天永远只测数组最前 60 个，
                //   372 个源里后 312 个永远轮不到）
                long ta = ha == null ? 0L : ha.lastCheck;
                long tb = hb == null ? 0L : hb.lastCheck;
                return Long.compare(ta, tb);
            } catch (Exception e) { return 0; }
        });
        // 截断到 100 个以内
        int probeLimit = Math.min(toProbe.size(), 100);
        List<JSONObject> actualProbe = toProbe.subList(0, probeLimit);

        // Step 3: 并发探测（16 线程，每个超时 3s；100 个约 20s 跑完）
        // 用 ConcurrentHashMap：多线程并发 put，HashMap 非线程安全会丢数据
        Map<String, Boolean> probeResults = new ConcurrentHashMap<>();
        // 记录哪些 URL 在本轮探测队列里（用于区分"队列溢出未测"和"超时未完成"）
        Set<String> probeQueue = new java.util.HashSet<>();
        for (JSONObject src : actualProbe) {
            try { probeQueue.add(src.optString("bookSourceUrl", "")); } catch (Exception ignored) {}
        }
        int probeTimeoutCount = 0;
        if (!actualProbe.isEmpty()) {
            ExecutorService pool = Executors.newFixedThreadPool(16);
            CountDownLatch latch = new CountDownLatch(actualProbe.size());
            AtomicInteger done = new AtomicInteger(0);
            for (JSONObject src : actualProbe) {
                pool.execute(() -> {
                    String url = "";
                    try {
                        url = src.optString("bookSourceUrl", "");
                        // 直接探测源地址本身：旧实现只探域名根，bookSourceUrl 是子路径/API 的源
                        // 会被根路径 404 误判为不可达
                        boolean ok = probeHost(url);
                        probeResults.put(url, ok);
                    } catch (Exception e) {
                        probeResults.put(url, false);
                    } finally {
                        int d = done.incrementAndGet();
                        if (d % 20 == 0 || d == actualProbe.size()) {
                            prog("本地探测 " + d + "/" + actualProbe.size());
                        }
                        latch.countDown();
                    }
                });
            }
            boolean completed = true;
            // 上限 45s：100 个源 / 16 线程 × 3s ≈ 20s，留足抖动余量
            try { completed = latch.await(45, TimeUnit.SECONDS); }
            catch (InterruptedException ie) {
                Thread.currentThread().interrupt(); // 恢复中断标志，让上层决定
                completed = false;
            }
            pool.shutdownNow();
            if (!completed) {
                probeTimeoutCount = actualProbe.size() - done.get();
                android.util.Log.w("SyncWorker", "部分书源探测未完成（超时" + probeTimeoutCount + "个），保留历史状态");
            }
        }

        // Step 4: 合并结果 → 更新每个源的 enabled + 刷新健康缓存
        // 合并优先级：
        //   1. 本轮有明确探测结果（probeResults.containsKey） → 用本轮结果
        //   2. 本轮队列里但超时未完成（probeQueue 有但 probeResults 无） → 保留历史状态 oldH.localAvailable
        //   3. 队列外（队列超过 60 被截掉的，即既不在 probeQueue 也不在 probeResults）：
        //      a. 有 cachedResult（24h 内缓存）→ 用缓存
        //      b. 没缓存 → 保持 CI 默认 enabled=true（新源首次进入）
        JSONArray finalArr = new JSONArray();
        for (int i = 0; i < ciAliveOnly.length(); i++) {
            try {
                JSONObject src = ciAliveOnly.getJSONObject(i);
                String url = src.optString("bookSourceUrl", "");
                if (url.isEmpty()) continue;

                boolean localOk;
                HealthEntry oldH = cache.get(url);
                if (probeResults.containsKey(url)) {
                    localOk = probeResults.get(url);
                    // 更新缓存
                    int fc = localOk ? 0 : (oldH != null ? oldH.failCount + 1 : 1);
                    long retryDelayMs = localOk ? 0 : retryDelayFor(fc);
                    HealthEntry newH = new HealthEntry(
                            now, fc, localOk,
                            localOk ? 0 : now + retryDelayMs
                    );
                    cache.put(url, newH);
                } else if (probeQueue.contains(url)) {
                    // 在本轮队列里但超时未完成 → 保留历史状态（关键：不能把之前禁用的重新启用）
                    if (oldH != null) {
                        localOk = oldH.localAvailable; // 保留历史
                    } else {
                        localOk = src.optBoolean("enabled", true); // 首次进入
                    }
                } else if (cachedResult.containsKey(url)) {
                    localOk = cachedResult.get(url);
                } else {
                    // 队列外 + 没缓存 → 保持 CI 默认 enabled=true
                    localOk = src.optBoolean("enabled", true);
                }
                src.put("enabled", localOk);
                finalArr.put(src);
            } catch (Exception ignored) {}
        }
        if (probeTimeoutCount > 0) {
            prog("探测超时" + probeTimeoutCount + "个，已保留历史状态");
        }
        return finalArr;
    }

    /** 退避延迟：failCount 1→1h, 2→6h, 3→24h，封顶 48h */
    private long retryDelayFor(int failCount) {
        int h;
        switch (Math.min(failCount, 5)) {
            case 1: h = 1; break;
            case 2: h = 6; break;
            case 3: h = 24; break;
            default: h = 48; break;
        }
        return h * 3600 * 1000L;
    }

    /** 轻量 HTTP GET 探测（超时 3s，2xx/3xx/405=HEAD 不支持 都算活） */
    private boolean probeHost(String rootUrl) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(rootUrl);
            Proxy proxy = pickProxy(url);
            conn = (HttpURLConnection) (proxy == Proxy.NO_PROXY
                    ? url.openConnection() : url.openConnection(proxy));
            conn.setConnectTimeout(3000);
            conn.setReadTimeout(3000);
            conn.setRequestMethod("GET");
            conn.setRequestProperty("User-Agent",
                    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/142.0 Mobile");
            conn.setInstanceFollowRedirects(true);
            int code = conn.getResponseCode();
            // 2xx/3xx = 活；401/403 = 需登录/反爬但站点存在；405 = 方法不支持但服务在
            return (code >= 200 && code < 400) || code == 401 || code == 403 || code == 405;
        } catch (Exception e) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }
}
