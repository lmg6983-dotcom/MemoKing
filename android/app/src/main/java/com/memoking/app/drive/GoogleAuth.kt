package com.memoking.app.drive

import android.content.Context
import android.util.Base64
import com.memoking.app.BuildConfig
import com.memoking.app.Vaults
import org.json.JSONObject
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.net.URL
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.MessageDigest
import java.security.SecureRandom

/**
 * 구글 로그인 (Google Drive 권한). 두 가지 방법:
 *   기본: 휴대폰에 로그인된 구글 계정 그대로 (Play 서비스, NativeAuth) — 계정 고르고 "허용"만
 *   예비: 휴대폰 브라우저로 로그인하고 앱 안 작은 서버(127.0.0.1)로 결과를 받기
 *         ("데스크톱 앱" 유형 OAuth 클라이언트 + PKCE, Play 서비스가 없는 휴대폰용). 클라이언트 ID 는
 *         빌드할 때 넣거나(BuildConfig) 앱 설정에서 붙여 넣는다.
 */
object GoogleAuth {
    // 메모킹이 만든(또는 메모킹으로 연) 파일·폴더만 — Drive 전체를 보지 않는다 (스토어 심사의 "제한 범위"가 아님)
    // 메모킹(같은 Google Cloud 프로젝트)이 만든 파일만 — Play 스토어 공개에 제한 범위 심사가 필요 없게.
    //   제미나이 등 다른 앱이 폴더에 넣은 메모는 PC 메모킹(Drive 전체 권한)이 메모킹 파일로 다시 올려 주므로 휴대폰에도 보인다
    const val SCOPE = "https://www.googleapis.com/auth/drive.file"
    // 0.23.8 에서 잠깐 Drive 전체로 연결한 것 — drive.file 을 품으므로 끊지 않는다
    private const val FULL_SCOPE = "https://www.googleapis.com/auth/drive"
    private const val AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
    private const val TOKEN_URL = "https://oauth2.googleapis.com/token"
    private const val KEY_ID = "googleClientId"
    private const val KEY_SECRET = "googleClientSecret"
    private const val KEY_REFRESH = "googleRefreshToken"
    private const val KEY_EMAIL = "googleEmail"
    private const val KEY_NATIVE = "googleNative"
    private const val KEY_SCOPE = "googleScope"
    private const val KEY_RECONNECT = "googleReconnect"
    private const val LOGIN_TIMEOUT = 5 * 60 * 1000

    class AuthError(message: String) : IOException(message)

    @Volatile private var accessToken: String? = null
    @Volatile private var expiresAt = 0L
    @Volatile private var pendingServer: ServerSocket? = null

    private fun prefs(ctx: Context) = Vaults.prefs(ctx)

    fun clientId(ctx: Context): String = prefs(ctx).getString(KEY_ID, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.GOOGLE_CLIENT_ID
    fun clientSecret(ctx: Context): String = prefs(ctx).getString(KEY_SECRET, null)?.takeIf { it.isNotBlank() } ?: BuildConfig.GOOGLE_CLIENT_SECRET
    fun configured(ctx: Context) = NativeAuth.available(ctx) || clientId(ctx).isNotBlank()
    fun native(ctx: Context) = prefs(ctx).getBoolean(KEY_NATIVE, false)
    fun builtIn() = BuildConfig.GOOGLE_CLIENT_ID.isNotBlank()

    fun setClient(ctx: Context, id: String, secret: String) {
        prefs(ctx).edit().putString(KEY_ID, id.trim()).putString(KEY_SECRET, secret.trim()).apply()
    }

    fun connected(ctx: Context) = native(ctx) || prefs(ctx).getString(KEY_REFRESH, null) != null

    /** 연결 방식이 바뀌어 다시 연결해야 하는가 (예전 Drive 전체 권한 연결을 끊은 뒤) */
    fun reconnectNeeded(ctx: Context) = prefs(ctx).getBoolean(KEY_RECONNECT, false)

    /**
     * 앱을 켤 때 한 번: 예전(Drive 전체 권한)으로 연결해 둔 것이면 끊고 다시 연결하게 한다.
     * 메모 폴더(휴대폰 안 사본)는 그대로라 메모는 계속 보인다 — 다시 연결해 새 폴더를 고르면 그리로 옮겨 맞춘다
     */
    fun upgradeScope(ctx: Context) {
        if (!connected(ctx) || prefs(ctx).getString(KEY_SCOPE, null) in setOf(SCOPE, FULL_SCOPE)) return
        signOut(ctx)
        prefs(ctx).edit().putBoolean(KEY_RECONNECT, true).apply()
    }

    /** 휴대폰 구글 계정으로 허용받은 뒤 (NativeAuth) — 계정 이메일을 돌려준다 */
    fun completeNative(ctx: Context, token: String): String {
        prefs(ctx).edit().putBoolean(KEY_NATIVE, true).remove(KEY_REFRESH).putString(KEY_SCOPE, SCOPE).remove(KEY_RECONNECT).apply()
        accessToken = token
        expiresAt = System.currentTimeMillis() + 45 * 60 * 1000
        val email = try {
            DriveApi(ctx).about()
        } catch (e: Exception) {
            ""
        }
        prefs(ctx).edit().putString(KEY_EMAIL, email).apply()
        return email
    }
    fun email(ctx: Context): String = prefs(ctx).getString(KEY_EMAIL, "") ?: ""

    /** 계정 이메일을 아직 모르면 Drive 에 물어 둔다 (로그인 직후 못 받았을 때) */
    fun ensureEmail(ctx: Context) {
        if (email(ctx).isNotEmpty() || !connected(ctx)) return
        try {
            val email = DriveApi(ctx).about()
            if (email.isNotEmpty()) prefs(ctx).edit().putString(KEY_EMAIL, email).apply()
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "구글 계정 이메일을 받지 못했어요", e)
        }
    }

