package com.memoking.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.print.PdfPrint
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.provider.Settings
import android.view.MotionEvent
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

// 삼성 S펜 옆 버튼을 누른 채 닿을 때의 동작 번호 (삼성 기기 전용, 표준 MotionEvent 에 없음)
private const val SPEN_ACTION_DOWN = 211
private const val SPEN_ACTION_UP = 212
private const val SPEN_ACTION_MOVE = 213
private const val SPEN_ACTION_CANCEL = 214

/**
 * 메모킹 안드로이드 — 화면 하나(WebView)에 휴대폰용 화면(android/web)을 띄우고,
 * 메모 폴더·알림·공유 같은 휴대폰 기능은 Bridge 로 이어 준다.
 */
class MainActivity : Activity() {
    companion object {
        const val ACTION_OPEN_MEMO = "com.memoking.app.OPEN_MEMO"
        const val ACTION_NEW_MEMO = "com.memoking.app.NEW_MEMO"
        const val ACTION_NEW_VOICE = "com.memoking.app.NEW_VOICE"
        private const val REQ_FOLDER = 1
        private const val REQ_FILES = 2
        private const val REQ_NOTIFY = 3
        private const val REQ_AUTH = 4
        private const val REQ_MIC = 5
        private const val REQ_SAVE = 6
        private const val REQ_CALENDAR = 7
        private const val REQ_INSTALL = 8
        private const val PDF_TIMEOUT_MS = 15_000L // PDF 만들기를 이만큼 기다리고, 넘으면 인쇄 화면으로

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
    private var pendingIntent: JSONObject? = null
    private val waiting = HashMap<Int, Int>() // 요청 코드 → 화면의 call id

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        com.memoking.app.drive.GoogleAuth.upgradeScope(this) // 예전 Drive 전체 권한 연결이면 다시 연결하게
        Thread { Stt.removeOldModels(this) }.start() // 예전에 받아 둔 Vosk 받아쓰기 데이터 정리
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
        web.loadUrl(WebServer.START)
        if (savedInstanceState == null) handleIntent(intent)
    }

    // ---------- S펜 버튼 (갤럭시 탭 등): 누른 채 그리면 지우개 ----------
    //   웹 화면에는 버튼 표시를 뗀 터치를 넘기고, 버튼이 눌렸는지는 앱이 직접 알려 준다 (penButton)

    private var penButton = false

    private fun setPenButton(down: Boolean) {
        if (down == penButton) return
        penButton = down
        if (pageReady) emit("penButton", JSONObject().put("down", down))
    }

    private fun trackPenButton(ev: MotionEvent) {
        if (ev.pointerCount == 0 || ev.getToolType(0) != MotionEvent.TOOL_TYPE_STYLUS) return
        setPenButton(ev.isButtonPressed(MotionEvent.BUTTON_STYLUS_PRIMARY) || ev.isButtonPressed(MotionEvent.BUTTON_SECONDARY))
    }

    // 갤럭시(삼성) S펜: 옆 버튼을 누른 채 화면에 대면 터치가 표준 DOWN·UP·MOVE 가 아니라 삼성 전용 동작 번호
    //   (211 누름 · 212 뗌 · 213 움직임 · 214 취소)로 온다. 웹 화면(WebView)은 이 번호를 몰라 그리기·지우기를 못 받으므로
    //   표준 동작으로 바꾼다. 버튼 표시(buttonState)는 떼어 낸다 — 버튼이 눌린 펜을 웹 화면은 오른쪽 단추 끌기(글자 고르기)로
    //   받아 움직임이 끊기고 지우개 동그라미가 한 자리에 멈춰 버렸다. 지우개인지는 앱이 따로 알려 준다(penButton)
    private fun samsungPenEvent(ev: MotionEvent): MotionEvent? {
        val action = when (ev.actionMasked) {
            SPEN_ACTION_DOWN -> MotionEvent.ACTION_DOWN
            SPEN_ACTION_UP -> MotionEvent.ACTION_UP
            SPEN_ACTION_MOVE -> MotionEvent.ACTION_MOVE
            SPEN_ACTION_CANCEL -> MotionEvent.ACTION_CANCEL
            else -> return null
        }
        return plainCopy(ev, action)
    }

