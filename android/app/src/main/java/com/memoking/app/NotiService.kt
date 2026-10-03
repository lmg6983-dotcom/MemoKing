package com.memoking.app

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 알림 보관함 — 휴대폰에 온 다른 앱 알림(메신저·메일 등)을 모아 둔다 (데스크탑의 Windows 알림 보관함과 같은 모양).
 * 안드로이드의 "알림 접근 허용"을 켜야 동작하고, 모은 알림은 이 휴대폰 안(앱 저장공간)에만 남는다.
 */
class NotiService : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!NotiStore.enabled(this)) return
        try {
            NotiStore.fromNotification(this, sbn)?.let { NotiStore.add(this, it) }
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "알림을 보관하지 못했어요", e)
        }
    }
}

object NotiStore {
    private const val MAX = 3000
    private const val KEY_ENABLED = "historyEnabled"
    private const val REPEAT_MS = 10 * 60 * 1000L // 같은 알림이 다시 올라오면(갱신) 한 번만
    private val lock = Any()
    private var cache: JSONArray? = null

    /** 화면에 새 알림을 알린다 (앱이 열려 있을 때) */
    @Volatile var listener: (() -> Unit)? = null

    private fun file(ctx: Context) = File(ctx.filesDir, "notification-history.json")
    fun iconDir(ctx: Context) = File(ctx.filesDir, "notification-icons").apply { mkdirs() }

    fun enabled(ctx: Context) = Vaults.prefs(ctx).getBoolean(KEY_ENABLED, false)
    fun setEnabled(ctx: Context, on: Boolean) = Vaults.prefs(ctx).edit().putBoolean(KEY_ENABLED, on).apply()

    /** 안드로이드 설정에서 "알림 접근"을 허용했는가 */
    fun granted(ctx: Context): Boolean {
        val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
        val me = ComponentName(ctx, NotiService::class.java)
        return flat.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun load(ctx: Context): JSONArray = cache ?: try {
        JSONArray(file(ctx).readText())
    } catch (e: Exception) {
        JSONArray()
    }.also { cache = it }

    private fun save(ctx: Context, list: JSONArray) {
        cache = list
        val tmp = File(ctx.filesDir, "notification-history.json.tmp")
        tmp.writeText(list.toString())
        tmp.renameTo(file(ctx))
    }

    fun all(ctx: Context): JSONArray = synchronized(lock) { JSONArray(load(ctx).toString()) }

    fun add(ctx: Context, entry: JSONObject) {
        synchronized(lock) {
            val list = load(ctx)
            val now = System.currentTimeMillis()
            // 같은 앱·제목·내용이 조금 전에 있으면 갱신된 알림 → 건너뜀
            for (i in 0 until minOf(list.length(), 50)) {
                val e = list.getJSONObject(i)
                if (e.optString("appId") == entry.optString("appId") && e.optString("title") == entry.optString("title") &&
                    e.optString("body") == entry.optString("body") && now - e.optLong("ms") < REPEAT_MS
                ) return
            }
            val next = JSONArray().put(entry)
            for (i in 0 until minOf(list.length(), MAX - 1)) next.put(list.get(i))
            save(ctx, next)
        }
        listener?.invoke()
    }

    fun remove(ctx: Context, id: String): Boolean = synchronized(lock) {
        val list = load(ctx)
        val next = JSONArray()
        var found = false
        for (i in 0 until list.length()) {
            val e = list.getJSONObject(i)
            if (e.optString("id") == id) found = true else next.put(e)
        }
        if (found) save(ctx, next)
        found
    }

    fun clear(ctx: Context) = synchronized(lock) { save(ctx, JSONArray()) }

    private fun entry(source: String, appId: String, app: String, title: String, body: String, image: String?, memoId: String?): JSONObject {
        val ms = System.currentTimeMillis()
        val iso = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.ROOT)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }.format(java.util.Date(ms))
        return JSONObject()
            .put("id", ms.toString(36) + Integer.toHexString((Math.random() * 0xffffff).toInt()))
            .put("source", source).put("appId", appId).put("app", app)
            .put("title", title).put("body", body).put("time", iso).put("ms", ms)
            .put("image", image ?: JSONObject.NULL).put("memoId", memoId ?: JSONObject.NULL)
    }

    /** 메모킹 자신의 예약 알림도 보관함에 (누르면 그 메모가 열림) */
    fun addOwn(ctx: Context, title: String, body: String, memoId: String) {
        if (!enabled(ctx)) return
        add(ctx, entry("memoking", ctx.packageName, "메모킹", title, body, null, memoId))
    }

    fun fromNotification(ctx: Context, sbn: StatusBarNotification): JSONObject? {
        if (sbn.packageName == ctx.packageName) return null // 메모킹 알림은 addOwn 으로
        val n = sbn.notification
        // 계속 떠 있는 알림(음악·다운로드·통화 중), 묶음 머리 알림은 빼고
        if (sbn.isOngoing || n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0 || n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return null
        if (n.category == Notification.CATEGORY_PROGRESS || n.category == Notification.CATEGORY_TRANSPORT) return null
        val x = n.extras
        var title = x.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim() ?: ""
        var body = (x.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: x.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim() ?: ""
        // 메신저(카카오톡 등)의 대화형 알림: 마지막 메시지와 보낸 사람
        @Suppress("DEPRECATION")
        val messages = x.getParcelableArray(Notification.EXTRA_MESSAGES)
        if (!messages.isNullOrEmpty()) {
            val last = messages.last() as? android.os.Bundle
            val text = last?.getCharSequence("text")?.toString()?.trim()
            val sender = last?.getCharSequence("sender")?.toString()?.trim()
            val conversation = x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE)?.toString()?.trim()
            if (!text.isNullOrEmpty()) body = text
            if (!sender.isNullOrEmpty()) title = if (!conversation.isNullOrEmpty() && conversation != sender) "$conversation · $sender" else sender
        }
        if (title.isEmpty() && body.isEmpty()) return null
        val pm = ctx.packageManager
        val app = try {
            pm.getApplicationLabel(pm.getApplicationInfo(sbn.packageName, 0)).toString()
        } catch (e: Exception) {
            sbn.packageName
        }
        return entry("android", sbn.packageName, app, title, body, saveIcon(ctx, sbn.packageName), null)
    }

    // 앱 아이콘을 한 번만 그림 파일로 (보관함의 동그라미)
    private fun saveIcon(ctx: Context, pkg: String): String? {
        val name = "$pkg.png"
        val out = File(iconDir(ctx), name)
        if (out.exists()) return name
        return try {
            val d = ctx.packageManager.getApplicationIcon(pkg)
            val size = 96
            val bmp = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
            d.setBounds(0, 0, size, size)
            d.draw(Canvas(bmp))
            out.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            name
        } catch (e: Exception) {
            null
        }
    }
}
