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
        val saved = JSONArray(Vaults.prefs(ctx).getString(SCHEDULE, "[]"))
        // 꺼져 있는 사이 지난 알림(하루 안): 앱을 열 때까지 기다리지 않고 바로 알린다 (예전: 다시 켠 뒤 앱을 열어야 알았다)
        val now = System.currentTimeMillis()
        val missed = (0 until saved.length()).map { saved.getJSONObject(it) }.filter {
            val at = it.optLong("at")
            val key = it.optString("key")
            at <= now && at >= now - 24L * 60 * 60 * 1000 && key.isNotEmpty() && !wasFired(ctx, key, at)
        }
        for (item in missed) markFired(ctx, item.optString("key"), item.optLong("at"))
        // 하나면 그 알림 그대로, 여럿이면 한 알림으로 묶는다 (다시 켜자마자 알림이 쏟아지지 않게 — 누르면 메모킹)
        if (missed.size == 1) {
            val item = missed[0]
            Notifier.show(ctx, item.optString("key"), item.optString("title"), "놓친 알림 · ${item.optString("text")}", item.optString("memoId"), item.optString("label"))
        } else if (missed.size > 1) {
            val list = missed.joinToString("\n") { "· ${it.optString("title").ifEmpty { "메모" }} ${it.optString("text")}".trim() }
            Notifier.show(ctx, "missed@$now", "놓친 알림 ${missed.size}개", list, "", "휴대폰이 꺼져 있는 사이 지난 알림이에요")
        }
        schedule(ctx, saved)
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
        if (intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) UpdateRestart.afterUpdate(context)
    }
}

/**
 * 앱 안 업데이트가 끝나면 메모킹을 다시 켠다 — 설치하는 동안 안드로이드가 앱을 끄고, 새 버전을 저절로 켜 주지 않는다.
 *   업데이트를 시작할 때 표시해 두고(mark), 새 버전이 깔리면(MY_PACKAGE_REPLACED) 그 표시가 있을 때만 화면을 연다.
 *   안드로이드 10 이상은 뒤에서 화면을 여는 것을 막을 수 있어 "눌러서 다시 열기" 알림도 함께 — 앱이 열리면 지운다 (clear)
 */
object UpdateRestart {
    private const val PREFS = "memoking_update"
    private const val KEY = "restart_at"
    private const val NOTE_ID = 7_311 // 녹음 알림(RecorderService 7301)과 다른 번호 — 켤 때마다 지우는 이 알림이 녹음 알림을 지우지 않게
    private const val WINDOW_MS = 30 * 60_000L // 업데이트를 시작하고 이 안에 깔린 것만 (다른 경로의 업데이트로 켜지지 않게)

    fun mark(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY, System.currentTimeMillis()).apply()
    }

    fun afterUpdate(ctx: Context) {
        val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val at = prefs.getLong(KEY, 0L)
        prefs.edit().remove(KEY).apply()
        if (at == 0L || System.currentTimeMillis() - at > WINDOW_MS) return
        val open = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        try {
            ctx.startActivity(open)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "업데이트 뒤 다시 켜지 못했어요", e)
        }
        // 뒤에서 화면을 열지 못한 휴대폰을 위해: 눌러서 여는 알림 (앱이 열리면 clear 가 지운다)
        try {
            Notifier.ensureChannel(ctx)
            val content = PendingIntent.getActivity(ctx, NOTE_ID, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            val note = Notification.Builder(ctx, Notifier.CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_crown)
                .setColor(0xFFFFCC00.toInt())
                .setContentTitle("메모킹을 새 버전으로 바꿨어요")
                .setContentText("눌러서 다시 열어요")
                .setContentIntent(content)
                .setAutoCancel(true)
                .build()
            ctx.getSystemService(NotificationManager::class.java)?.notify(NOTE_ID, note)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "업데이트 알림", e)
        }
    }

    /** 앱이 열렸으면 "다시 열어요" 알림은 필요 없다 */
    fun clear(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java)?.cancel(NOTE_ID)
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
