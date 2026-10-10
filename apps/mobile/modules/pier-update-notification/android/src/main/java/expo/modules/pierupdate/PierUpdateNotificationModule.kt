package expo.modules.pierupdate

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

private const val CHANNEL_ID = "pier-updates"
private const val NOTIFICATION_ID = 0x50494552

/** One silent system notification, updated in place throughout an APK download. */
class PierUpdateNotificationModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PierUpdateNotification")

    Function("show") { version: String, state: String, downloaded: Double, total: Double ->
      val context = appContext.reactContext ?: return@Function
      val manager = NotificationManagerCompat.from(context)
      if (!manager.areNotificationsEnabled()) return@Function

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val channel = NotificationChannel(CHANNEL_ID, "应用更新", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Pier 安装包下载进度与安装提示"
          setShowBadge(false)
          enableVibration(false)
          setSound(null, null)
        }
        manager.createNotificationChannel(channel)
      }

      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
        action = Intent.ACTION_VIEW
        data = Uri.parse("pier://settings")
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
      } ?: return@Function
      val contentIntent = PendingIntent.getActivity(
        context, NOTIFICATION_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      )
      val downloading = state == "downloading"
      val percent = if (total > 0) (downloaded.coerceIn(0.0, total) / total * 100).toInt() else 0
      val text = when (state) {
        "downloading" -> if (total > 0) {
          "正在下载 $percent% · ${formatBytes(downloaded)} / ${formatBytes(total)}"
        } else {
          "正在下载 ${formatBytes(downloaded)}"
        }
        "ready" -> "安装包已下载并校验，点击打开 Pier 安装"
        "installing" -> "请在系统安装界面中确认更新"
        else -> "更新失败，点击打开 Pier 重试"
      }
      val notification = NotificationCompat.Builder(context, CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_pier_update)
        .setContentTitle("Pier v$version")
        .setContentText(text)
        .setSubText("应用更新")
        .setContentIntent(contentIntent)
        .setOnlyAlertOnce(true)
        .setSilent(true)
        .setShowWhen(false)
        .setOngoing(downloading)
        .setAutoCancel(!downloading)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setCategory(if (downloading) NotificationCompat.CATEGORY_PROGRESS else NotificationCompat.CATEGORY_STATUS)
        .apply {
          if (downloading) setProgress(100, percent, total <= 0)
        }
        .build()
      try {
        manager.notify(NOTIFICATION_ID, notification)
      } catch (_: SecurityException) {
        // Notification permission can be revoked while a download is running.
      }
    }

    Function<Unit>("dismiss") {
      val context = appContext.reactContext ?: return@Function
      NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }
  }

  private fun formatBytes(bytes: Double): String {
    val value = bytes.coerceAtLeast(0.0)
    return when {
      value >= 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MB", value / (1024 * 1024))
      value >= 1024 -> String.format(Locale.ROOT, "%.1f KB", value / 1024)
      else -> "${value.toLong()} B"
    }
  }
}
