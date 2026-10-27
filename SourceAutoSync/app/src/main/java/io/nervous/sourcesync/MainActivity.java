package io.nervous.sourcesync;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.widget.TextView;

import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;

import java.util.List;
import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity {

    private TextView status;
    private volatile String progress;   // 实时进度（来自 WorkInfo.progress）
    private String lastRendered;        // 上次渲染的整段文案，相同则跳过 setText
    private final Handler poll = new Handler();
    // WorkManager 的查询是阻塞式 Future.get()，必须在后台线程跑：
    // 旧实现放在主线程每秒 .get()，低端机/数据库繁忙时会卡界面甚至 ANR
    private final java.util.concurrent.ExecutorService queryExec =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    private volatile boolean querying;   // 上一次查询没回来就跳过本轮，避免任务堆积

    private final Runnable pollTask = new Runnable() {
        @Override public void run() {
            if (!querying) {
                querying = true;
                queryExec.execute(() -> {
                    String found = null;
                    try {
                        WorkManager wm = WorkManager.getInstance(MainActivity.this);
                        for (String name : new String[]{"manual", "daily-next", "daily"}) {
                            List<WorkInfo> list = wm.getWorkInfosForUniqueWork(name).get();
                            if (list != null && !list.isEmpty()) {
                                WorkInfo wi = list.get(0);
                                if (wi.getState() == WorkInfo.State.RUNNING) {
                                    String m = wi.getProgress().getString("msg");
                                    found = (m == null ? "正在同步…" : m);
                                    break;
                                }
                            }
                        }
                    } catch (Exception ignored) {
                    } finally {
                        querying = false;
                    }
                    final String result = found;   // null = 没有任务在跑，显示历史结果
                    runOnUiThread(() -> {
                        progress = result;
                        refresh();
                    });
                });
            }
            poll.postDelayed(this, 1000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.status);

        // Android 13+ 通知运行时权限：启动时申请一次，授权后同步结束即可发系统通知
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        // manual sync button (ignores schedule, syncs immediately)
        findViewById(R.id.syncNow).setOnClickListener(v -> {
            WorkManager.getInstance(this).enqueueUniqueWork("manual",
                    ExistingWorkPolicy.REPLACE,
                    new OneTimeWorkRequest.Builder(SyncWorker.class)
                            .addTag("manual")
                            .setInputData(new androidx.work.Data.Builder()
                                    .putString("mode", "manual").build())
                            .build());
            refresh();
        });

        // 固定 05:00（v3.20）：24h 周期任务从「上次执行完成」重新计时，逐日漂移；
        // 改为一次性任务链 daily-next——每轮成功后 Worker 自己预约次日 05:00。
        // 这里取消旧的周期任务，并在没有待执行任务时补一条（避免用户长期不开本App 断链）。
        WorkManager.getInstance(this).cancelUniqueWork("daily");
        ensureNextDailyScheduled();

        refresh();
    }

    /** 没有待执行的 daily-next 时才预约，避免每次打开 App 都把时间往后推 */
    private void ensureNextDailyScheduled() {
        queryExec.execute(() -> {
            try {
                List<WorkInfo> list = WorkManager.getInstance(this)
                        .getWorkInfosForUniqueWork("daily-next").get();
                for (WorkInfo wi : list) {
                    WorkInfo.State st = wi.getState();
                    if (st == WorkInfo.State.ENQUEUED || st == WorkInfo.State.RUNNING
                            || st == WorkInfo.State.BLOCKED) return;
                }
            } catch (Exception ignored) {}
            try {
                WorkManager.getInstance(this).enqueueUniqueWork("daily-next",
                        ExistingWorkPolicy.REPLACE,
                        new OneTimeWorkRequest.Builder(SyncWorker.class)
                                .setInitialDelay(SyncWorker.delayUntilNext5am(),
                                        TimeUnit.MILLISECONDS)
                                .setConstraints(new androidx.work.Constraints.Builder()
                                        .setRequiredNetworkType(androidx.work.NetworkType.CONNECTED)
                                        .build())
                                .setBackoffCriteria(androidx.work.BackoffPolicy.EXPONENTIAL,
                                        30, TimeUnit.MINUTES)
                                .build());
            } catch (Exception ignored) {}
        });
    }

    private void refresh() {
        android.content.SharedPreferences sp = getSharedPreferences("sync", MODE_PRIVATE);
        String last = sp.getString("last", "尚未同步，点上方按钮试试");
        StringBuilder hist = new StringBuilder();
        String old = sp.getString("hist", null);
        if (old != null) {
            for (String s : old.split("\n")) {
                if (s.isEmpty()) continue;
                // 兼容旧版长文案：单行超40字截断，避免界面堆叠
                if (s.length() > 40) s = s.substring(0, 40) + "…";
                hist.append('\n').append(s);
            }
        }
        String progLine = (progress == null) ? "" : "\n▶ " + progress + "\n";
        String text =
                "同步器 v" + BuildConfig.VERSION_NAME + progLine +
                "\n上次：" + last + "\n" +
                (hist.length() == 0 ? "" : "\n最近记录：" + hist + "\n") +
                "\n每天自动检查更新（有更新才下载写入）· 镜像自动切换 · 全程验签";
        // 文案没变就不重设 TextView：每秒无条件 setText 会触发整段重排/绘制
        if (!text.equals(lastRendered)) {
            lastRendered = text;
            status.setText(text);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        poll.postDelayed(pollTask, 200);
    }

    @Override
    protected void onPause() {
        super.onPause();
        poll.removeCallbacks(pollTask);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        poll.removeCallbacks(pollTask);
        queryExec.shutdownNow();
    }
}