    fun signOut(ctx: Context) {
        val refresh = prefs(ctx).getString(KEY_REFRESH, null)
        val token = accessToken
        val wasNative = native(ctx)
        prefs(ctx).edit().remove(KEY_REFRESH).remove(KEY_EMAIL).remove(KEY_NATIVE).apply()
        accessToken = null
        if (wasNative && token != null) Thread { NativeAuth.clear(ctx, token) }.start()
        expiresAt = 0
        // 구글 쪽 권한도 돌려준다 (실패해도 괜찮음)
        if (refresh != null) Thread {
            try {
                post("https://oauth2.googleapis.com/revoke", mapOf("token" to refresh))
            } catch (e: Exception) {
                // 무시
            }
        }.start()
    }

    private fun random(bytes: Int): String {
        val b = ByteArray(bytes)
        SecureRandom().nextBytes(b)
        return Base64.encodeToString(b, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    /**
     * 로그인. openBrowser 로 구글 로그인 화면을 열고, 사용자가 허용하면 돌아온 코드를 토큰으로 바꾼다.
     * 오래 걸리므로(사용자가 로그인하는 동안) 배경 스레드에서 부른다. 돌려주는 값: 구글 계정 이메일.
     */
    fun login(ctx: Context, openBrowser: (String) -> Unit): String {
        if (!configured(ctx)) throw AuthError("Google 로그인 설정(OAuth 클라이언트 ID)이 아직 없어요")
        pendingServer?.close()
        val server = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        pendingServer = server
        server.soTimeout = LOGIN_TIMEOUT
        val redirect = "http://127.0.0.1:${server.localPort}"
        val verifier = random(48)
        val challenge = Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)),
            Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
        )
        val state = random(16)
        val url = "$AUTH_URL?client_id=${enc(clientId(ctx))}&redirect_uri=${enc(redirect)}&response_type=code" +
            "&scope=${enc(SCOPE)}&code_challenge=$challenge&code_challenge_method=S256&state=$state" +
            "&access_type=offline&prompt=consent"
        openBrowser(url)

