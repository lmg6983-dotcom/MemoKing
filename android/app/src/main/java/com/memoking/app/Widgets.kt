package com.memoking.app

import android.app.Activity
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StrikethroughSpan
import android.text.style.StyleSpan
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import com.memoking.app.drive.DriveSync
import org.json.JSONArray
import org.json.JSONObject

/**
 * 홈 화면 위젯: 메모 한 개를 홈 화면에 — 제목·글 줄·체크리스트(누르면 바로 체크).
 *   보일 내용은 화면(웹)이 만들어 보낸다 (core/widget-lines.js → publish). 앱이 꺼져 있어도 마지막 내용이 보인다.
 *   체크는 앱(여기)이 메모 파일의 i 번째 할 일을 직접 바꾼다 — 할 일 세는 규칙은 widget-lines.js 와 같다.
 */
object Widgets {
    private const val MAP = "widget_map" // 위젯 id → 메모 id
    private const val DATA = "widget_data" // 메모 id → 보일 내용(JSON)
    const val EXTRA_MEMO = "memoId"
    const val EXTRA_TASK = "task"
    const val ACTION_TAP = "com.memoking.app.WIDGET_TAP"
    const val ACTION_PICK = "com.memoking.app.WIDGET_PICK"
    const val ACTION_PINNED = "com.memoking.app.WIDGET_PINNED"

    private fun map(ctx: Context) = ctx.getSharedPreferences(MAP, Context.MODE_PRIVATE)
    private fun data(ctx: Context) = ctx.getSharedPreferences(DATA, Context.MODE_PRIVATE)
    private fun manager(ctx: Context) = AppWidgetManager.getInstance(ctx)
    private fun allIds(ctx: Context) = manager(ctx).getAppWidgetIds(ComponentName(ctx, MemoWidget::class.java))

    fun memoOf(ctx: Context, widgetId: Int): String? = map(ctx).getString(widgetId.toString(), null)

    /** 위젯에 놓인 메모 id 들 (화면이 이 메모들의 내용을 보내 준다) */
    fun memoIds(ctx: Context): JSONArray = JSONArray(allIds(ctx).mapNotNull { memoOf(ctx, it) }.distinct())

    fun assign(ctx: Context, widgetId: Int, memoId: String) {
        map(ctx).edit().putString(widgetId.toString(), memoId).apply()
        update(ctx, intArrayOf(widgetId))
    }

    fun forget(ctx: Context, widgetIds: IntArray) {
        map(ctx).edit().apply { widgetIds.forEach { remove(it.toString()) } }.apply()
        // 어느 위젯에도 없는 메모의 내용은 지운다
        val used = allIds(ctx).mapNotNull { memoOf(ctx, it) }.toSet()
        data(ctx).edit().apply { data(ctx).all.keys.filter { it !in used }.forEach { remove(it) } }.apply()
    }

    /** 화면이 보낸 내용: [{id, title, color, file, lines:[{t, kind, done?, i?}]}] — 지워진 메모는 {id, gone:true} */
    fun publish(ctx: Context, memos: JSONArray) {
        val edit = data(ctx).edit()
        for (k in 0 until memos.length()) {
            val m = memos.getJSONObject(k)
            if (m.optBoolean("gone")) edit.remove(m.getString("id")) else edit.putString(m.getString("id"), m.toString())
        }
        edit.apply()
        update(ctx, allIds(ctx))
    }

    fun memo(ctx: Context, memoId: String): JSONObject? = data(ctx).getString(memoId, null)?.let {
        try {
            JSONObject(it)
        } catch (e: Exception) {
            null
        }
    }

