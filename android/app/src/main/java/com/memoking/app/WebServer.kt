package com.memoking.app

import android.content.Context
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.FilterInputStream
import java.io.InputStream

/**
 * WebView 가 읽는 주소를 앱 안 파일로 이어 준다 (네트워크를 거치지 않음).
 *   https://appassets.androidplatform.net/app/...    공용 웹 코어 (assets/www/app)
 *   https://appassets.androidplatform.net/m/...      휴대폰 화면 (assets/www/m)
 *   https://appassets.androidplatform.net/vault/...  메모 폴더의 파일 (첨부·링크 미리보기 사진)
 * appassets.androidplatform.net 은 이런 용도로 비워 둔 주소라 실제 인터넷과 겹치지 않는다.
 */
class WebServer(private val context: Context) {
    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        const val START = "$ORIGIN/m/index.html"

        private val TYPES = mapOf(
            "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css",
            "json" to "application/json", "svg" to "image/svg+xml", "png" to "image/png", "jpg" to "image/jpeg",
            "jpeg" to "image/jpeg", "gif" to "image/gif", "webp" to "image/webp", "bmp" to "image/bmp", "avif" to "image/avif",
            "ico" to "image/x-icon", "woff2" to "font/woff2", "woff" to "font/woff", "ttf" to "font/ttf",
            "mp3" to "audio/mpeg", "m4a" to "audio/mp4", "aac" to "audio/aac", "wav" to "audio/wav", "ogg" to "audio/ogg",
            "oga" to "audio/ogg", "opus" to "audio/ogg", "weba" to "audio/webm", "flac" to "audio/flac",
            "mp4" to "video/mp4", "m4v" to "video/mp4", "mov" to "video/quicktime", "webm" to "video/webm",
            "ogv" to "video/ogg", "mkv" to "video/x-matroska", "pdf" to "application/pdf", "txt" to "text/plain",
            "md" to "text/markdown",
        )

        fun typeOf(path: String): String = TYPES[path.substringAfterLast('.', "").lowercase()] ?: "application/octet-stream"
    }

    fun handle(request: WebResourceRequest): WebResourceResponse? {
        val url = request.url
        if (url.host != HOST) return null
        val path = url.path ?: return null
        return try {
            when {
                path.startsWith("/app/") || path.startsWith("/m/") -> asset("www$path")
                path.startsWith("/vault/") -> vault(Uri.decode(path.removePrefix("/vault/")), request.requestHeaders)
                else -> notFound()
            }
        } catch (e: Exception) {
            notFound()
        }
    }

    private fun headers(type: String) = mutableMapOf(
        "Cache-Control" to "no-cache",
        "Access-Control-Allow-Origin" to ORIGIN,
        "Content-Type" to type,
    )

    private fun asset(name: String): WebResourceResponse {
        val type = typeOf(name)
        val stream = context.assets.open(name)
        return WebResourceResponse(type, if (type.startsWith("text/") || type.endsWith("json")) "utf-8" else null, 200, "OK", headers(type), stream)
    }

    // 소리·동영상은 앞뒤로 옮겨 가며 재생하므로 Range(일부분) 요청에 답한다
    private fun vault(rel: String, requestHeaders: Map<String, String>): WebResourceResponse {
        val storage = Vaults.current(context) ?: return notFound()
        val stat = storage.stat(rel) ?: return notFound()
        if (stat.dir) return notFound()
        val type = typeOf(rel)
        val size = stat.size
        val range = requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value
        val match = range?.let { Regex("""bytes=(\d*)-(\d*)""").find(it) }
        val head = headers(type).apply { put("Accept-Ranges", "bytes") }
        if (match == null || size <= 0) {
            head["Content-Length"] = size.toString()
            return WebResourceResponse(type, null, 200, "OK", head, storage.openRead(rel))
        }
        val (a, b) = match.destructured
        val start = if (a.isEmpty()) maxOf(0, size - (b.toLongOrNull() ?: 0)) else a.toLong()
        val end = if (a.isEmpty() || b.isEmpty()) size - 1 else minOf(b.toLong(), size - 1)
        if (start >= size || start > end) {
            head["Content-Range"] = "bytes */$size"
            return WebResourceResponse(type, null, 416, "Range Not Satisfiable", head, ByteArrayInputStream(ByteArray(0)))
        }
        val stream = storage.openRead(rel)
        var skipped = 0L
        while (skipped < start) {
            val n = stream.skip(start - skipped)
            if (n <= 0) break
            skipped += n
        }
        head["Content-Range"] = "bytes $start-$end/$size"
        head["Content-Length"] = (end - start + 1).toString()
        return WebResourceResponse(type, null, 206, "Partial Content", head, Limited(stream, end - start + 1))
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers("text/plain"), ByteArrayInputStream(ByteArray(0)))

    /** 앞에서 n 바이트까지만 읽히는 스트림 */
    private class Limited(input: InputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int {
            if (left <= 0) return -1
            val b = super.read()
            if (b >= 0) left--
            return b
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }

        override fun available(): Int = minOf(super.available().toLong(), left).toInt()
    }
}
