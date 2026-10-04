package com.memoking.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.print.PdfPrint
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.window.OnBackInvokedDispatcher
import com.memoking.app.drive.DriveSync
import com.memoking.app.drive.GoogleAuth
import com.memoking.app.drive.NativeAuth
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * 메모킹 안드로이드 — 화면 하나(WebView)에 휴대폰용 화면(android/web)을 띄우고,
 * 메모 폴더·알림·공유 같은 휴대폰 기능은 Bridge 로 이어 준다.
 */
class MainActivity : Activity() {
    companion object {
        const val ACTION_OPEN_MEMO = "com.memoking.app.OPEN_MEMO"
        const val ACTION_NEW_MEMO = "com.memoking.app.NEW_MEMO"
        private const val REQ_FOLDER = 1
        private const val REQ_FILES = 2
        private const val REQ_NOTIFY = 3
        private const val REQ_AUTH = 4
        private const val REQ_MIC = 5

        /** 지금 앞에 보이는 화면 (알림이 울렸을 때 바로 알리기 위해) */
        @Volatile
        var visible: MainActivity? = null
    }

    private lateinit var root: FrameLayout
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    private val server by lazy { WebServer(this) }
    private val io = Executors.newSingleThreadExecutor()

    private var pageReady = false
    private val proReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: android.content.Context, intent: Intent) {
            val ev = intent.getStringExtra("event") ?: return
            if (pageReady) emit("pro", JSONObject(ev))
        }
    }
    private var pendingIntent: JSONObject? = null
    private val waiting = HashMap<Int, Int>() // 요청 코드 → 화면의 call id

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        web = WebView(this)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(root)
        setupInsets()

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = true
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE // http 사진도 보이게
            setSupportZoom(false)
        }
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.setBackgroundColor(Color.TRANSPARENT)
        bridge = Bridge(this)
        web.addJavascriptInterface(bridge, "MemoKingNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                server.handle(request)

            // 앱 밖 주소는 브라우저로
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == WebServer.HOST) return false
                launchView(request.url)
                return true
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                android.util.Log.d("MemoKing", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        setupBack()
        // 녹음 서비스의 소식(시간·받아쓴 글·끝남)을 화면으로
        RecorderService.listener = { ev -> runOnUiThread { if (pageReady) emit("record", ev) } }
        // 받아쓰기 프로세스(:pro)의 소식(진행·끝남)은 방송으로 온다
        val filter = android.content.IntentFilter(ProService.ACTION_EVENT)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(proReceiver, filter, RECEIVER_NOT_EXPORTED)
        else registerReceiver(proReceiver, filter)
        web.loadUrl(WebServer.START)
        if (savedInstanceState == null) handleIntent(intent)
    }

    // ---------- 화면 가장자리 (상태 막대·내비게이션 막대·키보드) ----------

    private fun setupInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // 예전 안드로이드는 시스템이 알아서 비켜 준다 (adjustResize)
        window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { v, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            val ime = insets.getInsets(WindowInsets.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            val keyboard = insets.isVisible(WindowInsets.Type.ime())
            if (pageReady) emit("keyboard", JSONObject().put("open", keyboard))
            WindowInsets.CONSUMED
        }
    }

    /** 화면이 바뀔 때 위·아래 막대 색을 맞춘다 (메모를 열면 메모 색) */
    fun setChrome(color: String, darkIcons: Boolean) {
        val c = try {
            Color.parseColor(color)
        } catch (e: IllegalArgumentException) {
            return
        }
        root.setBackgroundColor(c)
        @Suppress("DEPRECATION")
        if (Build.VERSION.SDK_INT < 35) {
            window.statusBarColor = c
            window.navigationBarColor = c
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (darkIcons) mask else 0, mask)
        } else {
            @Suppress("DEPRECATION")
            val flags = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (darkIcons) flags else 0
        }
    }

    // ---------- 뒤로 가기: 화면(메모 → 목록, 패널 닫기)이 먼저, 더 갈 데가 없으면 앱을 뒤로 ----------

    private fun setupBack() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
        }
    }

    @Deprecated("Android 13 부터는 OnBackInvokedDispatcher")
    override fun onBackPressed() {
        goBack()
    }

    private fun goBack() {
        if (!pageReady) {
            moveTaskToBack(true)
            return
        }
        web.evaluateJavascript("window.__mk ? __mk.back() : false") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    // ---------- 화면과 주고받기 ----------

    fun js(code: String) {
        web.evaluateJavascript(code, null)
    }

    fun emit(name: String, data: Any?) {
        val json = when (data) {
            null -> "null"
            is JSONObject, is JSONArray -> data.toString()
            else -> JSONObject.quote(data.toString())
        }
        js("window.__mk && __mk.emit(${JSONObject.quote(name)}, $json)")
    }

    fun onPageReady() {
        pageReady = true
        Notifier.ensureChannel(this)
        io.execute { Temp.sweep(this) }
    }

    fun onAlarm(item: JSONObject) {
        runOnUiThread { if (pageReady) emit("alarm", item) }
    }

    // 화면이 보이는 동안 1분마다 Google Drive 와 맞추기
    private val syncTick = object : Runnable {
        override fun run() {
            DriveSync.request(this@MainActivity)
            root.postDelayed(this, 60_000)
        }
    }

    override fun onResume() {
        super.onResume()
        visible = this
        if (pageReady) emit("app", "resume")
        DriveSync.listener = { status -> runOnUiThread { if (pageReady) emit("sync", status.json()) } }
        NotiStore.listener = { runOnUiThread { if (pageReady) emit("history", null) } }
        root.removeCallbacks(syncTick)
        root.post(syncTick)
    }

    override fun onPause() {
        if (pageReady) emit("app", "pause") // 쓰던 메모를 바로 저장
        if (visible === this) visible = null
        root.removeCallbacks(syncTick)
        DriveSync.request(this, 1500) // 방금 고친 것을 바로 올린다
        DriveSync.schedule(this)
        super.onPause()
    }

    /** 휴대폰에 로그인된 구글 계정으로 Drive 권한 받기 — 계정 고르기·허용 화면만 */
    fun loginWithPhoneAccount(id: Int) {
        waiting[REQ_AUTH]?.let { old -> bridge.resolve(old) { throw GoogleAuth.AuthError("로그인을 취소했어요") } }
        waiting[REQ_AUTH] = id
        NativeAuth.begin(
            this,
            startForResult = { sender ->
                try {
                    @Suppress("DEPRECATION")
                    startIntentSenderForResult(sender, REQ_AUTH, null, 0, 0, 0)
                } catch (e: Exception) {
                    waiting.remove(REQ_AUTH)
                    bridge.resolve(id) { throw GoogleAuth.AuthError(NativeAuth.describe(e)) }
                }
            },
            onToken = { token -> finishPhoneLogin(token) },
            onError = { message ->
                waiting.remove(REQ_AUTH)
                bridge.resolve(id) { throw GoogleAuth.AuthError(message) }
            },
        )
    }

    private fun finishPhoneLogin(token: String) {
        val id = waiting.remove(REQ_AUTH) ?: return
        io.execute { bridge.resolve(id) { JSONObject().put("email", GoogleAuth.completeNative(this, token)) } }
    }

    fun openBrowser(url: String) {
        launchView(Uri.parse(url))
    }

    /** 브라우저에서 로그인을 마쳤을 때 앱을 앞으로 (안 되면 사용자가 "메모킹으로 돌아가기" 를 누른다) */
    fun bringToFront() {
        try {
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        } catch (e: Exception) {
            // 백그라운드에서 화면 띄우기가 막힘
        }
    }

    override fun onDestroy() {
        if (visible === this) visible = null
        RecorderService.listener = null
        try {
            unregisterReceiver(proReceiver)
        } catch (e: IllegalArgumentException) {
            // 이미 풀림
        }
        web.destroy()
        super.onDestroy()
    }

    // ---------- 다른 앱에서 들어온 것: 공유하기, 알림 누르기, 바로가기 ----------

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    fun takePendingIntent(): JSONObject? = pendingIntent.also { pendingIntent = null }

    private fun deliver(payload: JSONObject) = runOnUiThread {
        pendingIntent = payload
        if (pageReady) emit("intent", null)
    }

    private fun sourceApp(): String {
        val pkg = referrer?.takeIf { it.scheme == "android-app" }?.host ?: return ""
        if (pkg == packageName) return ""
        return try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (e: PackageManager.NameNotFoundException) {
            ""
        }
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            ACTION_OPEN_MEMO -> deliver(
                JSONObject().put("type", "open")
                    .put("memoId", intent.getStringExtra("memoId") ?: "")
                    .put("label", intent.getStringExtra("label") ?: ""),
            )
            ACTION_NEW_MEMO -> deliver(JSONObject().put("type", "new"))
            // 다른 앱의 "다른 앱으로 열기"(소리 파일·마크다운·글 파일) → 공유하기와 같게 새 메모
            Intent.ACTION_VIEW -> {
                val uri = intent.data ?: return
                if (uri.scheme == "memoking") return
                val app = sourceApp()
                io.execute {
                    deliver(JSONObject().put("type", "share").put("text", "").put("app", app).put("files", copyToTemp(listOf(uri))))
                }
            }
            Intent.ACTION_PROCESS_TEXT -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString() ?: return
                deliver(JSONObject().put("type", "share").put("text", text).put("app", sourceApp()).put("files", JSONArray()))
            }
            Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> {
                val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString() ?: ""
                val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT) ?: intent.getStringExtra(Intent.EXTRA_TITLE) ?: ""
                val uris = sharedUris(intent)
                val app = sourceApp()
                io.execute {
                    val files = copyToTemp(uris)
                    deliver(
                        JSONObject().put("type", "share").put("text", text).put("subject", subject)
                            .put("app", app).put("files", files),
                    )
                }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun sharedUris(intent: Intent): List<Uri> {
        val out = LinkedHashSet<Uri>()
        if (intent.action == Intent.ACTION_SEND) {
            (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let(out::add)
        } else {
            intent.getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)?.forEach { (it as? Uri)?.let(out::add) }
        }
        val clip = intent.clipData
        if (clip != null) for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(out::add)
        return out.toList()
    }

    /** 다른 앱의 파일을 앱 임시 폴더로 복사: [{ temp, name, mime, size }] */
    private fun copyToTemp(uris: List<Uri>): JSONArray {
        val out = JSONArray()
        for (uri in uris) {
            try {
                var name = ""
                var size = -1L
                contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        name = c.getString(0) ?: ""
                        if (!c.isNull(1)) size = c.getLong(1)
                    }
                }
                if (name.isEmpty()) name = uri.lastPathSegment?.substringAfterLast('/') ?: "파일"
                val mime = contentResolver.getType(uri) ?: VaultFileProvider.mimeOf(name)
                val (id, file) = Temp.create(this)
                contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { input.copyTo(it) } } ?: continue
                out.put(JSONObject().put("temp", id).put("name", name).put("mime", mime).put("size", if (size >= 0) size else file.length()))
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "공유받은 파일을 읽지 못했어요: $uri", e)
            }
        }
        return out
    }

    // ---------- 화면이 부탁하는 일 ----------

    fun pickFolder(id: Int) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
            Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
        )
        startForResult(intent, REQ_FOLDER, id)
    }

    fun pickFiles(id: Int, accept: String) {
        // 사진은 안드로이드 13 부터 있는 사진 선택 화면으로 (갤러리처럼 보여서 고르기 쉽다)
        if (accept == "image/*" && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val intent = Intent(MediaStore.ACTION_PICK_IMAGES)
                .putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, MediaStore.getPickImagesMaxLimit())
            startForResult(intent, REQ_FILES, id)
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(accept.ifBlank { "*/*" })
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        startForResult(intent, REQ_FILES, id)
    }

    private fun startForResult(intent: Intent, req: Int, id: Int) {
        waiting[req]?.let { old -> bridge.resolve(old) { null } } // 앞서 기다리던 요청은 취소로
        waiting[req] = id
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, req)
        } catch (e: ActivityNotFoundException) {
            waiting.remove(req)
            bridge.resolve(id) { throw IllegalStateException("이 휴대폰에서 열 수 있는 앱이 없어요") }
        }
    }

    @Deprecated("Activity Result API 대신 단순한 방식을 쓴다 (androidx 없이)")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_AUTH) {
            val token = try {
                if (resultCode != RESULT_OK) throw GoogleAuth.AuthError("로그인을 취소했어요")
                NativeAuth.finish(this, data)
            } catch (e: Exception) {
                val id = waiting.remove(REQ_AUTH) ?: return
                bridge.resolve(id) { throw GoogleAuth.AuthError(if (e is GoogleAuth.AuthError) e.message ?: "" else NativeAuth.describe(e)) }
                return
            }
            finishPhoneLogin(token)
            return
        }
        val id = waiting.remove(requestCode) ?: return
        if (resultCode != RESULT_OK || data == null) {
            bridge.resolve(id) { null }
            return
        }
        when (requestCode) {
            REQ_FOLDER -> {
                val uri = data.data ?: return bridge.resolve(id) { null }
                io.execute {
                    bridge.resolve(id) {
                        contentResolver.takePersistableUriPermission(
                            uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                        )
                        Vaults.use(this, uri.toString()) ?: throw IllegalStateException("이 폴더는 쓸 수 없어요. 다른 폴더를 골라 주세요")
                        bridge.vaultInfo()
                    }
                }
            }
            REQ_FILES -> {
                val uris = buildList {
                    data.data?.let(::add)
                    data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(::add) }
                }.distinct()
                io.execute { bridge.resolve(id) { copyToTemp(uris) } }
            }
        }
    }

    fun openVaultFile(id: Int, rel: String) {
        bridge.resolve(id) {
            val storage = Vaults.current(this) ?: throw IllegalStateException("메모 폴더가 연결돼 있지 않아요")
            val uri = storage.shareUri(rel) ?: return@resolve "이 휴대폰의 메모 폴더에 파일이 아직 없어요"
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, VaultFileProvider.mimeOf(rel))
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            try {
                startActivity(Intent.createChooser(intent, null))
                null
            } catch (e: ActivityNotFoundException) {
                "이 파일을 열 수 있는 앱이 없어요"
            }
        }
    }

    private fun launchView(uri: Uri): Boolean = try {
        startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: ActivityNotFoundException) {
        false
    }

    fun openUrl(id: Int, url: String) {
        val uri = Uri.parse(url)
        bridge.resolve(id) {
            if (uri.scheme != "http" && uri.scheme != "https") throw IllegalArgumentException("인터넷 주소가 아니에요")
            launchView(uri)
        }
    }

    fun shareText(id: Int, title: String, text: String) {
        val intent = Intent(Intent.ACTION_SEND).setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, text)
            .putExtra(Intent.EXTRA_SUBJECT, title)
        bridge.resolve(id) {
            startActivity(Intent.createChooser(intent, title.ifEmpty { null }))
            true
        }
    }

    /** 지금 보이는 메모를 인쇄 화면으로 (안드로이드 인쇄 화면에서 "PDF로 저장") */
    fun printPage(id: Int, title: String) {
        bridge.resolve(id) {
            val pm = getSystemService(PrintManager::class.java)!!
            pm.print(title, web.createPrintDocumentAdapter(title), null)
            true
        }
    }

    fun requestNotifyPermission(id: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) {
            bridge.resolve(id) { true }
            return
        }
        waiting[REQ_NOTIFY]?.let { old -> bridge.resolve(old) { false } }
        waiting[REQ_NOTIFY] = id
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFY)
    }

    /** 녹음: 마이크 권한 (안드로이드 13+ 은 녹음 알림이 보이도록 알림 권한도 함께) */
    fun requestMicPermission(id: Int) {
        if (RecorderService.hasMic(this)) {
            bridge.resolve(id) { true }
            return
        }
        waiting[REQ_MIC]?.let { old -> bridge.resolve(old) { false } }
        waiting[REQ_MIC] = id
        val perms = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        requestPermissions(perms.toTypedArray(), REQ_MIC)
    }

    /** 앱 캐시의 파일(그림·PDF)을 다른 앱으로 보내기 */
    fun shareFile(id: Int, file: java.io.File, mime: String, title: String) {
        bridge.resolve(id) {
            val uri = VaultFileProvider.shareUriFor(file.name)
            val intent = Intent(Intent.ACTION_SEND).setType(mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .putExtra(Intent.EXTRA_SUBJECT, title)
                .putExtra(Intent.EXTRA_TITLE, title)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.clipData = android.content.ClipData.newRawUri(title, uri)
            startActivity(Intent.createChooser(intent, title.ifEmpty { null }).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            true
        }
    }

    /** 지금 보이는 메모를 PDF 파일로 만들어(인쇄 화면 없이) 보내기 — 글자를 고를 수 있는 PDF */
    fun sharePdf(id: Int, file: java.io.File, title: String) {
        val attrs = PrintAttributes.Builder()
            .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
            .setResolution(PrintAttributes.Resolution("pdf", "pdf", 300, 300))
            .setMinMargins(PrintAttributes.Margins(720, 720, 720, 720)) // 1.27cm (1/1000 인치 단위)
            .build()
        try {
            PdfPrint(attrs).write(web.createPrintDocumentAdapter(file.name), file) { error ->
                runOnUiThread {
                    if (error != null) bridge.resolve(id) { throw IllegalStateException("PDF를 만들지 못했어요: ${error.message}") }
                    else shareFile(id, file, "application/pdf", title)
                }
            }
        } catch (e: Throwable) {
            bridge.resolve(id) { throw IllegalStateException("PDF를 만들지 못했어요: ${e.message}") }
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val id = waiting.remove(requestCode) ?: return
        if (requestCode == REQ_MIC) {
            bridge.resolve(id) { RecorderService.hasMic(this) }
            return
        }
        bridge.resolve(id) { grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED }
    }

    /** 안드로이드 설정의 "알림 접근" 화면 (메모킹을 켜도록) */
    fun openNotificationAccess(id: Int) {
        bridge.resolve(id) {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, android.content.ComponentName(this, NotiService::class.java).flattenToString())
            } else {
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            }
            try {
                startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
            true
        }
    }

    fun openExactAlarmSettings(id: Int) {
        bridge.resolve(id) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
            }
            true
        }
    }
}
