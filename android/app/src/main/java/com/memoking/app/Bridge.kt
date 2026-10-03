package com.memoking.app

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
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

    private fun storage(): Storage = Vaults.current(ctx) ?: throw IllegalStateException("메모 폴더가 연결돼 있지 않아요")

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
            "http" -> pool.execute { resolve(id) { Http.fetch(ctx, a) } }
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
                    val from = if (a.optBoolean("import")) Vaults.current(ctx)?.takeIf { !DriveSync.active(ctx) } else null
                    val status = DriveSync.use(ctx, a.getString("folderId"), a.getString("name"), from)
                    JSONObject().put("vault", vaultInfo()).put("status", status.json())
                }
            }
            "driveSync" -> pool.execute { resolve(id) { DriveSync.syncBlocking(ctx).json() } }
            else -> resolve(id) { throw IllegalArgumentException("알 수 없는 기능: $method") }
        }
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
        if (!Regex("[0-9a-f-]{36}").matches(id)) return null
        return File(dir(ctx), id).takeIf { it.isFile }
    }

    /** 하루 넘은 임시 파일 치우기 */
    fun sweep(ctx: Context) {
        val old = System.currentTimeMillis() - 24 * 60 * 60 * 1000
        dir(ctx).listFiles()?.filter { it.lastModified() < old }?.forEach { it.delete() }
    }
}
