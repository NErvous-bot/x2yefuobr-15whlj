package io.nervous.sourcesync;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * v3.22：开机 / 应用更新后自动恢复每日同步任务链。
 *
 * 背景（真实故障）：v3.21 及更早的每日任务是一条 OneTimeWorkRequest 链——
 * 本轮结束时预约下一次 05:00。链条有两个断点：
 *
 *   1) 只有 Result.Success 才预约下一次（已在本版修复为无论成败都预约）
 *   2) 用户重启手机或覆盖安装 APK 后，WorkManager 里排队的任务会丢失，
 *      而应用自身没有任何重建时机，链条从此永久断开。
 *
 * 第 2 点表现为「用着用着就再也没收到后台通知」。本接收器补上重建时机：
 * BOOT_COMPLETED 覆盖重启，MY_PACKAGE_REPLACED 覆盖升级安装。
 *
 * 注意：国产 ROM（vivo/OPPO/小米）还要求用户手动允许「自启动」，
 * 否则系统根本不会投递这个广播——代码只能保证「收到广播后能恢复」。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)) {
            // 只排程，不在广播里跑同步：广播有 10 秒超时限制，跑同步必被系统掐断
            SyncWorker.scheduleDailyFrom(context.getApplicationContext());
        }
    }
}
