package com.memoking.app

import android.content.ClipData
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

    private fun storage(): Storage = Vaults.current(ctx) ?: throw IllegalStateException("저장 위치가 설정되지 않았어요")

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
        DriveSync.request(ctx, 3000)
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

    @JavascriptInterface
    fun takeIntent(): String = reply { activity.takePendingIntent() }

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
            "print" -> activity.runOnUiThread { activity.printPage(id, a.optString("title", "메모")) }
            "notifyPermission" -> activity.runOnUiThread { activity.requestNotifyPermission(id) }
            "exactAlarmSettings" -> activity.runOnUiThread { activity.openExactAlarmSettings(id) }
            "historyPermission" -> activity.runOnUiThread { activity.openNotificationAccess(id) }
            "http" -> pool.execute { resolve(id) { Http.fetch(ctx, a) } }
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
                    val f = DriveApi(ctx).createFolder(a.optString("parent", "root").ifEmpty { "root" }, a.getString("name"))
                    JSONObject().put("id", f.id).put("name", f.name)
                }
            }
            "driveUse" -> pool.execute {
                resolve(id) {
                    // 지금까지의 메모(휴대폰 폴더, 또는 예전 Drive 폴더의 휴대폰 사본)를 새 폴더로 함께 옮긴다
                    val target = a.getString("folderId")
                    val from = if (a.optBoolean("import")) Vaults.current(ctx)?.takeIf { DriveSync.folderId(ctx) != target } else null
                    val status = DriveSync.use(ctx, a.getString("folderId"), a.getString("name"), from)
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
                    val status = DriveSync.use(ctx, folder.id, folder.name, from)
                    JSONObject().put("vault", vaultInfo()).put("status", status.json()).put("folderName", folder.name)
                }
            }
            "driveSync" -> pool.execute { resolve(id) { DriveSync.syncBlocking(ctx).json() } }
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
