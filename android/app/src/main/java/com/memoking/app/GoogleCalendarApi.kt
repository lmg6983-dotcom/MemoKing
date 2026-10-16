package com.memoking.app

import android.content.Context
import com.memoking.app.drive.GoogleAuth
import com.memoking.app.drive.NativeAuth
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Google 캘린더 상호 동기화 (휴대폰) — 동기화 판단은 화면 쪽 공용 엔진(app/js/core/gcal-sync.js)이 하고,
 * 여기서는 휴대폰 구글 계정의 캘린더 권한(메모킹이 만든 캘린더만: calendar.app.created)으로 요청만 대신 보낸다.
 * Drive 권한과 따로 받는다 (Play 서비스가 있는 휴대폰만 — 없으면 PC 메모킹이 맡는다).
 */
object GoogleCalendarApi {
    const val SCOPE = "https://www.googleapis.com/auth/calendar.app.created"
    private const val BASE = "https://www.googleapis.com/calendar/v3/"

    /** { method, url, body? } → { status, text } — Calendar API 주소만 */
    fun request(ctx: Context, a: JSONObject): JSONObject {
        if (!NativeAuth.available(ctx)) throw GoogleAuth.AuthError("이 휴대폰에서는 Google 캘린더 동기화를 쓸 수 없어요. PC 메모킹이 맞춰요")
        val url = a.getString("url")
        if (!url.startsWith(BASE)) throw IllegalArgumentException("Google 캘린더 주소가 아니에요")
        val method = a.optString("method", "GET").uppercase()
        val body = if (a.has("body") && !a.isNull("body")) a.get("body").toString() else null
        for (attempt in 0..1) {
            val token = NativeAuth.token(ctx, SCOPE)
            val conn = URL(url).openConnection() as HttpURLConnection
            try {
                // HttpURLConnection 은 PATCH 를 모른다 — Google API 의 방법 바꾸기 머리말로
                conn.requestMethod = if (method == "PATCH") "POST" else method
                if (method == "PATCH") conn.setRequestProperty("X-HTTP-Method-Override", "PATCH")
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("Authorization", "Bearer $token")
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = conn.responseCode
                if (status == 401 && attempt == 0) {
                    NativeAuth.clear(ctx, token) // 만료된 토큰 — 새로 받아 한 번 더
                    continue
                }
                val text = (if (status in 200..299) conn.inputStream else conn.errorStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                return JSONObject().put("status", status).put("text", text)
            } finally {
                conn.disconnect()
            }
        }
        return JSONObject().put("status", 401).put("text", "")
    }
}
