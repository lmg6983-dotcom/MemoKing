package com.memoking.app

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/**
 * WebView 가 읽는 주소를 앱 안 파일로 이어 준다 (네트워크를 거치지 않음).
 *   https://appassets.androidplatform.net/app/...    공용 웹 코어 (assets/www/app)
 *   https://appassets.androidplatform.net/m/...      휴대폰 화면 (assets/www/m)
 *   https://appassets.androidplatform.net/vault/...  메모 폴더의 파일 (첨부·링크 미리보기 사진)
 *   https://appassets.androidplatform.net/poster/... 메모 폴더 동영상의 한 장면 (JPG)
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
                path.startsWith("/poster/") -> poster(Uri.decode(path.removePrefix("/poster/")))
                path.startsWith("/history/") -> historyIcon(Uri.decode(path.removePrefix("/history/")))
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

    // 소리·동영상은 앞뒤로 옮겨 가며 재생하므로 Range(일부분) 요청에 답한다 (건너뛰기는 RangeStream 이 — WebView 도 건너뛰므로)
    private fun vault(rel: String, requestHeaders: Map<String, String>): WebResourceResponse {
        val storage = Vaults.forScreen(context) ?: return notFound()
        val stat = storage.stat(rel) ?: return notFound()
        if (stat.dir) return notFound()
        val type = typeOf(rel)
        val size = stat.size
        val range = RangeStream.parse(requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value, size)
        val head = headers(type).apply { put("Accept-Ranges", "bytes") }
        if (range == null || size <= 0) {
            head["Content-Length"] = size.toString()
            return WebResourceResponse(type, null, 200, "OK", head, storage.openRead(rel))
        }
        if (range.first >= size || range.first > range.last) {
            head["Content-Range"] = "bytes */$size"
            return WebResourceResponse(type, null, 416, "Range Not Satisfiable", head, ByteArrayInputStream(ByteArray(0)))
        }
        head["Content-Range"] = "bytes ${range.first}-${range.last}/$size"
        head["Content-Length"] = (range.last - range.first + 1).toString()
        return WebResourceResponse(type, null, 206, "Partial Content", head, RangeStream(storage.openRead(rel), range.first, range.last))
    }

    // 동영상 한 장면 (목록 카드 · 메모 속 동영상의 첫 그림 — video-poster.js). 휴대폰의 동영상 재생기로 그린다:
    //   WebView 는 갤럭시 카메라의 HDR · HEVC 영상을 캔버스에 검은 화면으로 그린다.
    //   못 그리면 204 (그림 없음) — 화면이 WebView 로 다시 그려 본다
    private fun poster(rel: String): WebResourceResponse {
        val none = WebResourceResponse("image/jpeg", null, 204, "No Content", headers("image/jpeg"), ByteArrayInputStream(ByteArray(0)))
        val uri = Vaults.forScreen(context)?.shareUri(rel) ?: return none
        val retriever = MediaMetadataRetriever()
        val frame = (try {
            retriever.setDataSource(context, uri)
            val ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            retriever.getFrameAtTime(minOf(1_000L, ms / 3) * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC) // 1초쯤 (처음은 검은 화면이 많다)
        } catch (e: Exception) {
            null
        } finally {
            retriever.release()
        }) ?: return none
        val w = minOf(480, frame.width)
        val small = Bitmap.createScaledBitmap(frame, w, maxOf(1, frame.height * w / frame.width), true)
        val jpg = ByteArrayOutputStream().also { small.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
        return WebResourceResponse("image/jpeg", null, 200, "OK", headers("image/jpeg"), ByteArrayInputStream(jpg))
    }

    // 알림 보관함의 앱 아이콘
    private fun historyIcon(name: String): WebResourceResponse {
        val file = java.io.File(NotiStore.iconDir(context), java.io.File(name).name)
        if (!file.isFile) return notFound()
        return WebResourceResponse("image/png", null, 200, "OK", headers("image/png"), file.inputStream())
    }

    private fun notFound() = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers("text/plain"), ByteArrayInputStream(ByteArray(0)))
}
