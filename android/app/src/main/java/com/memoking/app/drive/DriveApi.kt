package com.memoking.app.drive

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Google Drive REST API v3 — 동기화에 필요한 만큼만 */
class DriveApi(private val ctx: Context) : Remote {
    companion object {
        private const val API = "https://www.googleapis.com/drive/v3"
        private const val UPLOAD = "https://www.googleapis.com/upload/drive/v3"
        private const val FIELDS = "id,name,mimeType,md5Checksum,modifiedTime,size"
    }

    class HttpError(val code: Int, message: String) : IOException(message)

    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")

    private fun parseTime(s: String?): Long {
        if (s.isNullOrEmpty()) return 0
        return try {
            SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(s)?.time ?: 0
        } catch (e: Exception) {
            0
        }
    }

    private fun item(o: JSONObject) = Remote.Item(
        id = o.getString("id"),
        name = o.optString("name"),
        folder = o.optString("mimeType") == SyncEngine.FOLDER,
        md5 = o.optString("md5Checksum").ifEmpty { null },
        modified = parseTime(o.optString("modifiedTime")),
        size = o.optString("size").toLongOrNull() ?: 0,
    )

    /**
     * 요청 하나. 접근 토큰이 만료돼 401 이 오면 한 번 새 토큰으로 다시. 429·5xx 는 잠깐 쉬었다 다시 (최대 3번).
     * method 가 PATCH 면 POST + X-HTTP-Method-Override (HttpURLConnection 은 PATCH 를 모른다).
     */
    private fun <T> request(
        method: String,
        url: String,
        contentType: String? = null,
        body: ByteArray? = null,
        handle: (HttpURLConnection) -> T,
    ): T {
        var attempt = 0
        while (true) {
            val conn = URL(url).openConnection() as HttpURLConnection
            try {
                conn.connectTimeout = 15_000
                conn.readTimeout = 60_000
                if (method == "PATCH") {
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("X-HTTP-Method-Override", "PATCH")
                } else {
                    conn.requestMethod = method
                }
                conn.setRequestProperty("Authorization", "Bearer ${GoogleAuth.token(ctx)}")
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", contentType ?: "application/json; charset=UTF-8")
                    conn.setFixedLengthStreamingMode(body.size)
                    conn.outputStream.use { it.write(body) }
                }
                val code = conn.responseCode
                if (code in 200..299) return handle(conn)
                val err = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                if (code == 401 && attempt == 0) {
                    GoogleAuth.invalidate(ctx)
                } else if ((code == 429 || code >= 500 || (code == 403 && "rateLimit" in err)) && attempt < 3) {
                    Thread.sleep(1000L shl attempt)
                } else {
                    throw HttpError(code, describe(code, err))
                }
            } finally {
                conn.disconnect()
            }
            attempt++
        }
    }

    private fun describe(code: Int, err: String): String {
        val msg = try {
            JSONObject(err).optJSONObject("error")?.optString("message") ?: err
        } catch (e: Exception) {
            err
        }
        return when (code) {
            401 -> "Google Drive 로그인이 끊겼어요. 설정에서 다시 연결해 주세요"
            403 -> if ("has not been used" in msg || "disabled" in msg) "Google Cloud 프로젝트에서 Google Drive API를 켜 주세요" else "Google Drive가 허락하지 않았어요: $msg"
            404 -> "Google Drive에서 폴더나 파일을 찾지 못했어요"
            else -> "Google Drive 오류 ($code): $msg"
        }
    }

    private fun json(conn: HttpURLConnection) = JSONObject(conn.inputStream.use { it.readBytes().toString(Charsets.UTF_8) })

    private fun get(url: String) = request("GET", url, handle = ::json)

    /** 구글 계정 이메일 */
    fun about(): String = get("$API/about?fields=user").optJSONObject("user")?.optString("emailAddress") ?: ""

    private fun query(q: String, orderBy: String? = null): List<JSONObject> {
        val out = ArrayList<JSONObject>()
        var page: String? = null
        do {
            val url = "$API/files?q=${enc(q)}&fields=${enc("nextPageToken,files($FIELDS)")}&pageSize=1000&spaces=drive" +
                (orderBy?.let { "&orderBy=${enc(it)}" } ?: "") + (page?.let { "&pageToken=${enc(it)}" } ?: "")
            val res = get(url)
            val files = res.optJSONArray("files") ?: JSONArray()
            for (i in 0 until files.length()) out += files.getJSONObject(i)
            page = res.optString("nextPageToken").ifEmpty { null }
        } while (page != null)
        return out
    }

    override fun listChildren(folderId: String): List<Remote.Item> =
        query("'${folderId.replace("'", "\\'")}' in parents and trashed = false").map(::item)

    /** 폴더 고르기 화면용: parent("root" = 내 드라이브) 안의 폴더들 — 같은 이름이면 먼저 만든 것부터 (PC 와 같은 폴더를 고르게) */
    fun folders(parent: String): List<Remote.Item> =
        query("'${parent.replace("'", "\\'")}' in parents and mimeType = '${SyncEngine.FOLDER}' and trashed = false", "name,createdTime").map(::item)

    fun folderName(id: String): String = get("$API/files/${enc(id)}?fields=name").optString("name")

    override fun download(id: String, out: OutputStream) {
        request("GET", "$API/files/${enc(id)}?alt=media") { conn -> conn.inputStream.use { it.copyTo(out) } }
    }

    // 큰 파일도 메모리에 다 올리지 않게 "이어 올리기(resumable)" 방식: 주소를 받고 → 내용을 흘려 보낸다
    override fun upload(parentId: String, name: String, existingId: String?, size: Long, open: () -> InputStream): Remote.Item {
        val meta = if (existingId == null) JSONObject().put("name", name).put("parents", JSONArray().put(parentId)) else JSONObject()
        val start = if (existingId == null) "$UPLOAD/files?uploadType=resumable&fields=${enc(FIELDS)}"
        else "$UPLOAD/files/${enc(existingId)}?uploadType=resumable&fields=${enc(FIELDS)}"
        val location = request(if (existingId == null) "POST" else "PATCH", start, body = meta.toString().toByteArray()) { conn ->
            conn.getHeaderField("Location") ?: throw IOException("Google Drive가 올릴 주소를 주지 않았어요. 잠시 뒤 다시 해 주세요")
        }
        var attempt = 0
        while (true) {
            val conn = URL(location).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = "PUT"
                conn.doOutput = true
                conn.connectTimeout = 15_000
                conn.readTimeout = 120_000
                conn.setRequestProperty("Content-Type", "application/octet-stream")
                conn.setFixedLengthStreamingMode(size)
                open().use { input -> conn.outputStream.use { input.copyTo(it) } }
                val code = conn.responseCode
                if (code in 200..299) return item(json(conn))
                val err = conn.errorStream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
                if (code >= 500 && attempt < 2) {
                    Thread.sleep(1000L shl attempt)
                } else {
                    throw HttpError(code, describe(code, err))
                }
            } finally {
                conn.disconnect()
            }
            attempt++
        }
    }

    override fun createFolder(parentId: String, name: String): Remote.Item {
        val meta = JSONObject().put("name", name).put("mimeType", SyncEngine.FOLDER).put("parents", JSONArray().put(parentId))
        return request("POST", "$API/files?fields=${enc(FIELDS)}", body = meta.toString().toByteArray()) { item(json(it)) }
    }

    override fun trash(id: String) {
        request("PATCH", "$API/files/${enc(id)}?fields=id", body = JSONObject().put("trashed", true).toString().toByteArray()) { }
    }

    override fun changesSince(token: String?, knownIds: Set<String>): Pair<Boolean, String> {
        if (token == null) {
            return true to get("$API/changes/startPageToken").getString("startPageToken")
        }
        var page: String = token
        var changed = false
        while (true) {
            val res = get(
                "$API/changes?pageToken=${enc(page)}&pageSize=1000&spaces=drive&includeRemoved=true&restrictToMyDrive=true" +
                    "&fields=${enc("nextPageToken,newStartPageToken,changes(fileId,removed,file(parents,trashed))")}",
            )
            val changes = res.optJSONArray("changes") ?: JSONArray()
            for (i in 0 until changes.length()) {
                val c = changes.getJSONObject(i)
                val parents = c.optJSONObject("file")?.optJSONArray("parents")
                // 이 메모 폴더 안의 것(알고 있는 파일, 또는 알고 있는 폴더에 든 것)만 따진다
                if (c.optString("fileId") in knownIds) changed = true
                if (parents != null) for (j in 0 until parents.length()) if (parents.getString(j) in knownIds) changed = true
            }
            val next = res.optString("nextPageToken")
            if (next.isNotEmpty()) {
                page = next
                continue
            }
            return changed to res.optString("newStartPageToken").ifEmpty { page }
        }
    }
}
