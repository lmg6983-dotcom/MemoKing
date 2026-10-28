package com.memoking.app

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.util.Base64
import android.webkit.JavascriptInterface
import com.memoking.app.drive.DriveApi
import com.memoking.app.drive.DriveSync
import com.memoking.app.drive.GoogleAuth
import com.memoking.app.drive.NativeAuth
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors

/**
 * 화면(웹)에서 window.MemoKingNative 로 부르는 기능. 데스크탑의 preload.cjs + 메인 프로세스에 해당한다.
 *
 * - 바로 답하는 함수: 결과를 {"v": 값} 또는 {"err": "이유"} JSON 글자로 돌려준다 (native.js 가 풀어서 예외로 바꿈).
 * - 오래 걸리는 일(폴더 고르기·인터넷·다른 앱 열기): call(id, 이름, 인자 JSON) → 끝나면 __mk.resolve(id, ...) 로 알린다.
 *
 * JavascriptInterface 함수는 WebView 의 별도 스레드에서 불린다.
 */
class Bridge(private val activity: MainActivity) {
    private val ctx: Context = activity.applicationContext
    private val pool = Executors.newCachedThreadPool()

    private fun storage(): Storage = Vaults.forScreen(ctx) ?: throw IllegalStateException("메모 폴더가 아직 없어요. 설정에서 메모 폴더를 골라 주세요")

    private inline fun reply(block: () -> Any?): String = try {
        val v = block()
        JSONObject().put("v", if (v == null || v == Unit) JSONObject.NULL else v).toString()
    } catch (e: Throwable) {
        JSONObject().put("err", e.message ?: e.javaClass.simpleName).toString()
    }

    private fun Storage.Entry.json() = JSONObject().put("name", name).put("dir", dir).put("mtime", mtime).put("size", size)

    // ---------- 메모 폴더 ----------

    fun vaultInfo(): JSONObject? {
        val spec = Vaults.spec(ctx) ?: return null
        val storage = Vaults.current(ctx)
        return JSONObject()
            .put("internal", spec == Vaults.INTERNAL)
            .put("drive", spec.startsWith(DriveSync.PREFIX))
            .put("label", storage?.label ?: "")
            .put("ok", storage != null)
    }

    @JavascriptInterface
    fun info(): String = reply {
        JSONObject()
            .put("version", BuildConfig.VERSION_NAME)
            .put("sdk", android.os.Build.VERSION.SDK_INT)
            .put("vault", vaultInfo() ?: JSONObject.NULL)
            .put("exactAlarms", Alarms.exactAllowed(ctx))
            // 녹음은 모든 버전, 받아쓰기는 휴대폰의 Google 음성 인식(안드로이드 13+)
            .put("record", JSONObject().put("stt", Stt.systemAvailable(ctx)).put("system", Stt.systemAvailable(ctx)))
    }

    @JavascriptInterface
    fun useInternalVault(): String = reply {
        Vaults.use(ctx, Vaults.INTERNAL)
        vaultInfo()
    }

    // 튜토리얼 연습 공간 켜기 · 끄기 (켜면 빈 폴더, 끄면 지운다)
    @JavascriptInterface
    fun sandbox(on: Boolean): String = reply {
        Vaults.setSandbox(ctx, on)
        null
    }

    // 메모 파일(.md) 목록 — 데스크탑 Vault.listFiles 와 같은 규칙: 숨김·임시 파일, 맨 위의 _memoking·attachments 는 뺀다
    @JavascriptInterface
    fun scan(): String = reply {
        val out = JSONArray()
        val storage = storage()
        fun walk(dir: String) {
            for (e in storage.list(dir)) {
                if (e.name.startsWith(".") || e.name.startsWith("~$")) continue
                if (dir.isEmpty() && (e.name == "_memoking" || e.name == "attachments")) continue
                val rel = if (dir.isEmpty()) e.name else "$dir/${e.name}"
                if (e.dir) walk(rel)
                else if (e.name.lowercase().endsWith(".md")) out.put(JSONObject().put("file", rel).put("mtime", e.mtime).put("size", e.size))
            }
        }
        walk("")
        out
    }

