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
    const val EXTRA_TASK_TEXT = "taskText" // 위젯에 보인 할 일의 원래 글 (순서가 바뀌었어도 같은 할 일을 찾게)
    const val EXTRA_TASK_DONE = "taskDone" // 위젯에 보인 체크 상태 (누르면 그 반대로)
    const val ACTION_TAP = "com.memoking.app.WIDGET_TAP"
    const val ACTION_PICK = "com.memoking.app.WIDGET_PICK"
    const val ACTION_PINNED = "com.memoking.app.WIDGET_PINNED"
    const val EXTRA_TOKEN = "token"
    private const val PIN_TOKENS = "widget_pin_tokens" // 놓기 요청마다 한 번 쓰는 표 (메모 id → "표|요청 시각")
    private const val PIN_WAIT_MS = 10 * 60_000L
    private const val GONE_CONFIRM_MS = 60_000L // 메모 파일이 이만큼 계속 없으면 지워진 것으로 본다
    private const val PICK_TOKEN = "widget_pick_token"

    /** 위젯의 파일 일(체크·잠긴 메모 숨기기)은 이 한 줄로 차례대로 — 빠르게 두 번 눌러도 서로 덮어쓰지 않게 */
    val io: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()

    /**
     * 위젯을 눌러 "보일 메모 고르기" 를 시작할 때 함께 보내는 이 앱만 아는 표 — 메모킹 화면은 밖에 열려 있으므로
     * 다른 앱이 고르기를 흉내 내 다음에 누르는 메모를 엉뚱한 위젯에 놓게 하지 못하게
     */
    fun pickToken(ctx: Context): String {
        val prefs = ctx.getSharedPreferences(PIN_TOKENS, Context.MODE_PRIVATE)
        return prefs.getString(PICK_TOKEN, null) ?: java.util.UUID.randomUUID().toString().also { prefs.edit().putString(PICK_TOKEN, it).apply() }
    }

    private fun map(ctx: Context) = ctx.getSharedPreferences(MAP, Context.MODE_PRIVATE)
    private fun data(ctx: Context) = ctx.getSharedPreferences(DATA, Context.MODE_PRIVATE)
    private fun manager(ctx: Context) = AppWidgetManager.getInstance(ctx)
    private fun allIds(ctx: Context) = manager(ctx).getAppWidgetIds(ComponentName(ctx, MemoWidget::class.java))

    fun memoOf(ctx: Context, widgetId: Int): String? = map(ctx).getString(widgetId.toString(), null)

    /** 위젯에 놓인 메모 id 들 (화면이 이 메모들의 내용을 보내 준다) */
    fun memoIds(ctx: Context): JSONArray = JSONArray(allIds(ctx).toList().mapNotNull { memoOf(ctx, it) }.distinct())

    // 놓기·치우기도 위젯의 파일 일과 같은 줄에서 (내용 보내기·잠긴 메모 숨기기가 옛 표를 다시 써 넣지 않게)
    fun assign(ctx: Context, widgetId: Int, memoId: String) {
        val app = ctx.applicationContext
        queued("위젯 정하기") {
            map(app).edit().putString(widgetId.toString(), memoId).apply()
            update(app, intArrayOf(widgetId))
        }
    }

    fun forget(ctx: Context, widgetIds: IntArray) {
        val app = ctx.applicationContext
        queued("위젯 치우기") {
            map(app).edit().apply { widgetIds.forEach { remove(it.toString()) } }.apply()
            // 어느 위젯에도 없는 메모의 내용은 지운다
            val used = allIds(app).toList().mapNotNull { memoOf(app, it) }.toSet()
            data(app).edit().apply { data(app).all.keys.filter { it !in used }.forEach { remove(it) } }.apply()
        }
    }

    private fun queued(what: String, block: () -> Unit) = io.execute {
        try {
            block()
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "$what 실패", e)
        }
    }

    /** 화면이 보낸 내용: [{id, title, color, file, lines:[{t, kind, done?, i?}]}] — 지워진 메모는 {id, gone:true} */
    fun publish(ctx: Context, memos: JSONArray) {
        // 어느 위젯에도 없는 메모의 내용은 남기지 않는다 — 놓기를 취소한 메모의 글이 남아 있지 않게
        // (놓기를 요청한 지 얼마 안 된 메모는 런처가 아직 묻는 중일 수 있어 남긴다)
        val used = allIds(ctx).toList().mapNotNull { memoOf(ctx, it) }.toSet()
        val tokens = ctx.getSharedPreferences(PIN_TOKENS, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val pending = tokens.all.filter { (k, v) -> k != PICK_TOKEN && now - ((v as? String)?.substringAfter('|')?.toLongOrNull() ?: 0L) < PIN_WAIT_MS }.keys
        tokens.edit().apply { tokens.all.keys.filter { it !in pending && it != PICK_TOKEN }.forEach { remove(it) } }.apply()
        val edit = data(ctx).edit()
        val gone = mutableSetOf<String>()
        for (k in 0 until memos.length()) {
            val m = memos.getJSONObject(k)
            val id = m.getString("id")
            if (!m.optBoolean("gone")) {
                edit.putString(id, m.toString())
                continue
            }
            // 파일이 잠깐 없을 수도 있다(동기화가 바꿔 쓰는 중 등) — 처음엔 내용만 숨기고, 한동안 계속 없을 때만 위젯을 놓는다
            val prev = memo(ctx, id)
            val goneAt = prev?.optLong("goneAt", 0L) ?: 0L
            if (prev == null || (goneAt > 0 && now - goneAt >= GONE_CONFIRM_MS)) {
                edit.remove(id)
                gone += id
            } else if (goneAt == 0L) {
                prev.put("goneAt", now).put("lines", JSONArray().put(JSONObject().put("t", "메모킹을 열면 내용이 보여요").put("kind", "text")))
                edit.putString(id, prev.toString())
            }
        }
        // 지워진 메모가 놓인 위젯은 "보일 메모 고르기" 로 되돌린다 (영원히 "열면 보여요" 로 남지 않게)
        if (gone.isNotEmpty()) map(ctx).edit().apply { map(ctx).all.filter { (_, v) -> v in gone }.keys.forEach { remove(it) } }.apply()
        val incoming = (0 until memos.length()).map { memos.getJSONObject(it).getString("id") }.toSet()
        data(ctx).all.keys.filter { it !in used && it !in pending && it !in incoming }.forEach { edit.remove(it) }
        edit.apply()
        update(ctx, allIds(ctx))
    }

    /** 잠긴 메모 파일인가 (앱이 꺼져 있을 때 위젯을 지키는 데만 — 넉넉히: 잠금 주석이 있으면 숨긴다) */
    fun looksLocked(text: String) = text.contains("<!-- memoking-lock ")

    private fun parse(raw: String?): JSONObject? = try {
        raw?.let { JSONObject(it) }
    } catch (e: Exception) {
        null
    }

    /** 메모 폴더(맨 위)에서 머리말 id 가 같은 메모 파일 (경로, 내용) */
    private fun findById(storage: Storage, memoId: String): Pair<String, String>? {
        val idLine = Regex("(?m)^id:\\s*['\"]?" + Regex.escape(memoId) + "['\"]?\\s*$")
        val names = try {
            storage.list("").filter { !it.dir && it.name.endsWith(".md", ignoreCase = true) }.map { it.name }
        } catch (e: Exception) {
            return null
        }
        for (name in names) {
            val text = read(storage, name) ?: continue
            val head = text.substringBefore("\n---", "").take(2000)
            if (idLine.containsMatchIn(head)) return name to text
        }
        return null
    }

    private fun read(storage: Storage, file: String): String? = try {
        storage.openRead(file).use { it.readBytes().toString(Charsets.UTF_8) }
    } catch (e: Exception) {
        null
    }

    private val HEADER_KEY = Regex("""^[A-Za-z_][\w-]*\s*:(\s|$)""")

    /**
     * 머리말(--- 사이의 "키: 값")이 끝나는 줄 번호 (없으면 null) — app/js/core/memo-file.js 와 같은 규칙:
     * "---" 구분선으로 시작하는 보통 글(첫 문단·목록)은 머리말이 아니다 (거기에 device 를 적거나 할 일을 빼고 세지 않게)
     */
    fun headerEnd(lines: List<String>): Int? {
        if (lines.firstOrNull()?.trimEnd() != "---") return null
        val end = (1 until lines.size).firstOrNull { lines[it].trimEnd() == "---" } ?: return null
        val body = (1 until end).map { lines[it].trimEnd() }.filter { it.isNotBlank() }
        if (body.isEmpty()) return end // 빈 머리말도 머리말
        if (!HEADER_KEY.containsMatchIn(body[0])) return null
        // 키: 값 · 들여 쓴 줄(목록·이어진 값) · 주석만
        return if (body.all { HEADER_KEY.containsMatchIn(it) || it[0].isWhitespace() || it.startsWith("- ") || it.startsWith("#") }) end else null
    }

    /** 머리말 뒤 첫 "# 제목" 줄의 제목 (없으면 null) */
    fun visibleTitle(text: String): String? {
        val lines = text.split("\n")
        val start = headerEnd(lines)?.plus(1) ?: 0
        val line = (start until lines.size).map { lines[it].trim() }.firstOrNull { it.isNotEmpty() } ?: return null
        return if (line.startsWith("# ")) line.removePrefix("# ").trim() else null
    }

    /**
     * 앱이 꺼져 있는 동안 동기화로 받은 파일 중 다른 기기에서 잠근 메모가 있으면 위젯의 내용(풀린 글)을 바로 숨긴다.
     * (위젯 내용은 앱 화면이 만들어 보내므로, 앱을 열 때까지 예전 글이 홈 화면에 남지 않게)
     */
    fun hideLocked(ctx: Context) {
        val storage = Vaults.current(ctx) ?: return
        var changed = false
        val edit = data(ctx).edit()
        for ((memoId, raw) in data(ctx).all) {
            val memo = parse(raw as? String) ?: continue
            val file = memo.optString("file")
            if (file.isEmpty() || memo.optBoolean("locked")) continue
            // 다른 기기가 잠그며 이름을 바꿨으면("제목도 숨기기") 같은 id 의 파일을 찾는다
            var renamed = false
            // 파일이 없으면 같은 id 의 파일을 찾는다 — 못 찾았으면 6시간 동안은 다시 찾지 않는다 (매번 메모 폴더 전체를 읽지 않게)
            val missedAt = memo.optLong("missedAt", 0L)
            val text = read(storage, file) ?: (if (System.currentTimeMillis() - missedAt < 6 * 3600_000L) null else findById(storage, memoId))?.let { (newFile, content) ->
                memo.put("file", newFile)
                memo.remove("missedAt")
                renamed = true
                content
            } ?: run {
                if (System.currentTimeMillis() - missedAt >= 6 * 3600_000L) {
                    // 찾지 못한 메모는 내용을 숨겨 둔다 (그사이 다른 기기가 이름을 바꿔 잠갔을 수도 — 앱을 열면 다시 맞춤)
                    memo.put("missedAt", System.currentTimeMillis())
                    memo.put("lines", JSONArray().put(JSONObject().put("t", "메모킹을 열면 내용이 보여요").put("kind", "text")))
                    edit.putString(memoId, memo.toString())
                    changed = true
                }
                null
            } ?: continue
            if (!looksLocked(text)) {
                // 이름만 바뀐 메모: 새 이름을 기억해 다음에 메모 폴더 전체를 다시 뒤지지 않게
                if (renamed) {
                    edit.putString(memoId, memo.toString())
                    changed = true
                }
                continue
            }
            // 제목도 잠근 파일에 보이는 제목으로 ("제목도 숨기기" 로 잠갔으면 "잠긴 메모")
            val shownTitle = visibleTitle(text)
            if (shownTitle != null) memo.put("title", shownTitle)
            memo.put("locked", true).put("lines", JSONArray().put(JSONObject().put("t", "🔒 잠긴 메모예요").put("kind", "text")))
            edit.putString(memoId, memo.toString())
            changed = true
        }
        if (!changed) return
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
        // 위젯 받는 곳은 런처가 부를 수 있게 밖에 열려 있다 — 다른 앱이 "놓았어요" 를 흉내 내 위젯을 엉뚱한 메모로 바꾸지 못하게
        // 이 요청에만 맞는 표를 함께 보내고, 받을 때 맞춰 본 뒤 버린다
        val token = java.util.UUID.randomUUID().toString()
        ctx.getSharedPreferences(PIN_TOKENS, Context.MODE_PRIVATE).edit().putString(memoId, "$token|${System.currentTimeMillis()}").apply()
        val callback = PendingIntent.getBroadcast(
            ctx, memoId.hashCode(),
            Intent(ctx, MemoWidget::class.java).setAction(ACTION_PINNED).putExtra(EXTRA_MEMO, memoId).putExtra(EXTRA_TOKEN, token),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE, // 런처가 위젯 id 를 채워 넣는다
        )
        return mgr.requestPinAppWidget(ComponentName(ctx, MemoWidget::class.java), null, callback)
    }

    /** 놓기 요청의 표가 맞는지 (맞으면 버림 — 한 번만) */
    fun takePinToken(ctx: Context, memoId: String, token: String?): Boolean {
        val prefs = ctx.getSharedPreferences(PIN_TOKENS, Context.MODE_PRIVATE)
        val want = prefs.getString(memoId, null)?.substringBefore('|') ?: return false
        if (token == null || token != want) return false
        prefs.edit().remove(memoId).apply()
        return true
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
                .putExtra(EXTRA_TOKEN, pickToken(ctx))
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

    // (?U): \s 가 자바스크립트처럼 유니코드 공백(전각 공백 등)도, 숫자는 [0-9] 만 — widget-lines.js 와 같은 줄을 할 일로 센다
    private val TASK = Regex("""(?U)^\s*(?:[-*+]|[0-9]+[.)])\s+\[([ xX])\](?:\s+|$)""")
    private val FENCE = Regex("""(?U)^\s*(```|~~~)""")

    /**
     * 메모 파일의 할 일을 체크/해제한 새 글 (머리말은 건드리지 않음). 찾지 못하면 null.
     * 할 일 세는 규칙은 app/js/core/widget-lines.js 와 같다.
     *   text(위젯에 보인 그 할 일의 원래 글)가 있으면: index 번째가 그 글이 아닐 때(위젯이 갱신되기 전에 PC 에서 순서가 바뀜)
     *   같은 글인 할 일 중 index 에 가장 가까운 것을 고친다 — 없으면 null (엉뚱한 할 일을 체크하지 않게).
     *   shownDone(위젯에 보인 상태)이 있으면 그 반대로 맞춘다 (이미 그렇게 바뀌어 있으면 그대로).
     */
    fun toggleTaskText(text: String, index: Int, taskText: String? = null, shownDone: Boolean? = null): String? {
        val lines = text.split("\n").toMutableList()
        val start = headerEnd(lines)?.plus(1) ?: 0
        // (줄 번호, 체크 칸 자리, 할 일 글)
        val tasks = mutableListOf<Triple<Int, Int, String>>()
        var fence = false
        for (k in start until lines.size) {
            val line = lines[k]
            if (FENCE.containsMatchIn(line)) {
                fence = !fence
                continue
            }
            if (fence) continue
            val m = TASK.find(line) ?: continue
            tasks.add(Triple(k, m.groups[1]!!.range.first, line.substring(m.range.last + 1).trim()))
        }
        val shown = taskText?.trim()
        val target = when {
            shown == null -> tasks.getOrNull(index)
            tasks.getOrNull(index)?.third == shown -> tasks[index]
            else -> tasks.withIndex().filter { it.value.third == shown }.minByOrNull { kotlin.math.abs(it.index - index) }?.value
        } ?: return null
        val (k, box) = target
        val line = lines[k]
        val checked = line[box] != ' '
        val want = if (shownDone != null) !shownDone else !checked
        lines[k] = line.substring(0, box) + (if (want) "x" else " ") + line.substring(box + 1)
        return lines.joinToString("\n")
    }

    /**
     * 머리말에 "휴대폰에서 지금 고침" 을 적는다 (updated · device) — 다른 고친 길과 같게, PC 의 이어 쓰기 안내·정렬이 맞게.
     * 머리말이 없으면 그대로.
     */
    fun stampEdit(text: String, now: String): String {
        val lines = text.split("\n").toMutableList()
        val end = headerEnd(lines) ?: return text
        var hasDevice = false
        val cr = if (lines[0].endsWith("\r")) "\r" else "" // 줄 끝(\r\n)을 파일 그대로
        for (k in 1 until end) {
            if (lines[k].startsWith("updated:")) lines[k] = "updated: $now$cr"
            if (lines[k].startsWith("device:")) {
                lines[k] = "device: phone$cr"
                hasDevice = true
            }
        }
        if (!hasDevice) lines.add(end, "device: phone$cr")
        return lines.joinToString("\n")
    }

    private fun nowIso(): String =
        java.time.OffsetDateTime.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).format(java.time.format.DateTimeFormatter.ISO_OFFSET_DATE_TIME)

    /** 위젯에서 체크: 파일을 고치고, 위젯도 바로 그 모양으로 */
    fun toggleTask(ctx: Context, memoId: String, index: Int, taskText: String? = null, shownDone: Boolean? = null): Boolean {
        val memo = memo(ctx, memoId) ?: return false
        val file = memo.optString("file").ifEmpty { return false }
        val storage = Vaults.current(ctx) ?: return false
        val text = storage.openRead(file).use { it.readBytes().toString(Charsets.UTF_8) }
        val next = toggleTaskText(text, index, taskText, shownDone) ?: return false
        if (next != text) {
            val stamped = stampEdit(next, nowIso())
            storage.write(file) { it.write(stamped.toByteArray(Charsets.UTF_8)) }
        }
        DriveSync.request(ctx, 3000)
        // 위젯도 바로 그 모양으로 — 파일에서 글로 찾아 고쳤으면 위젯에서도 같은 글의 줄을 (번호가 아니라)
        val lines = memo.optJSONArray("lines") ?: JSONArray()
        val shown = taskText?.trim()
        var target = -1
        for (k in 0 until lines.length()) {
            val l = lines.getJSONObject(k)
            if (l.optString("kind") != "task") continue
            val match = if (shown != null) l.optString("r") == shown else l.optInt("i", -1) == index
            if (match && (target < 0 || kotlin.math.abs(l.optInt("i") - index) < kotlin.math.abs(lines.getJSONObject(target).optInt("i") - index))) target = k
        }
        if (target >= 0) {
            val l = lines.getJSONObject(target)
            l.put("done", if (shownDone != null) !shownDone else !l.optBoolean("done"))
        }
        data(ctx).edit().putString(memoId, memo.toString()).apply()
        update(ctx, allIds(ctx).filter { memoOf(ctx, it) == memoId }.toIntArray())
        // 앱이 열려 있으면 메모 폴더를 다시 읽게
        MainActivity.visible?.let { a -> a.runOnUiThread { a.emit("widget", JSONObject().put("memoId", memoId)) } }
        return true
    }
}