        var received: Map<String, String>? = null
        try {
            while (received == null) {
                server.accept().use { sock ->
                    val line = BufferedReader(InputStreamReader(sock.getInputStream())).readLine() ?: ""
                    val query = line.split(' ').getOrNull(1)?.substringAfter('?', "") ?: ""
                    val p = query.split('&').filter { '=' in it }.associate {
                        URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
                    }
                    val out = sock.getOutputStream()
                    if (p["state"] == null) {
                        // favicon 같은 다른 요청
                        out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                    } else {
                        val bytes = page(p["code"] != null && p["state"] == state).toByteArray(Charsets.UTF_8)
                        out.write("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        out.write(bytes)
                        received = p
                    }
                    out.flush()
                }
            }
        } catch (e: SocketTimeoutException) {
            throw AuthError("로그인을 기다리다 시간이 지났어요. 다시 시도해 주세요")
        } catch (e: java.net.SocketException) {
            throw AuthError("로그인을 취소했어요")
        } finally {
            server.close()
            if (pendingServer === server) pendingServer = null
        }
        val params = received!!
        if (params["state"] != state) throw AuthError("로그인 확인 값이 맞지 않아요. 다시 시도해 주세요")
        val code = params["code"] ?: throw AuthError(if (params["error"] == "access_denied") "로그인을 취소했어요" else "로그인하지 못했어요 (${params["error"]})")

        val token = post(
            TOKEN_URL,
            mapOf(
                "code" to code, "client_id" to clientId(ctx), "client_secret" to clientSecret(ctx),
                "redirect_uri" to redirect, "grant_type" to "authorization_code", "code_verifier" to verifier,
            ),
        )
        val refresh = token.optString("refresh_token").ifEmpty { throw AuthError("구글이 오래 쓸 수 있는 권한을 주지 않았어요. 다시 시도해 주세요") }
        accessToken = token.getString("access_token")
        expiresAt = System.currentTimeMillis() + token.optLong("expires_in", 3600) * 1000
        prefs(ctx).edit().putString(KEY_REFRESH, refresh).putBoolean(KEY_NATIVE, false).putString(KEY_SCOPE, SCOPE).remove(KEY_RECONNECT).apply()
        val email = try {
            DriveApi(ctx).about()
        } catch (e: Exception) {
            ""
        }
        prefs(ctx).edit().putString(KEY_EMAIL, email).apply()
        return email
    }

    /** 로그인 화면을 닫고 돌아왔을 때 기다리기 그만 */
    fun cancelLogin() {
        pendingServer?.close()
    }

    private fun page(ok: Boolean): String {
        val title = if (ok) "메모킹에 Google Drive를 연결했어요" else "연결하지 못했어요"
        val sub = if (ok) "아래 버튼을 눌러 메모킹으로 돌아가세요." else "메모킹으로 돌아가 다시 시도해 주세요."
        return """<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>메모킹</title><style>body{font-family:system-ui,sans-serif;background:#f6f5f1;color:#111;display:grid;place-items:center;min-height:90vh;margin:0;text-align:center;padding:24px}
a{display:inline-block;margin-top:20px;padding:14px 28px;border-radius:14px;background:#ffcc00;color:#111;font-weight:700;text-decoration:none;font-size:17px}h1{font-size:22px}</style></head>
<body><div><h1>$title</h1><p>$sub</p><a href="intent://auth#Intent;scheme=memoking;package=com.memoking.app;end">메모킹으로 돌아가기</a></div></body></html>"""
    }

    /** 지금 쓸 수 있는 접근 토큰 (만료됐으면 새로 받음) */
    @Synchronized
    fun token(ctx: Context): String {
        accessToken?.let { if (System.currentTimeMillis() < expiresAt - 60_000) return it }
        if (native(ctx)) {
            accessToken = NativeAuth.token(ctx)
            expiresAt = System.currentTimeMillis() + 45 * 60 * 1000
            return accessToken!!
        }
        val refresh = prefs(ctx).getString(KEY_REFRESH, null) ?: throw AuthError("Google Drive에 로그인해 주세요")
        val token = try {
            post(TOKEN_URL, mapOf("refresh_token" to refresh, "client_id" to clientId(ctx), "client_secret" to clientSecret(ctx), "grant_type" to "refresh_token"))
        } catch (e: AuthError) {
            // 권한을 거둬 갔거나 오래돼서 끊김 → 다시 로그인
            prefs(ctx).edit().remove(KEY_REFRESH).apply()
            throw AuthError("Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요")
        }
        accessToken = token.getString("access_token")
        expiresAt = System.currentTimeMillis() + token.optLong("expires_in", 3600) * 1000
        return accessToken!!
    }

    fun invalidate(ctx: Context) {
        val token = accessToken
        accessToken = null
        if (token != null && native(ctx)) NativeAuth.clear(ctx, token)
    }

    private fun post(url: String, form: Map<String, String>): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded")
        conn.outputStream.use { it.write(form.entries.joinToString("&") { (k, v) -> "${enc(k)}=${enc(v)}" }.toByteArray()) }
        val code = conn.responseCode
        val text = (if (code in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        conn.disconnect()
        if (code in 400..499) {
            val err = try {
                JSONObject(text).optString("error_description").ifEmpty { JSONObject(text).optString("error") }
            } catch (e: Exception) {
                text
            }
            throw AuthError("Google 로그인 오류: $err")
        }
        if (code !in 200..299) throw IOException("Google 서버 오류 ($code)")
        return if (text.isBlank()) JSONObject() else JSONObject(text)
    }
}