    @JavascriptInterface
    fun list(rel: String): String = reply { JSONArray(storage().list(rel).map { it.json() }) }

    @JavascriptInterface
    fun stat(rel: String): String = reply { storage().stat(rel)?.json() }

    @JavascriptInterface
    fun readText(rel: String): String = reply {
        val storage = storage()
        if (storage.stat(rel)?.dir != false) null else storage.openRead(rel).use { it.readBytes().toString(Charsets.UTF_8) }
    }

    // 메모 폴더를 고쳤으면 잠시 뒤 Google Drive 와 맞춘다 (Drive 폴더를 쓸 때만)
    private fun <T> changed(value: T): T {
        if (Vaults.sandbox == null) DriveSync.request(ctx, 1000) // 연습 공간은 동기화하지 않는다
        return value
    }

    @JavascriptInterface
    fun writeText(rel: String, text: String): String = reply {
        changed(storage().write(rel) { it.write(text.toByteArray(Charsets.UTF_8)) }.json())
    }

    @JavascriptInterface
    fun writeBase64(rel: String, data: String): String = reply {
        val bytes = Base64.decode(data, Base64.DEFAULT)
        changed(storage().write(rel) { it.write(bytes) }.json())
    }

    @JavascriptInterface
    fun mkdirs(rel: String): String = reply { storage().mkdirs(rel) }

    @JavascriptInterface
    fun move(from: String, to: String): String = reply { changed(storage().move(from, to)) }

    @JavascriptInterface
    fun remove(rel: String): String = reply { changed(storage().delete(rel)) }

    // ---------- 임시 파일 (공유받은 파일·고른 파일·인터넷에서 받은 것) ----------

    @JavascriptInterface
    fun commitTemp(id: String, rel: String): String = reply {
        val file = Temp.file(ctx, id) ?: throw IllegalArgumentException("임시 파일이 없어요")
        val entry = file.inputStream().use { input -> storage().write(rel) { input.copyTo(it) } }
        file.delete()
        changed(entry.json())
    }

    @JavascriptInterface
    fun readTempText(id: String): String = reply { Temp.file(ctx, id)?.readText() }

    @JavascriptInterface
    fun dropTemp(id: String): String = reply { Temp.file(ctx, id)?.delete() }

    // ---------- 그 밖에 ----------