    /** "메모 메뉴 › 홈 화면에 놓기" — 런처가 위치를 묻고, 놓이면 ACTION_PINNED 로 위젯 id 를 알려 준다 */
    fun requestPin(ctx: Context, memoId: String): Boolean {
        val mgr = manager(ctx)
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !mgr.isRequestPinAppWidgetSupported) return false
        val callback = PendingIntent.getBroadcast(
            ctx, memoId.hashCode(),
            Intent(ctx, MemoWidget::class.java).setAction(ACTION_PINNED).putExtra(EXTRA_MEMO, memoId),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE, // 런처가 위젯 id 를 채워 넣는다
        )
        return mgr.requestPinAppWidget(ComponentName(ctx, MemoWidget::class.java), null, callback)
    }

    fun update(ctx: Context, ids: IntArray) {
        val mgr = manager(ctx)
        for (id in ids) {
            mgr.updateAppWidget(id, views(ctx, id))
            mgr.notifyAppWidgetViewDataChanged(id, R.id.widget_list)
        }
    }

    // ---------- 모양 ----------

    private val LIGHT = mapOf(
        "yellow" to "#FFF4B8", "green" to "#DDF5DF", "pink" to "#FFE0EC", "purple" to "#EDE3FF",
        "blue" to "#DDEEFF", "gray" to "#F1F0EC", "charcoal" to "#1C1C1B",
    )
    private val DARK = mapOf(
        "yellow" to "#3A3317", "green" to "#1E3322", "pink" to "#3D2230", "purple" to "#2C2440",
        "blue" to "#1C2D42", "gray" to "#262624", "charcoal" to "#141413",
    )

    private fun night(ctx: Context) =
        (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    fun background(ctx: Context, color: String): Int =
        Color.parseColor((if (night(ctx)) DARK else LIGHT)[color] ?: (if (night(ctx)) DARK else LIGHT).getValue("yellow"))

    fun darkText(ctx: Context, color: String) = !night(ctx) && color != "charcoal"
    fun textColor(ctx: Context, color: String) = if (darkText(ctx, color)) Color.parseColor("#1F1F1C") else Color.parseColor("#F5F4EF")
    fun mutedColor(ctx: Context, color: String) = if (darkText(ctx, color)) Color.parseColor("#8A1F1F1C") else Color.parseColor("#94F5F4EF")

    private fun activityIntent(ctx: Context, intent: Intent, code: Int, mutable: Boolean = false): PendingIntent =
        PendingIntent.getActivity(
            ctx, code, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE),
        )

    private fun views(ctx: Context, widgetId: Int): RemoteViews {
        val v = RemoteViews(ctx.packageName, R.layout.widget_memo)
        val memoId = memoOf(ctx, widgetId)
        val memo = memoId?.let { memo(ctx, it) }
        val color = memo?.optString("color", "yellow") ?: "yellow"
        v.setInt(R.id.widget_bg, "setColorFilter", background(ctx, color))
        v.setTextColor(R.id.widget_title, textColor(ctx, color))
        v.setTextColor(R.id.widget_empty, mutedColor(ctx, color))
        v.setInt(R.id.widget_add, "setColorFilter", textColor(ctx, color))
        v.setOnClickPendingIntent(
            R.id.widget_add,
            activityIntent(ctx, Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_NEW_MEMO), 1),
        )

        if (memoId == null || memo == null) {
            // 위젯 고르기 목록에서 놓은 위젯 — 누르면 앱에서 보일 메모를 고른다
            v.setTextViewText(R.id.widget_title, ctx.getString(R.string.app_name))
            v.setTextViewText(R.id.widget_empty, ctx.getString(if (memoId == null) R.string.widget_pick else R.string.widget_loading))
            v.setViewVisibility(R.id.widget_list, View.GONE)
            v.setViewVisibility(R.id.widget_empty, View.VISIBLE)
            val pick = Intent(ctx, MainActivity::class.java).setAction(if (memoId == null) ACTION_PICK else MainActivity.ACTION_OPEN_MEMO)
                .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
                .putExtra(EXTRA_MEMO, memoId ?: "")
                .setData(Uri.parse("memoking://widget/$widgetId")) // 위젯마다 다른 PendingIntent 가 되게
            v.setOnClickPendingIntent(R.id.widget_root, activityIntent(ctx, pick, 1000 + widgetId))
            return v
        }

        v.setTextViewText(R.id.widget_title, memo.optString("title"))
        val open = Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_MEMO).putExtra(EXTRA_MEMO, memoId)
            .setData(Uri.parse("memoking://widget/$widgetId/open"))
        v.setOnClickPendingIntent(R.id.widget_title, activityIntent(ctx, open, 2000 + widgetId))
        v.setOnClickPendingIntent(R.id.widget_root, activityIntent(ctx, open, 3000 + widgetId))

        val lines = memo.optJSONArray("lines") ?: JSONArray()
        v.setViewVisibility(R.id.widget_list, if (lines.length() > 0) View.VISIBLE else View.GONE)
        v.setViewVisibility(R.id.widget_empty, if (lines.length() > 0) View.GONE else View.VISIBLE)
        v.setTextViewText(R.id.widget_empty, ctx.getString(R.string.widget_empty))
        val adapter = Intent(ctx, MemoWidgetService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            .setData(Uri.parse("memoking://widget/$widgetId/list"))
        @Suppress("DEPRECATION")
        v.setRemoteAdapter(R.id.widget_list, adapter)
        // 줄을 누르면: 할 일은 체크, 다른 줄은 메모 열기 (보이지 않는 WidgetTapActivity 가 받는다 — 앱 화면을 띄우지 않고 체크)
        val template = Intent(ctx, WidgetTapActivity::class.java).setAction(ACTION_TAP)
            .setData(Uri.parse("memoking://widget/$widgetId/tap"))
        v.setPendingIntentTemplate(R.id.widget_list, activityIntent(ctx, template, 4000 + widgetId, mutable = true))
        return v
    }

    // ---------- 체크 ----------

    private val TASK = Regex("""^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\](?:\s+|$)""")
    private val FENCE = Regex("""^\s*(```|~~~)""")

    /**
     * 메모 파일의 index 번째 할 일을 체크/해제한 새 글 (머리말은 건드리지 않음). 찾지 못하면 null.
     * 할 일 세는 규칙은 app/js/core/widget-lines.js 와 같다.
     */
    fun toggleTaskText(text: String, index: Int): String? {
        val lines = text.split("\n").toMutableList()
        var start = 0
        if (lines.firstOrNull()?.trimEnd() == "---") {
            val end = (1 until lines.size).firstOrNull { lines[it].trimEnd() == "---" } ?: return null
            start = end + 1
        }
        var fence = false
        var n = 0
        for (k in start until lines.size) {
            val line = lines[k]
            if (FENCE.containsMatchIn(line)) {
                fence = !fence
                continue
            }
            if (fence) continue
            val m = TASK.find(line) ?: continue
            if (n++ != index) continue
            val box = m.groups[1]!!.range.first
            lines[k] = line.substring(0, box) + (if (line[box] == ' ') "x" else " ") + line.substring(box + 1)
            return lines.joinToString("\n")
        }
        return null
    }

    /** 위젯에서 체크: 파일을 고치고, 위젯도 바로 그 모양으로 */
    fun toggleTask(ctx: Context, memoId: String, index: Int): Boolean {
        val memo = memo(ctx, memoId) ?: return false
        val file = memo.optString("file").ifEmpty { return false }
        val storage = Vaults.current(ctx) ?: return false
        val text = storage.openRead(file).use { it.readBytes().toString(Charsets.UTF_8) }
        val next = toggleTaskText(text, index) ?: return false
        storage.write(file) { it.write(next.toByteArray(Charsets.UTF_8)) }
        DriveSync.request(ctx, 3000)
        val lines = memo.optJSONArray("lines") ?: JSONArray()
        for (k in 0 until lines.length()) {
            val l = lines.getJSONObject(k)
            if (l.optString("kind") == "task" && l.optInt("i", -1) == index) l.put("done", !l.optBoolean("done"))
        }
        data(ctx).edit().putString(memoId, memo.toString()).apply()
        update(ctx, allIds(ctx).filter { memoOf(ctx, it) == memoId }.toIntArray())
        // 앱이 열려 있으면 메모 폴더를 다시 읽게
        MainActivity.visible?.let { a -> a.runOnUiThread { a.emit("widget", JSONObject().put("memoId", memoId)) } }
        return true
    }
}