class MemoWidget : AppWidgetProvider() {
    // 주기적으로도(위젯 설정의 updatePeriodMillis): 앱이 꺼져 있는 사이 다른 동기화 앱(Syncthing 등)으로 잠긴 메모를 숨긴다
    override fun onUpdate(ctx: Context, mgr: AppWidgetManager, ids: IntArray) {
        // 파일 읽기는 화면 스레드가 아닌 곳에서 (메모 폴더를 뒤지는 동안 멈춘 것처럼 보이지 않게)
        val app = ctx.applicationContext
        Widgets.update(app, ids) // 줄 서 기다리지 않고 지금 아는 내용으로 먼저 그린다
        val pending = goAsync()
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        val finish = { if (done.compareAndSet(false, true)) pending.finish() }
        // 앞선 파일 일이 길어도 방송을 오래 붙잡지 않게 (시스템이 앱을 멈춘 것으로 보지 않도록)
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ finish() }, 8_000L)
        Widgets.io.execute {
            try {
                Widgets.hideLocked(app)
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "위젯 확인 실패", e)
            } finally {
                finish()
            }
        }
    }

    override fun onDeleted(ctx: Context, ids: IntArray) = Widgets.forget(ctx, ids)

    override fun onAppWidgetOptionsChanged(ctx: Context, mgr: AppWidgetManager, id: Int, options: Bundle) =
        Widgets.update(ctx, intArrayOf(id))

    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Widgets.ACTION_PINNED) {
            val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
            val memoId = intent.getStringExtra(Widgets.EXTRA_MEMO)
            if (id != AppWidgetManager.INVALID_APPWIDGET_ID && !memoId.isNullOrEmpty()
                && Widgets.takePinToken(ctx, memoId, intent.getStringExtra(Widgets.EXTRA_TOKEN))) Widgets.assign(ctx, id, memoId)
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
            if (kind == "task") {
                fill.putExtra(Widgets.EXTRA_TASK, line.optInt("i", -1))
                if (line.has("r")) fill.putExtra(Widgets.EXTRA_TASK_TEXT, line.optString("r"))
                fill.putExtra(Widgets.EXTRA_TASK_DONE, done)
            }
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
        val taskText = intent.getStringExtra(Widgets.EXTRA_TASK_TEXT)
        val shownDone = if (intent.hasExtra(Widgets.EXTRA_TASK_DONE)) intent.getBooleanExtra(Widgets.EXTRA_TASK_DONE, false) else null
        if (memoId.isNotEmpty() && task >= 0) {
            // 파일 읽고 쓰기는 화면 스레드 밖에서, 차례대로 — 끝나면 이 (보이지 않는) 화면에서 필요하면 앱을 열고 닫는다
            val app = applicationContext
            Widgets.io.execute {
                val ok = try {
                    Widgets.toggleTask(app, memoId, task, taskText, shownDone)
                } catch (e: Exception) {
                    android.util.Log.w("MemoKing", "위젯 체크 실패", e)
                    false
                }
                runOnUiThread {
                    if (!ok) openMemo(this, memoId) // 파일을 못 찾았으면(이름이 바뀌었는 등) 앱에서 열어 다시 맞추게
                    close()
                }
            }
            return
        }
        if (memoId.isNotEmpty()) openMemo(this, memoId)
        close()
    }

    private fun close() {
        finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    private fun openMemo(ctx: Context, memoId: String) {
        ctx.startActivity(
            Intent(ctx, MainActivity::class.java).setAction(MainActivity.ACTION_OPEN_MEMO).putExtra(Widgets.EXTRA_MEMO, memoId)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