    @JavascriptInterface
    fun copyText(text: String): String = reply {
        val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("메모킹", text))
        true
    }

    /** 위·아래 시스템 막대 색 (#rrggbb) 과 아이콘을 어둡게 할지 */
    @JavascriptInterface
    fun setChrome(color: String, darkIcons: Boolean): String = reply {
        activity.runOnUiThread { activity.setChrome(color, darkIcons) }
    }

    /** S펜 손글씨 → 글자 (안드로이드 14+ 손글씨 입력): 글 고치기 방식이고 설정이 켜져 있을 때만 */
    @JavascriptInterface
    fun setHandwriting(on: Boolean): String = reply {
        activity.runOnUiThread { activity.setHandwriting(on) }
    }

    /** 키보드 꺼내기 · 넣기 (S펜으로 쓰다가 키보드로 치고 싶을 때) */
    @JavascriptInterface
    fun showKeyboard(show: Boolean): String = reply {
        activity.runOnUiThread { activity.showKeyboard(show) }
    }

    @JavascriptInterface
    fun takeIntent(): String = reply { activity.takePendingIntent() }

    // ---------- 홈 화면 위젯 (Widgets.kt) ----------

    /** 위젯에 놓인 메모 id 들 */
    @JavascriptInterface
    fun widgetMemoIds(): String = reply { Widgets.memoIds(ctx) }

    /** 위젯에 보일 내용 [{id, title, color, file, lines}] */
    @JavascriptInterface
    fun widgetPublish(json: String): String = reply {
        val memos = JSONArray(json)
        // 위젯의 파일 일은 한 줄로 (체크·잠긴 메모 숨기기와 서로 덮어쓰지 않게) — 끝날 때까지 기다려, 이어서 놓기·고르기가 내용을 보게
        try {
            Widgets.io.submit<Unit> { Widgets.publish(ctx, memos) }.get(10, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /** 위젯 고르기 목록에서 놓은 위젯에 메모를 정함 */
    @JavascriptInterface
    fun widgetAssign(widgetId: Int, memoId: String): String = reply { Widgets.assign(ctx, widgetId, memoId) }

    /** 메모를 홈 화면에 위젯으로 놓기 (런처가 위치를 물음). 런처가 지원하지 않으면 false */
    @JavascriptInterface
    fun widgetPin(memoId: String): String = reply { Widgets.requestPin(ctx, memoId) }

    // 지난번 오류 기록 (CrashLog) — 있으면 꺼내 보여 준다 (꺼내면 지움)
    @JavascriptInterface
    fun lastError(): String = reply { CrashLog.take(ctx) }

    @JavascriptInterface
    fun ready(): String = reply { activity.runOnUiThread { activity.onPageReady() } }

    // 예약 알림: [{ key, at(ms), title, text, memoId, action }] — 앱이 꺼져 있어도 울리도록 시스템에 맡긴다
    @JavascriptInterface
    fun scheduleAlarms(json: String): String = reply { Alarms.schedule(ctx, JSONArray(json)) }

    /** 앱이 꺼져 있던 동안 시스템이 이미 울린 알림인지 (같은 알림을 두 번 울리지 않게) */
    @JavascriptInterface
    fun wasFired(key: String, at: Double): String = reply { Alarms.wasFired(ctx, key, at.toLong()) }

    @JavascriptInterface
    fun notify(json: String): String = reply {
        val o = JSONObject(json)
        Notifier.show(ctx, o.getString("key"), o.optString("title"), o.optString("text"), o.optString("memoId"), o.optString("label"))
        true
    }

    // ---------- Google Drive 동기화 ----------

    fun driveInfo(): JSONObject = JSONObject()
        .put("configured", GoogleAuth.configured(ctx))
        .put("builtIn", GoogleAuth.builtIn())
        .put("nativeAvailable", NativeAuth.available(ctx))
        .put("browserConfigured", GoogleAuth.clientId(ctx).isNotBlank())
        .put("connected", GoogleAuth.connected(ctx))
        .put("reconnect", GoogleAuth.reconnectNeeded(ctx))
        .put("email", GoogleAuth.email(ctx))
        .put("active", DriveSync.active(ctx))
        .put("folderId", DriveSync.folderId(ctx) ?: "")
        .put("folderName", DriveSync.folderName(ctx))
        .put("status", DriveSync.status.json())

    @JavascriptInterface
    fun driveStatus(): String = reply { driveInfo() }

    /** OAuth 클라이언트 ID·보안 비밀 붙여 넣기 (빌드에 넣지 않았을 때) */
    @JavascriptInterface
    fun driveSetClient(id: String, secret: String): String = reply {
        GoogleAuth.setClient(ctx, id, secret)
        driveInfo()
    }

    @JavascriptInterface
    fun driveDisconnect(): String = reply {
        DriveSync.disconnect(ctx)
        driveInfo()
    }

    @JavascriptInterface
    fun driveCancelLogin(): String = reply { GoogleAuth.cancelLogin() }

    @JavascriptInterface
    fun driveSyncSoon(): String = reply { DriveSync.request(ctx, 0) }

    // ---------- 알림 보관함 ----------

    /** { enabled, granted, entries: [...] } — 거르기·검색은 화면이 한다 */
    @JavascriptInterface
    fun historyAll(): String = reply {
        JSONObject().put("enabled", NotiStore.enabled(ctx)).put("granted", NotiStore.granted(ctx))
            .put("blocked", NotiStore.blocked(ctx)).put("entries", NotiStore.all(ctx))
    }

    /** 이 앱 알림을 더 모으지 않기 (removeExisting: 이미 모은 것도 지우기) → 지운 개수 */
    @JavascriptInterface
    fun historyBlock(appId: String, app: String, removeExisting: Boolean): String = reply {
        NotiStore.block(ctx, appId, app, removeExisting)
    }

    @JavascriptInterface
    fun historyUnblock(appId: String): String = reply { NotiStore.unblock(ctx, appId) }

    @JavascriptInterface
    fun historySetEnabled(on: Boolean): String = reply {
        NotiStore.setEnabled(ctx, on)
        NotiStore.granted(ctx)
    }

    @JavascriptInterface
    fun historyRemove(id: String): String = reply { NotiStore.remove(ctx, id) }

    @JavascriptInterface
    fun historyClear(): String = reply { NotiStore.clear(ctx) }

    // ---------- 녹음 · 받아쓰기 (RecorderService.kt · Stt.kt) ----------

    @JavascriptInterface
    fun recordStatus(): String = reply { RecorderService.status() }

    @JavascriptInterface
    fun recordPause(): String = reply {
        if (RecorderService.session != null) ctx.startService(Intent(ctx, RecorderService::class.java).setAction(RecorderService.ACTION_PAUSE))
        RecorderService.session?.pause(true)
        RecorderService.status()
    }

    @JavascriptInterface
    fun recordResume(): String = reply {
        if (RecorderService.session != null) ctx.startService(Intent(ctx, RecorderService::class.java).setAction(RecorderService.ACTION_RESUME))
        RecorderService.session?.pause(false)
        RecorderService.status()
    }

    /** 앱이 꺼져 있는 동안 끝난 녹음 (아직 메모에 넣지 않은 것) */
    @JavascriptInterface
    fun recordTakeDone(): String = reply { if (RecorderService.session == null) RecordStore.pending(ctx) else JSONArray() }

    @JavascriptInterface
    fun recordAck(id: String): String = reply { RecordStore.ack(ctx, id) }

    @JavascriptInterface
    fun sttStatus(): String = reply { Stt.status(ctx) }

    // ---------- 오래 걸리는 일 ----------

    @JavascriptInterface
    fun call(id: Int, method: String, args: String) {
        val a = if (args.isBlank()) JSONObject() else JSONObject(args)
        when (method) {
            // 화면을 띄우는 일은 화면 스레드에서
            "pickFolder" -> activity.runOnUiThread { activity.pickFolder(id) }
            "pickFiles" -> activity.runOnUiThread { activity.pickFiles(id, a.optString("accept", "*/*")) }
            "openFile" -> activity.runOnUiThread { activity.openVaultFile(id, a.getString("rel")) }
            "openUrl" -> activity.runOnUiThread { activity.openUrl(id, a.getString("url")) }
            "share" -> activity.runOnUiThread { activity.shareText(id, a.optString("title"), a.getString("text")) }
            "print" -> activity.runOnUiThread { activity.printPage(id, a.optString("title", "메모"), a.optString("html").ifBlank { null }) }
            "notifyPermission" -> activity.runOnUiThread { activity.requestNotifyPermission(id) }
            "exactAlarmSettings" -> activity.runOnUiThread { activity.openExactAlarmSettings(id) }
            "historyPermission" -> activity.runOnUiThread { activity.openNotificationAccess(id) }
            "http" -> pool.execute { resolve(id) { Http.fetch(ctx, a) } }
            // 앱 안 업데이트 (AppUpdate.kt): 확인 → 받기(진행은 'update' 소식) → 설치 화면 열기
            "updateCheck" -> pool.execute {
                resolve(id) {
                    // 최신이면 예전에 받아 둔 APK(설치를 마친 것)는 지운다
                    AppUpdate.check().also { if (!it.optBoolean("available")) AppUpdate.cleanup(ctx) }
                }
            }
            "updateDownload" -> pool.execute {
                resolve(id) {
                    AppUpdate.download(ctx, a) { done, total ->
                        activity.runOnUiThread { activity.emit("update", JSONObject().put("done", done).put("total", total)) }
                    }
                    true
                }
            }
            // → "started"(설치 화면으로 넘김) | "permission"(출처를 알 수 없는 앱 설치 허용 화면을 열었음 — 허용 뒤 다시) | "missing"(받은 파일이 없음)
            //   설치 화면은 안드로이드 기본 설치기 — 취소 · 실패하면 'updateResult' 소식 (MainActivity.installUpdate)
            "updateInstall" -> pool.execute {
                resolve(id) {
                    val file = AppUpdate.downloaded(ctx)
                    when {
                        file == null -> "missing"
                        !AppUpdate.canInstall(ctx) -> {
                            activity.runOnUiThread { AppUpdate.openInstallSettings(activity) }
                            "permission"
                        }
                        else -> {
                            activity.runOnUiThread { activity.installUpdate(file) }
                            "started"
                        }
                    }
                }
            }
            // 휴대폰 캘린더 (삼성 캘린더 · Google 캘린더) 함께 보기: 권한 묻기 · 일정 읽기
            "calendarPermission" -> activity.runOnUiThread { activity.requestCalendarPermission(id) }
            "calendarEvents" -> pool.execute { resolve(id) { DeviceCalendar.events(ctx, a.getLong("from"), a.getLong("to")) } }
            // 화자 구분: {} 모델 받고 켜기 · {on} 켜기/끄기 · {delete} 모델 지우기
            "speakerModel" -> pool.execute {
                resolve(id) {
                    when {
                        a.optBoolean("delete") -> SpeakerModel.delete(ctx)
                        a.has("on") -> SpeakerModel.setOn(ctx, a.optBoolean("on"))
                        else -> {
                            if (!SpeakerModel.supported()) throw IllegalStateException("이 휴대폰에서는 화자 구분을 쓸 수 없어요")
                            SpeakerModel.download(ctx) { p -> activity.runOnUiThread { activity.emit("speakerModel", JSONObject().put("progress", p)) } }
                            SpeakerModel.setOn(ctx, true)
                        }
                    }
                    Stt.status(ctx)
                }
            }
            "micPermission" -> activity.runOnUiThread { activity.requestMicPermission(id) }
            "recordStart" -> activity.runOnUiThread {
                resolve(id) { RecorderService.start(activity, a.getString("memoId"), a.optBoolean("stt", true), terms(a)) }
            }
            "recordStop" -> pool.execute { resolve(id) { RecorderService.stop(ctx) } }
            // 소리 파일 받아쓰기: 메모 폴더의 파일(rel) 또는 임시 파일(temp)
            "transcribe" -> pool.execute {
                resolve(id) {
                    Stt.unavailableReason(ctx)?.let { throw IllegalStateException(it) }
                    val (file, temporary) = audioFile(a)
                    try {
                        val text = FileTranscriber.run(ctx, file, terms(a)) { p ->
                            activity.runOnUiThread { activity.emit("transcribe", JSONObject().put("progress", p)) }
                        }
                        JSONObject().put("text", text)
                    } finally {
                        if (temporary) file.delete()
                    }
                }
            }
            // 메모 안의 그림 복사: PNG(base64) → 보내기 자리(cache/share)에 두고 content:// 주소로 클립보드에 (다른 앱에 그림으로 붙음)
            "copyImage" -> pool.execute {
                resolve(id) {
                    val file = shareFile("메모킹 그림.png")
                    file.writeBytes(Base64.decode(a.getString("base64"), Base64.DEFAULT))
                    val uri = VaultFileProvider.shareUriFor(file.name)
                    val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData.newUri(ctx.contentResolver, "메모킹 그림", uri))
                    true
                }
            }
            // 메모 안의 파일 복사: 첨부를 보내기 자리(cache/share)에 이름 그대로 두고, 클립보드에 파일(content://) + 이름 글을 한 칸에 —
            //   파일을 받는 앱(메모킹 · 파일 앱 · 메신저)에는 파일로, 글만 받는 칸에는 이름으로 붙는다
            //   shortcut: 보내기 자리는 1시간 지나면 비워져 그 뒤에 붙이면 파일이 없다, 오래 두고 붙이는 일이 잦으면 따로 둘 자리를
            // → 클립보드에 넣은 이름
            "copyFile" -> pool.execute {
                resolve(id) {
                    val rel = a.getString("rel")
                    // 메모 폴더의 첨부만 (saveAs · shareContent 와 같게)
                    if (!rel.startsWith("attachments/")) throw IllegalArgumentException("파일을 찾지 못했어요")
                    val ext = rel.substringAfterLast('.', "")
                    var name = a.optString("name").trim().ifEmpty { rel.substringAfterLast('/') }
                    if (ext.isNotEmpty() && !name.endsWith(".$ext", ignoreCase = true)) name += ".$ext"
                    val file = shareFile(name)
                    storage().openRead(rel).use { input -> file.outputStream().use { input.copyTo(it) } }
                    val uri = VaultFileProvider.shareUriFor(file.name)
                    val desc = ClipDescription(name, arrayOf(VaultFileProvider.mimeOf(file.name), ClipDescription.MIMETYPE_TEXT_PLAIN))
                    val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    clipboard.setPrimaryClip(ClipData(desc, ClipData.Item(name, null, uri)))
                    name // 클립보드에 넣은 이름 글 (메모킹에 붙일 때 알아보려고)
                }
            }
            // 클립보드의 그림 · 파일(content://) → 임시 파일 [{ temp, name, mime, size }] — 메모킹이나 다른 앱에서 복사한 그림을 메모에 붙여 넣기
            //   (WebView 의 붙여넣기는 클립보드의 그림을 넘겨주지 않고 주소 글만 준다)
            "clipboardFiles" -> activity.runOnUiThread {
                val uris = try {
                    val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                    val clip = clipboard.primaryClip
                    buildList { if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(::add) }
                } catch (e: Exception) {
                    emptyList()
                }
                pool.execute { resolve(id) { activity.copyToTemp(uris) } }
            }
            // 저장 단추: 안드로이드 저장 창(어디에 · 무슨 이름으로)을 띄워 파일로 — { name, mime, rel? | base64? } → 저장한 이름 | null(그만둠)
            "saveAs" -> pool.execute {
                val (_, file) = Temp.create(ctx)
                try {
                    val rel = a.optString("rel")
                    // 메모 폴더의 첨부만 (PC ipc-handlers.js 의 attachment:save-as · share 와 같게)
                    if (rel.isNotEmpty() && !rel.startsWith("attachments/")) throw IllegalArgumentException("파일을 찾지 못했어요")
                    if (rel.isNotEmpty()) storage().openRead(rel).use { input -> file.outputStream().use { input.copyTo(it) } }
                    else file.writeBytes(Base64.decode(a.getString("base64"), Base64.DEFAULT))
                } catch (e: Exception) {
                    file.delete()
                    resolve(id) { throw e }
                    return@execute
                }
                val name = a.optString("name", "메모 내용").replace(Regex("[\\\\/:*?\"<>|]+"), " ").trim().ifEmpty { "메모 내용" }
                val mime = a.optString("mime").ifBlank { VaultFileProvider.mimeOf(name) }
                activity.runOnUiThread { activity.saveAs(id, file, name, mime) }
            }
            // 내용 공유(공유 단추): 글이면 글로, 그 밖은 파일로 (메모 폴더의 파일 rel 그대로 · 만든 파일 base64) — 안드로이드 공유 창
            "shareContent" -> pool.execute {
                val name = a.optString("name", "메모 내용").replace(Regex("[\\\\/:*?\"<>|]+"), " ").trim().ifEmpty { "메모 내용" }
                val text = a.optString("text")
                if (text.isNotEmpty() && a.optString("rel").isEmpty() && a.optString("mime").startsWith("text/")) {
                    activity.runOnUiThread { activity.shareText(id, name.substringBeforeLast('.'), text) }
                    return@execute
                }
                val file = shareFile(name)
                try {
                    val rel = a.optString("rel")
                    // 메모 폴더의 첨부만 (PC ipc-handlers.js 의 attachment:save-as · share 와 같게)
                    if (rel.isNotEmpty() && !rel.startsWith("attachments/")) throw IllegalArgumentException("파일을 찾지 못했어요")
                    if (rel.isNotEmpty()) storage().openRead(rel).use { input -> file.outputStream().use { input.copyTo(it) } }
                    else file.writeBytes(Base64.decode(a.getString("base64"), Base64.DEFAULT))
                } catch (e: Exception) {
                    resolve(id) { throw e }
                    return@execute
                }
                val mime = a.optString("mime").ifBlank { VaultFileProvider.mimeOf(name) }
                activity.runOnUiThread { activity.shareFile(id, file, mime, name) }
            }
            // 보내기: 그림(base64) 같은 파일 · PDF
            "shareFile" -> pool.execute {
                val file = shareFile(a.optString("name", "메모"))
                try {
                    file.writeBytes(Base64.decode(a.getString("base64"), Base64.DEFAULT))
                } catch (e: Exception) {
                    resolve(id) { throw e }
                    return@execute
                }
                activity.runOnUiThread { activity.shareFile(id, file, a.optString("mime", "application/octet-stream"), a.optString("title")) }
            }
            "sharePdf" -> activity.runOnUiThread { activity.sharePdf(id, shareFile(a.optString("name", "메모.pdf")), a.optString("title", "메모"), a.optString("html").ifBlank { null }) }
            // 기본: 휴대폰 구글 계정 그대로 (계정 고르기·허용). browser=true 면 브라우저 로그인(예비)
            "driveLogin" -> if (!a.optBoolean("browser") && NativeAuth.available(ctx)) {
                activity.runOnUiThread { activity.loginWithPhoneAccount(id) }
            } else pool.execute {
                resolve(id) {
                    val email = GoogleAuth.login(ctx) { url -> activity.runOnUiThread { activity.openBrowser(url) } }
                    activity.runOnUiThread { activity.bringToFront() }
                    JSONObject().put("email", email)
                }
            }
            "driveFolders" -> pool.execute {
                resolve(id) {
                    val parent = a.optString("parent", "root").ifEmpty { "root" }
                    JSONArray(DriveApi(ctx).folders(parent).map { JSONObject().put("id", it.id).put("name", it.name) })
                }
            }
            "driveCreateFolder" -> pool.execute {
                resolve(id) {
                    // 같은 이름 폴더가 이미 있으면 새로 만들지 않고 그것 (PC 와 같음)
                    val api = DriveApi(ctx)
                    val parent = a.optString("parent", "root").ifEmpty { "root" }
                    val name = a.getString("name").trim()
                    val found = api.folders(parent).firstOrNull { it.name == name }
                    val f = found ?: api.createFolder(parent, name)
                    JSONObject().put("id", f.id).put("name", f.name).put("existed", found != null)
                }
            }
            "driveUse" -> pool.execute {
                resolve(id) {
                    // 지금까지의 메모(휴대폰 폴더, 또는 예전 Drive 폴더의 휴대폰 사본)를 새 폴더로 함께 옮긴다
                    val target = a.getString("folderId")
                    val from = if (a.optBoolean("import")) Vaults.current(ctx)?.takeIf { DriveSync.folderId(ctx) != target } else null
                    val status = DriveSync.use(ctx, a.getString("folderId"), a.getString("name"), from, wait = !a.optBoolean("background"))
                    JSONObject().put("vault", vaultInfo()).put("status", status.json())
                }
            }
            // 연결하기 한 번으로: 메모킹이 만든 "메모킹 동기화" 폴더를 찾아(PC 가 먼저 만들었을 수 있다) 쓰고, 없으면 만든다.
            // 지금까지의 휴대폰 메모(예전 Drive 폴더의 사본 포함)는 함께 옮겨 맞춘다
            "driveAuto" -> pool.execute {
                resolve(id) {
                    val api = DriveApi(ctx)
                    val folder = api.folders("root").firstOrNull { it.name == DriveSync.SYNC_FOLDER } ?: api.createFolder("root", DriveSync.SYNC_FOLDER)
                    val from = Vaults.current(ctx)?.takeIf { DriveSync.folderId(ctx) != folder.id }
                    val status = DriveSync.use(ctx, folder.id, folder.name, from, wait = !a.optBoolean("background")) // background: 처음 화면 — 바로 목록으로
                    JSONObject().put("vault", vaultInfo()).put("status", status.json()).put("folderName", folder.name)
                }
            }
            "driveSync" -> pool.execute { resolve(id) { DriveSync.syncBlocking(ctx, full = true).json() } } // 단추: 폴더를 처음부터
            else -> resolve(id) { throw IllegalArgumentException("알 수 없는 기능: $method") }
        }
    }

    /** 받아쓰기 힌트 낱말 (화면이 메모 폴더의 태그·자주 쓰는 말에서 골라 준다) */
    private fun terms(a: JSONObject): List<String> = a.optJSONArray("terms")?.let { arr -> List(arr.length()) { arr.optString(it) }.filter { it.isNotBlank() } } ?: emptyList()

    /** 받아쓸 소리 파일 → (파일, 다 쓰면 지울지). 메모 폴더(SAF 일 수도)는 임시 파일로 복사해 읽는다 */
    private fun audioFile(a: JSONObject): Pair<File, Boolean> {
        val temp = a.optString("temp")
        if (temp.isNotEmpty()) return (Temp.file(ctx, temp) ?: throw IllegalArgumentException("임시 파일이 없어요")) to false
        val rel = a.getString("rel")
        val (_, file) = Temp.create(ctx)
        storage().openRead(rel).use { input -> file.outputStream().use { input.copyTo(it) } }
        return file to true
    }

    /** 보낼 파일 자리: cache/share/<이름> (이전 것은 지운다) */
    private fun shareFile(name: String): File {
        val dir = File(ctx.cacheDir, VaultFileProvider.SHARE_DIR).apply { mkdirs() }
        dir.listFiles()?.filter { System.currentTimeMillis() - it.lastModified() > 60 * 60 * 1000 }?.forEach { it.delete() }
        val safe = name.replace(Regex("[\\\\/:*?\"<>|]+"), " ").trim().ifEmpty { "메모" }
        return File(dir, safe)
    }

    fun resolve(id: Int, block: () -> Any?) {
        val result = reply(block)
        activity.runOnUiThread { activity.js("window.__mk && __mk.resolve($id, ${JSONObject.quote(result)})") }
    }
}

/** 앱 캐시 안의 임시 파일 */
object Temp {
    private fun dir(ctx: Context) = File(ctx.cacheDir, "temp").apply { mkdirs() }

    fun create(ctx: Context): Pair<String, File> {
        val id = UUID.randomUUID().toString()
        return id to File(dir(ctx), id)
    }

    fun file(ctx: Context, id: String): File? {
        RecordStore.file(ctx, id)?.let { return it.takeIf { f -> f.isFile } } // 끝난 녹음 (files/recordings/)
        if (!Regex("[0-9a-f-]{36}").matches(id)) return null
        return File(dir(ctx), id).takeIf { it.isFile }
    }

    /** 하루 넘은 임시 파일 치우기 */
    fun sweep(ctx: Context) {
        val old = System.currentTimeMillis() - 24 * 60 * 60 * 1000
        dir(ctx).listFiles()?.filter { it.lastModified() < old }?.forEach { it.delete() }
    }
}
