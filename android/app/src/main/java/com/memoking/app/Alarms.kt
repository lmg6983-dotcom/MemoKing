package com.memoking.app

import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

/**
 * 예약 알림. 언제 울릴지는 화면(웹)이 메모 파일의 reminders 로 계산해서(core/reminders.js) 넘겨주고,
 * 여기서는 시스템 알람에 맡겨 앱이 꺼져 있어도 제때 알림이 뜨게 한다.
 * 반복 알림은 앞으로 몇 회차를 한꺼번에 받아 두므로 앱을 한동안 열지 않아도 계속 울린다.
 * 울린 기록(fired)은 앱이 다시 켜졌을 때 같은 알림을 또 울리지 않고 메모 파일에 last 만 적는 데 쓴다.
 */
object Alarms {
    private const val SCHEDULE = "alarms"
    private const val FIRED = "fired"
    private const val MAX = 200 // 시스템이 앱마다 허용하는 알람 수(500)보다 넉넉히 적게

    fun exactAllowed(ctx: Context): Boolean {
        val am = ctx.getSystemService(AlarmManager::class.java)!!
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
    }

    // 같은 알림의 여러 회차(매일 반복 등)를 따로 걸 수 있게 알림 키 + 시각으로 구분한다
    private fun slot(item: JSONObject) = item.optString("key") + "@" + item.optLong("at")

    private fun pending(ctx: Context, item: JSONObject, create: Boolean): PendingIntent? {
        val slot = slot(item)
        val intent = Intent(ctx, AlarmReceiver::class.java)
            .setData(Uri.parse("memoking://alarm/" + Uri.encode(slot)))
        if (create) intent.putExtra("alarm", item.toString())
        val flags = PendingIntent.FLAG_IMMUTABLE or if (create) PendingIntent.FLAG_UPDATE_CURRENT else PendingIntent.FLAG_NO_CREATE
        return PendingIntent.getBroadcast(ctx, slot.hashCode(), intent, flags)
    }

    /** 예약 목록을 통째로 바꾼다 (빠진 것은 취소) */
    fun schedule(ctx: Context, items: JSONArray) {
        val prefs = Vaults.prefs(ctx)
        val am = ctx.getSystemService(AlarmManager::class.java)!!
        val old = JSONArray(prefs.getString(SCHEDULE, "[]"))
        val now = System.currentTimeMillis()
        val next = (0 until items.length()).map { items.getJSONObject(it) }
            .filter { it.optLong("at") > now }
            .sortedBy { it.optLong("at") }
            .take(MAX)
        val keep = next.map(::slot).toSet()
        for (i in 0 until old.length()) {
            val item = old.getJSONObject(i)
            if (slot(item) !in keep) pending(ctx, item, false)?.let { am.cancel(it); it.cancel() }
        }
        for (item in next) {
            val pi = pending(ctx, item, true) ?: continue
            val at = item.getLong("at")
            if (exactAllowed(ctx)) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
            else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        }
        prefs.edit().putString(SCHEDULE, JSONArray(next).toString()).apply()
    }

    /** 휴대폰을 다시 켰을 때: 기억해 둔 예약을 다시 건다 */
    fun restore(ctx: Context) {
        schedule(ctx, JSONArray(Vaults.prefs(ctx).getString(SCHEDULE, "[]")))
    }

    fun markFired(ctx: Context, key: String, at: Long) {
        val prefs = Vaults.prefs(ctx)
        val fired = JSONObject(prefs.getString(FIRED, "{}"))
        fired.put(key, at)
        // 오래된 기록은 버린다 (30일)
        val cutoff = System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000
        fired.keys().asSequence().toList().forEach { if (fired.optLong(it) < cutoff) fired.remove(it) }
        prefs.edit().putString(FIRED, fired.toString()).apply()
    }

    fun wasFired(ctx: Context, key: String, at: Long): Boolean {
        val fired = JSONObject(Vaults.prefs(ctx).getString(FIRED, "{}"))
        return fired.has(key) && fired.optLong(key) >= at - 60_000
    }
}

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val item = intent.getStringExtra("alarm")?.let(::JSONObject) ?: return
        val key = item.getString("key")
        Alarms.markFired(context, key, item.optLong("at"))
        Notifier.show(context, key, item.optString("title"), item.optString("text"), item.optString("memoId"), item.optString("label"))
        // 앱이 앞에 떠 있으면 화면에도 알려 "메모 띄우기" 알림은 바로 그 메모를 연다
        MainActivity.visible?.onAlarm(item)
    }
}

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Alarms.restore(context)
    }
}

object Notifier {
    const val CHANNEL = "reminders"

    fun ensureChannel(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)!!
        if (nm.getNotificationChannel(CHANNEL) != null) return
        val channel = NotificationChannel(CHANNEL, ctx.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH)
        channel.description = ctx.getString(R.string.channel_reminders_desc)
        nm.createNotificationChannel(channel)
    }

    /** 알림을 누르면 그 메모가 열린다 */
    fun show(ctx: Context, key: String, title: String, text: String, memoId: String, label: String) {
        ensureChannel(ctx)
        val open = Intent(ctx, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_MEMO)
            .setData(Uri.parse("memoking://memo/" + Uri.encode(memoId) + "?k=" + Uri.encode(key)))
            .putExtra("memoId", memoId)
            .putExtra("label", label.ifEmpty { text })
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val content = PendingIntent.getActivity(ctx, key.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val notification = Notification.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_crown)
            .setColor(0xFFFFCC00.toInt())
            .setContentTitle(title.ifEmpty { "메모킹" })
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setCategory(Notification.CATEGORY_REMINDER)
            .setContentIntent(content)
            .setAutoCancel(true)
            .build()
        NotiStore.addOwn(ctx, title.ifEmpty { "메모킹" }, label.ifEmpty { text }, memoId)
        try {
            ctx.getSystemService(NotificationManager::class.java)!!.notify(key.hashCode(), notification)
        } catch (e: SecurityException) {
            // 알림 권한이 꺼져 있음 — 앱을 열면 다시 물어본다
        }
    }
}