    /** 펜 버튼 표시 없이 같은 터치 (지난 점들 — 빠르게 그은 사이의 점 — 도 그대로) */
    private fun plainCopy(ev: MotionEvent, action: Int): MotionEvent {
        val n = ev.pointerCount
        val props = Array(n) { i -> MotionEvent.PointerProperties().also { ev.getPointerProperties(i, it) } }
        fun coordsAt(h: Int) = Array(n) { i ->
            MotionEvent.PointerCoords().also { if (h < 0) ev.getPointerCoords(i, it) else ev.getHistoricalPointerCoords(i, h, it) }
        }
        val buttons = ev.buttonState and (MotionEvent.BUTTON_STYLUS_PRIMARY or MotionEvent.BUTTON_SECONDARY or MotionEvent.BUTTON_STYLUS_SECONDARY).inv()
        val first = if (ev.historySize > 0) 0 else -1
        val out = MotionEvent.obtain(
            ev.downTime, if (first < 0) ev.eventTime else ev.getHistoricalEventTime(0), action, n, props, coordsAt(first),
            ev.metaState, buttons, ev.xPrecision, ev.yPrecision, ev.deviceId, ev.edgeFlags, ev.source, ev.flags,
        )
        for (h in 1 until ev.historySize) out.addBatch(ev.getHistoricalEventTime(h), coordsAt(h), ev.metaState)
        if (first == 0) out.addBatch(ev.eventTime, coordsAt(-1), ev.metaState)
        return out
    }

    private fun stylusButtonDown(ev: MotionEvent) =
        ev.pointerCount > 0 && ev.getToolType(0) == MotionEvent.TOOL_TYPE_STYLUS &&
            (ev.isButtonPressed(MotionEvent.BUTTON_STYLUS_PRIMARY) || ev.isButtonPressed(MotionEvent.BUTTON_SECONDARY))

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        // 삼성 전용 번호이거나, 표준 터치라도 펜 버튼이 눌려 있으면 버튼 표시를 뗀 터치로 넘긴다
        val spen = samsungPenEvent(ev) ?: if (stylusButtonDown(ev)) plainCopy(ev, ev.action) else null
        if (spen != null) {
            // 웹에 버튼 소식을 먼저 보내고(지우개로), 바꾼 터치를 넘긴다. 떼면 다음 획이 지우개로 시작하지 않게 풀어 둔다
            val lifted = spen.actionMasked == MotionEvent.ACTION_UP || spen.actionMasked == MotionEvent.ACTION_CANCEL
            if (!lifted) setPenButton(true)
            return try {
                super.dispatchTouchEvent(spen)
            } finally {
                spen.recycle()
                if (lifted) setPenButton(false)
            }
        }
        trackPenButton(ev)
        return super.dispatchTouchEvent(ev)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        trackPenButton(ev) // 화면 위에 펜을 띄운 채(호버) 버튼을 누를 때
        return super.dispatchGenericMotionEvent(ev)
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

    /** S펜으로 글자 칸에 쓰면 글자로 바꾸는 손글씨 입력을 켜고 끈다 (메모 화면이 다루기 방식·설정에 맞춰 부른다) */
    fun setHandwriting(on: Boolean) {
        if (Build.VERSION.SDK_INT >= 33) web.isAutoHandwritingEnabled = on
    }