class MemoWidget : AppWidgetProvider() {
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) = Widgets.update(ctx, ids)

    override fun onDeleted(ctx: Context, ids: IntArray) = Widgets.forget(ctx, ids)

    override fun onAppWidgetOptionsChanged(ctx: Context, mgr: AppWidgetManager, id: Int, options: Bundle) =
        Widgets.update(ctx, intArrayOf(id))

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Widgets.ACTION_PINNED) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            val memoId = intent.getStringExtra(Widgets.EXTRA_MEMO)
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID && !memoId.isNullOrEmpty()) Widgets.assign(ctx, id, memoId)
            return
        }
        super.onReceive(ctx, intent)
    }
}

/** 위젯 목록의 줄들 */
class MemoWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Factory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, 0))

    private class Factory(private val ctx: Context, private val widgetId: Int) : RemoteViewsFactory {
        private var memoId: String? = null
        private var color = "yellow"
        private var lines = JSONArray()

        override fun onCreate() = Unit
        override fun onDestroy() = Unit

        override fun onDataSetChanged() {
            memoId = Widgets.memoOf(ctx, widgetId)
            val memo = memoId?.let { Widgets.memo(ctx, it) }
            color = memo?.optString("color", "yellow") ?: "yellow"
            lines = memo?.optJSONArray("lines") ?: JSONArray()
        }

        override fun getCount() = lines.length()
        override fun getViewTypeCount() = 1
        override fun hasStableIds() = false
        override fun getItemId(position: Int) = position.toLong()
        override fun getLoadingView(): RemoteViews? = null

        override fun getViewAt(position: Int): RemoteViews {
            val v = RemoteViews(ctx.packageName, R.layout.widget_row)
            val line = lines.optJSONObject(position) ?: return v
            val kind = line.optString("kind")
            val done = line.optBoolean("done")
            val text = line.optString("t")
            val fg = Widgets.textColor(ctx, color)
            val shown = SpannableString(if (kind == "bullet") "• $text" else text)
            if (kind == "h") shown.setSpan(StyleSpan(Typeface.BOLD), 0, shown.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (kind == "task" && done) shown.setSpan(StrikethroughSpan(), 0, shown.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            v.setTextViewText(R.id.row_text, shown)
            v.setTextColor(R.id.row_text, if (kind == "task" && done) Widgets.mutedColor(ctx, color) else fg)
            v.setTextViewTextSize(R.id.row_text, android.util.TypedValue.COMPLEX_UNIT_SP, if (kind == "h") 15f else 14f)
            if (kind == "task") {
                v.setViewVisibility(R.id.row_check, View.VISIBLE)
                v.setImageViewResource(R.id.row_check, if (done) R.drawable.ic_widget_checked else R.drawable.ic_widget_unchecked)
                v.setInt(R.id.row_check, "setColorFilter", fg)
                v.setContentDescription(R.id.row_check, if (done) "끝냄: $text" else "할 일: $text")
            } else {
                v.setViewVisibility(R.id.row_check, View.GONE)
            }
            val fill = Intent().putExtra(Widgets.EXTRA_MEMO, memoId ?: "")
            if (kind == "task") fill.putExtra(Widgets.EXTRA_TASK, line.optInt("i", -1))
            v.setOnClickFillInIntent(R.id.row, fill)
            return v
        }
    }
}

/**
 * 위젯 줄을 눌렀을 때 잠깐 열리는 보이지 않는 화면 — 할 일은 체크만 하고 바로 닫고, 다른 줄은 메모를 연다.
 * (위젯 누르기를 방송으로 받아 앱을 띄우는 방식은 안드로이드가 막으므로 화면으로 받는다)
 */
class WidgetTapActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val memoId = intent.getStringExtra(Widgets.EXTRA_MEMO).orEmpty()
        val task = intent.getIntExtra(Widgets.EXTRA_TASK, -1)
        if (memoId.isNotEmpty() && task >= 0) {
            val ok = try {
                Widgets.toggleTask(applicationContext, memoId, task)
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "위젯 체크 실패", e)
                false
            }
            if (!ok) openMemo(memoId) // 파일을 못 찾았으면(이름이 바뀌었는 등) 앱에서 열어 다시 맞추게
        } else if (memoId.isNotEmpty()) {
            openMemo(memoId)
        }
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private fun openMemo(memoId: String) {
        startActivity(
            Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_MEMO).putExtra(Widgets.EXTRA_MEMO, memoId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
