package com.memoking.app

import android.content.Context
import android.webkit.WebSettings
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit

/**
 * 인터넷에서 받아 오기 — 링크 미리보기(페이지 제목·사진)와 붙여넣은 인터넷 사진 저장에 쓴다.
 * 화면(웹)에서 바로 받으면 다른 사이트의 CORS 에 막히므로 앱이 대신 받는다.
 *
 * 인자: url, accept, limit(바이트), headOnly(</head> 까지만), save(임시 파일로)
 * 결과: { status, url(최종 주소), type, text | temp, size }
 */
object Http {
    private var userAgent: String? = null

    private fun agent(ctx: Context): String = userAgent ?: try {
        WebSettings.getDefaultUserAgent(ctx)
    } catch (e: Exception) {
        "Mozilla/5.0 (Linux; Android) MemoKing"
    }.also { userAgent = it }

    fun fetch(ctx: Context, args: JSONObject): JSONObject {
        var url = URL(args.getString("url"))
        val accept = args.optString("accept", "*/*")
        val limit = args.optLong("limit", 5L * 1024 * 1024)
        val headOnly = args.optBoolean("headOnly", false)
        val save = args.optBoolean("save", false)
        val timeout = args.optInt("timeout", 10_000)

        var conn: HttpURLConnection
        var hops = 0
        // 리디렉트를 직접 따라간다 (http ↔ https 를 넘나드는 경우까지)
        while (true) {
            if (url.protocol != "http" && url.protocol != "https") throw IOException("인터넷 주소가 아니에요")
            conn = url.openConnection() as HttpURLConnection
            conn.instanceFollowRedirects = false
            conn.connectTimeout = timeout
            conn.readTimeout = timeout
            conn.setRequestProperty("User-Agent", agent(ctx))
            conn.setRequestProperty("Accept", accept)
            conn.setRequestProperty("Accept-Language", "ko-KR,ko;q=0.9,en;q=0.8")
            val code = conn.responseCode
            if (code in 300..399 && hops < 6) {
                val location = conn.getHeaderField("Location") ?: break
                conn.disconnect()
                url = URL(url, location)
                hops++
                continue
            }
            break
        }
        try {
            val status = conn.responseCode
            val type = (conn.contentType ?: "").lowercase()
            val result = JSONObject().put("status", status).put("url", url.toString()).put("type", type)
            if (status !in 200..299) return result
            val declared = conn.contentLengthLong
            if (declared > limit && !headOnly) throw IOException("너무 큰 파일이에요. 더 작은 파일로 해 주세요")
            val input = conn.inputStream
            if (save) {
                val (id, file) = Temp.create(ctx)
                var total = 0L
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > limit) {
                            out.close()
                            file.delete()
                            throw IOException("너무 큰 파일이에요. 더 작은 파일로 해 주세요")
                        }
                        out.write(buf, 0, n)
                    }
                }
                return result.put("temp", id).put("size", total)
            }
            val out = ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > limit) {
                    if (!headOnly) throw IOException("너무 큰 파일이에요. 더 작은 파일로 해 주세요")
                    break
                }
                // 미리보기 정보는 <head> 안에 있으므로 </head> 를 보면 그만 받는다
                if (headOnly && out.size() > 2048 && String(buf, 0, n, Charsets.ISO_8859_1).contains("</head>", true)) break
            }
            val bytes = out.toByteArray()
            // 글자 인코딩은 화면 쪽(detectCharset)이 정하도록 latin1 그대로 넘긴다
            return result.put("latin1", String(bytes, Charsets.ISO_8859_1)).put("size", bytes.size)
        } finally {
            conn.disconnect()
        }
    }

    private val davClient by lazy {
        OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()
    }

    /**
     * CalDAV 요청 (네이버 캘린더 읽기, app/js/core/caldav.js 가 씀) — 인자: url, method, headers, body, limit
     * 결과: { status, location, text }. 리디렉트는 따라가지 않는다 (같은 서버인지 화면 쪽이 보고 다시 부른다 — 비밀번호가 다른 곳으로 가지 않게)
     */
    fun dav(args: JSONObject): JSONObject {
        val url = URL(args.getString("url"))
        if (url.protocol != "https") throw IOException("https 주소만 돼요")
        val limit = args.optLong("limit", 5L * 1024 * 1024)
        val headers = args.optJSONObject("headers") ?: JSONObject()
        val req = Request.Builder().url(url).method(args.getString("method"), args.optString("body").toRequestBody())
        for (k in headers.keys()) req.header(k, headers.getString(k))
        davClient.newCall(req.build()).execute().use { res ->
            val body = res.body ?: return JSONObject().put("status", res.code).put("location", res.header("Location") ?: "").put("text", "")
            if (body.contentLength() > limit) throw IOException("캘린더가 너무 커요 (5MB 넘음)")
            val source = body.source()
            if (source.request(limit + 1)) throw IOException("캘린더가 너무 커요 (5MB 넘음)")
            return JSONObject().put("status", res.code).put("location", res.header("Location") ?: "").put("text", source.buffer.readUtf8())
        }
    }
}