    /**
     * 키보드를 꺼내거나 넣는다 — S펜으로 쓰는 중에는 글자를 눌러도 손글씨 입력이 먼저 떠서 키보드를 부를 수가 없어,
     * 메모 화면의 키보드 단추가 부른다 (편집기에 초점을 준 뒤)
     */
    fun showKeyboard(show: Boolean) {
        if (show) web.requestFocus()
        if (Build.VERSION.SDK_INT >= 30) {
            val c = web.windowInsetsController ?: window.insetsController
            if (show) c?.show(WindowInsets.Type.ime()) else c?.hide(WindowInsets.Type.ime())
        } else {
            val imm = getSystemService(android.view.inputmethod.InputMethodManager::class.java)
            if (show) imm?.showSoftInput(web, 0) else imm?.hideSoftInputFromWindow(web.windowToken, 0)
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

    // 화면이 보이는 동안 10초마다 (파일이 오간 뒤 2분은 5초) Google Drive 와 맞추기 — 평소에는 바뀐 목록 한 번만 묻는다
    private val syncTick = object : Runnable {
        override fun run() {
            DriveSync.request(this@MainActivity)
            root.postDelayed(this, DriveSync.pollDelay())
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

    /** 휴대폰에 로그인된 구글 계정으로 Drive 권한 받기 (drive.file) — 계정 고르기·허용 화면만 */
    fun loginWithPhoneAccount(id: Int) {
        waiting[REQ_AUTH]?.let { old -> bridge.resolve(old) { throw GoogleAuth.AuthError("로그인을 취소했어요") } }
        waiting[REQ_AUTH] = id
        NativeAuth.begin(
            this,
            GoogleAuth.SCOPE,
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
        main.removeCallbacksAndMessages(null)
        printWeb?.destroy()
        printWeb = null
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
            ACTION_NEW_VOICE -> deliver(JSONObject().put("type", "new").put("voice", true))
            // 위젯 고르기 목록에서 놓은 위젯을 누름 → 보일 메모 고르기
            // (위젯이 함께 보낸 표가 맞을 때만 — 다른 앱의 흉내는 무시)
            Widgets.ACTION_PICK -> if (intent.getStringExtra(Widgets.EXTRA_TOKEN) == Widgets.pickToken(this)) {
                deliver(
                    JSONObject().put("type", "widget-pick")
                        .put("widgetId", intent.getIntExtra(android.appwidget.AppWidgetManager.EXTRA_APPWIDGET_ID, -1)),
                )
            }
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

    /** 다른 앱의 파일을 앱 임시 폴더로 복사: [{ temp, name, mime, size }] (클립보드의 그림 붙여넣기도) */
    fun copyToTemp(uris: List<Uri>): JSONArray {
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
                val input = contentResolver.openInputStream(uri) ?: continue
                val (id, file) = Temp.create(this)
                try {
                    input.use { i -> file.outputStream().use { i.copyTo(it) } }
                } catch (e: Exception) {
                    file.delete()
                    throw e
                }
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

    // 저장 단추: 저장 창에서 고른 곳에 쓸 파일 (창이 닫히면 지운다)
    private var pendingSave: java.io.File? = null

    fun saveAs(id: Int, file: java.io.File, name: String, mime: String) {
        pendingSave?.delete()
        pendingSave = file
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime.ifBlank { "application/octet-stream" })
            .putExtra(Intent.EXTRA_TITLE, name)
        startForResult(intent, REQ_SAVE, id)
    }

    private fun startForResult(intent: Intent, req: Int, id: Int) {
        waiting[req]?.let { old -> bridge.resolve(old) { null } } // 앞서 기다리던 요청은 취소로
        waiting[req] = id
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, req)
        } catch (e: ActivityNotFoundException) {
            waiting.remove(req)
            if (req == REQ_SAVE) {
                pendingSave?.delete()
                pendingSave = null
            }
            bridge.resolve(id) { throw IllegalStateException("이 휴대폰에서 열 수 있는 앱이 없어요. 파일을 열 앱을 설치해 주세요") }
        }
    }

    /** 받은 업데이트 APK 를 안드로이드 설치 화면으로 (브라우저로 받은 APK 를 열 때와 같은 화면) */
    fun installUpdate(file: java.io.File) {
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(AppUpdate.installIntent(file), REQ_INSTALL)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "설치 화면을 열지 못했어요", e)
            emit("updateResult", JSONObject().put("status", 1).put("why", "설치 화면을 열지 못했어요"))
        }
    }

    @Deprecated("Activity Result API 대신 단순한 방식을 쓴다 (androidx 없이)")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_INSTALL) {
            // 성공이면 곧 새 버전으로 바뀌고, 취소 · 실패면 화면에 까닭과 함께 다시 누르게
            val code = data?.getIntExtra("android.intent.extra.INSTALL_RESULT", 0) ?: 0
            val status = AppUpdate.failStatus(resultCode == RESULT_OK, resultCode == RESULT_CANCELED, code) ?: return
            emit("updateResult", JSONObject().put("status", status).put("why", if (code != 0) "오류 $code" else ""))
            return
        }
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
            if (requestCode == REQ_SAVE) pendingSave?.delete().also { pendingSave = null }
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
                        Vaults.use(this, uri.toString()) ?: throw IllegalStateException("이 폴더는 쓸 수 없어요. 다른 폴더를 선택해 주세요")
                        bridge.vaultInfo()
                    }
                }
            }
            REQ_SAVE -> {
                val target = data.data
                val file = pendingSave
                pendingSave = null
                io.execute {
                    bridge.resolve(id) {
                        try {
                            if (target == null || file == null) throw IllegalStateException("저장하지 못했어요. 저장 공간과 폴더 권한을 확인하고 다시 해 주세요")
                            contentResolver.openOutputStream(target)?.use { out -> file.inputStream().use { it.copyTo(out) } }
                                ?: throw IllegalStateException("저장하지 못했어요. 저장 공간과 폴더 권한을 확인하고 다시 해 주세요")
                            var name = file.name
                            contentResolver.query(target, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                                if (c.moveToFirst()) name = c.getString(0) ?: name
                            }
                            name
                        } finally {
                            file?.delete()
                        }
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
            val storage = Vaults.forScreen(this) ?: throw IllegalStateException("메모 폴더가 아직 없어요. 설정에서 메모 폴더를 골라 주세요")
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

    /** 휴대폰 캘린더의 일정을 그 캘린더 앱(삼성 캘린더 · Google 캘린더)에서 연다 */
    fun openCalendarEvent(id: Int, eventId: Long, begin: Long, end: Long) {
        val intent = Intent(Intent.ACTION_VIEW, ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, eventId))
            .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, begin)
            .putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        bridge.resolve(id) {
            try {
                startActivity(intent)
                true
            } catch (e: ActivityNotFoundException) {
                false
            }
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

    /** 메모를 인쇄 화면으로 (안드로이드 인쇄 화면에서 "PDF로 저장"). html 이 있으면 그 인쇄 전용 문서(고른 내용 크기)로, 없으면 지금 화면 그대로 */
    fun printPage(id: Int, title: String, html: String? = null) {
        if (html != null) {
            openPrintDialog(id, title, html)
            return
        }
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

    /** 휴대폰 캘린더 읽기 권한 (일정 탭의 "휴대폰 캘린더 함께 보기") → 허용했는가 */
    fun requestCalendarPermission(id: Int) {
        if (DeviceCalendar.granted(this)) {
            bridge.resolve(id) { true }
            return
        }
        waiting[REQ_CALENDAR]?.let { old -> bridge.resolve(old) { false } }
        waiting[REQ_CALENDAR] = id
        requestPermissions(arrayOf(Manifest.permission.READ_CALENDAR), REQ_CALENDAR)
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

    /** 지금 인쇄용 WebView (끝날 때까지 붙잡아 둔다 — 버려지면 PDF 가 중간에 끊긴다) */
    private var printWeb: WebView? = null
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var pdfJob = 0

    private fun pdfAttributes() = PrintAttributes.Builder()
        .setMediaSize(PrintAttributes.MediaSize.ISO_A4)
        .setResolution(PrintAttributes.Resolution("pdf", "pdf", 300, 300))
        .setMinMargins(PrintAttributes.Margins(720, 720, 720, 720)) // 0.72인치 = 1.83cm (1/1000 인치 단위) — print-html.js PAGE_MARGIN_MM 과 같게
        .build()

    // 인쇄용 WebView 치우기. 주의: 창에 붙지 않은 View 의 postDelayed 는 붙을 때까지 미뤄져 끝내 돌지 않으므로 Handler 로
    //   (아직 PDF 를 쓰는 중일 수 있으면 later — 한참 뒤에 없앤다)
    private fun dropPrintWeb(view: WebView, later: Boolean = false) {
        if (printWeb === view) printWeb = null
        root.removeView(view)
        main.postDelayed({ view.destroy() }, if (later) 60_000L else 500L)
    }

    /**
     * 인쇄 전용 문서를 띄운 WebView 를 만들어, 그림·글꼴까지 다 그려지면 ready 로 넘긴다.
     *   메인 화면 뒤(같은 창)에 붙여 둔다 — 창에 붙지 않은 WebView 는 휴대폰에 따라 그리기를 미뤄 PDF 가 끝나지 않을 수 있다.
     *   메인 화면이 덮고 있어 보이지 않는다.
     */
    private fun loadPrintWeb(html: String, ready: (WebView) -> Unit) {
        printWeb?.let { dropPrintWeb(it) }
        val pw = WebView(this)
        printWeb = pw
        pw.settings.apply {
            javaScriptEnabled = false // 그려 둔 그대로만
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            blockNetworkImage = false
        }
        root.addView(pw, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        var started = false
        pw.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = server.handle(request)
            override fun onPageFinished(view: WebView, url: String?) {
                if (started) return
                started = true
                // 그림·글꼴이 다 그려지도록 조금 기다렸다가 (창에 붙지 않은 View 의 postDelayed 는 돌지 않으므로 Handler 로)
                main.postDelayed({ if (printWeb === view) ready(view) }, 700)
            }
        }
        pw.loadDataWithBaseURL(WebServer.START, html, "text/html", "utf-8", null)
    }

    /**
     * 메모를 PDF 파일로 보내기 (인쇄 화면 없이, 글자를 고를 수 있는 PDF).
     *   html 이 있으면(화면이 만든 인쇄 전용 문서) 따로 띄운 WebView 로 — 앱 화면 틀(고정 높이·안쪽 스크롤·열린 시트)이
     *   끼지 않아 쪽이 비지 않는다. 없으면 예전처럼 지금 화면.
     *   PDF_TIMEOUT_MS 안에 끝나지 않으면(일부 휴대폰의 WebView) 계속 기다리게 두지 않고 인쇄 화면("PDF로 저장")으로 —
     *   결과 "print"
     */
    fun sharePdf(id: Int, file: java.io.File, title: String, html: String? = null) {
        val job = ++pdfJob
        var settled = false
        fun settle(block: () -> Unit) {
            if (settled || job != pdfJob) return
            settled = true
            block()
        }
        val timeout = Runnable {
            settle {
                android.util.Log.w("MemoKing", "PDF: 시간 안에 끝나지 않아 인쇄 화면으로")
                printWeb?.let { dropPrintWeb(it, later = true) }
                openPrintDialog(id, title, html)
            }
        }
        main.postDelayed(timeout, PDF_TIMEOUT_MS)
        val write = { view: WebView ->
            try {
                PdfPrint(pdfAttributes()).write(view.createPrintDocumentAdapter(file.name), file) { error ->
                    runOnUiThread {
                        settle {
                            main.removeCallbacks(timeout)
                            if (view !== web) dropPrintWeb(view)
                            if (error != null || file.length() < 200) {
                                if (error != null) android.util.Log.w("MemoKing", "PDF", error)
                                openPrintDialog(id, title, html) // 바로 못 만들면 인쇄 화면으로 (거기서 PDF로 저장)
                            } else shareFile(id, file, "application/pdf", title)
                        }
                    }
                }
            } catch (e: Throwable) {
                android.util.Log.w("MemoKing", "PDF", e)
                settle {
                    main.removeCallbacks(timeout)
                    if (view !== web) dropPrintWeb(view)
                    openPrintDialog(id, title, html)
                }
            }
        }
        if (html.isNullOrBlank()) write(web) else loadPrintWeb(html) { write(it) }
    }

    /** 안드로이드 인쇄 화면 (프린터 · "PDF로 저장") — 인쇄 전용 문서가 있으면 그것을, 없으면 지금 화면 */
    private fun openPrintDialog(id: Int, title: String, html: String?) {
        val show = { view: WebView ->
            bridge.resolve(id) {
                getSystemService(PrintManager::class.java)!!.print(title, view.createPrintDocumentAdapter(title), pdfAttributes())
                "print"
            }
        }
        // 인쇄 화면이 쓰는 동안 WebView 를 붙잡아 둔다 (다음 PDF 때나 화면이 닫힐 때 치운다)
        if (html.isNullOrBlank()) show(web) else loadPrintWeb(html) { show(it) }
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
