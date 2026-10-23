package com.memoking.app

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * 로컬 AI (휴대폰) — llama.cpp 의 llama-server 를 앱 안에서 띄워 이 휴대폰에서만 모델을 돌린다 (인터넷 없이).
 *   PC desktop/ai/ai-service.js 와 같은 일: 모델 파일(.gguf) 넣기 · 지우기, 쓸 때만 띄우고 5분 쉬면 끄기, 127.0.0.1 + 실행마다 새 키.
 *   묻는 말 · 답 풀기는 화면(android/web/js/local-ai.js → app/js/core/llama-client.js)이 PC 와 같은 코드로 한다. 여기는 길만.
 *   엔진은 APK 의 libllama-server.so (app/build.gradle.kts 의 llamaServer) — arm64 휴대폰만
 */
object LocalAi {
    val ROLES = mapOf("chat" to "글 모델", "embed" to "검색 모델")
    private const val IDLE_MS = 5 * 60_000L // 휴대폰 메모리를 돌려준다
    private const val START_MS = 3 * 60_000L // 느린 휴대폰에서 큰 모델을 올리는 시간

    private class Server(val proc: Process, val port: Int, val key: String) {
        val log = ArrayDeque<String>()
        var idle: ScheduledFuture<*>? = null
        @Volatile var stopping = false
    }

    private val servers = ConcurrentHashMap<String, Server>()
    private val errors = ConcurrentHashMap<String, String>()
    private val copying: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val jobs = ConcurrentHashMap<String, HttpURLConnection>()
    private val timer = Executors.newSingleThreadScheduledExecutor()

    /** 상태가 바뀌면 (화면에 알림) */
    @Volatile var listener: (() -> Unit)? = null

    private fun exe(ctx: Context) = File(ctx.applicationInfo.nativeLibraryDir, "libllama-server.so")
    private fun dir(ctx: Context) = File(ctx.filesDir, "ai").apply { mkdirs() }
    private fun model(ctx: Context, role: String) = File(dir(ctx), "$role.gguf")
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("local-ai", Context.MODE_PRIVATE)
    private fun changed() = listener?.invoke()

    fun status(ctx: Context): JSONObject {
        fun one(role: String): JSONObject {
            val f = model(ctx, role)
            val size = if (f.isFile) f.length() else 0L
            val state = when {
                role in copying -> "copying"
                size == 0L -> "missing"
                servers.containsKey(role) -> "running"
                else -> "ready"
            }
            return JSONObject().put("state", state).put("name", if (size > 0) prefs(ctx).getString(role, "") else "")
                .put("size", size).put("error", errors[role] ?: "")
        }
        return JSONObject().put("engine", exe(ctx).isFile).put("chat", one("chat")).put("embed", one("embed"))
    }

    /** 고른 파일(USB · 내려받은 파일 등)을 앱 안으로 복사 */
    fun import(ctx: Context, role: String, uri: Uri, name: String, total: Long, onProgress: (Double) -> Unit): JSONObject =
        bringIn(ctx, role, name, total, null, onProgress) { ctx.contentResolver.openInputStream(uri) ?: throw IOException("파일을 열지 못했어요") }

    /** 기본 모델 받기 (화면이 app/js/core/model-catalog.js 로 고른 주소 · 크기 · SHA-256) — 해시가 맞아야 넣는다 */
    fun download(ctx: Context, role: String, url: String, name: String, total: Long, sha256: String, onProgress: (Double) -> Unit): JSONObject {
        require(url.startsWith("https://huggingface.co/")) { "받을 수 없는 주소예요" }
        require(Regex("[0-9a-f]{64}").matches(sha256)) { "모델 확인값이 없어요" }
        return bringIn(ctx, role, name, total, sha256, onProgress) {
            val c = URL(url).openConnection() as HttpURLConnection // https → https 리디렉트(파일 저장소)는 저절로 따라간다
            c.connectTimeout = 20_000
            c.readTimeout = 60_000
            try {
                if (c.responseCode !in 200..299) throw IOException("받지 못했어요 (${c.responseCode}). 인터넷을 확인하고 다시 눌러 주세요")
            } catch (e: IOException) {
                throw IOException(if (e.message?.startsWith("받지 못했어요") == true) e.message else "인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 누르거나, 모델 파일을 직접 넣어 주세요")
            }
            c.inputStream
        }
    }

    // 모델을 .part 로 채운 뒤 다 됐을 때만 바꿔 넣는다 — 몇 GB 라 도중에 끊겨도 쓰던 모델이 깨지지 않게 (PC ai-service.js bringIn 과 같음)
    private fun bringIn(ctx: Context, role: String, name: String, total: Long, sha256: String?, onProgress: (Double) -> Unit, open: () -> java.io.InputStream): JSONObject {
        require(role in ROLES) { "모르는 모델이에요" }
        check(copying.add(role)) { "이미 넣는 중이에요" }
        errors.remove(role)
        changed()
        val part = File(dir(ctx), "$role.gguf.part")
        try {
            val digest = java.security.MessageDigest.getInstance("SHA-256")
            open().use { i ->
                part.outputStream().use { o ->
                    val buf = ByteArray(1 shl 20)
                    var done = 0L
                    var shown = 0.0
                    while (true) {
                        val n = i.read(buf)
                        if (n < 0) break
                        digest.update(buf, 0, n)
                        o.write(buf, 0, n)
                        done += n
                        val p = if (total > 0) done.toDouble() / total else 0.0
                        if (p - shown >= 0.01) onProgress(p.also { shown = it })
                    }
                }
            }
            val head = ByteArray(4).also { h -> part.inputStream().use { it.read(h) } }
            require(String(head, Charsets.ISO_8859_1) == "GGUF") { "모델 파일(.gguf)이 아니에요" }
            if (sha256 != null) check(digest.digest().joinToString("") { "%02x".format(it) } == sha256) { "받은 파일이 맞지 않아요. 다시 받아 주세요" }
            stop(role)
            check(part.renameTo(model(ctx, role))) { "모델 파일을 바꿔 넣지 못했어요" }
            prefs(ctx).edit().putString(role, name).apply()
        } catch (e: Exception) {
            part.delete()
            errors[role] = when {
                e.message?.contains("ENOSPC") == true -> "저장 공간이 모자라요"
                sha256 != null && e is IOException && e.message?.let { it.startsWith("받지 못했어요") || it.startsWith("인터넷에") } != true -> "받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요"
                else -> e.message ?: "넣지 못했어요"
            }
            throw IllegalStateException(errors[role])
        } finally {
            copying.remove(role)
            changed()
        }
        return status(ctx)
    }

    fun remove(ctx: Context, role: String): JSONObject {
        stop(role)
        model(ctx, role).delete()
        prefs(ctx).edit().remove(role).apply()
        errors.remove(role)
        changed()
        return status(ctx)
    }

    // ---------- llama-server ----------

    @Synchronized
    private fun server(ctx: Context, role: String): Server {
        servers[role]?.let { if (it.proc.isAlive) return it }
        check(exe(ctx).isFile) { "이 휴대폰에서는 AI 를 쓸 수 없어요 (64비트 ARM 휴대폰만)" }
        check(model(ctx, role).isFile) { "${ROLES[role]} 파일을 먼저 넣어 주세요 (설정의 AI 도우미)" }
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val key = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) } // 다른 앱이 모델을 부르지 못하게
        val args = mutableListOf(
            exe(ctx).path, "-m", model(ctx, role).path, "--host", "127.0.0.1", "--port", "$port", "--api-key", key, "--no-webui", "-c", "4096", "-np", "1",
        )
        if (role == "embed") args += listOf("--embedding", "-b", "4096", "-ub", "4096") // 긴 메모 하나를 한 번에
        val pb = ProcessBuilder(args).redirectErrorStream(true)
        pb.environment()["LD_LIBRARY_PATH"] = ctx.applicationInfo.nativeLibraryDir // libllama · libggml-cpu-* 를 같은 폴더에서
        val s = Server(pb.start(), port, key)
        servers[role] = s
        changed()
        Thread {
            s.proc.inputStream.bufferedReader().forEachLine { line ->
                synchronized(s.log) {
                    s.log.addLast(line)
                    if (s.log.size > 20) s.log.removeFirst()
                }
            }
            val code = s.proc.waitFor()
            servers.remove(role, s)
            s.idle?.cancel(false)
            if (!s.stopping) {
                val log = synchronized(s.log) { s.log.joinToString("\n") }
                android.util.Log.w("MemoKing", "AI $role 꺼짐 $code\n$log")
                // PC app/js/core/llama-client.js engineError 와 같은 말로
                val arch = Regex("unknown model architecture: '([^']+)'").find(log)?.groupValues?.get(1)
                errors[role] = when {
                    arch != null -> "이 엔진이 모르는 모델 구조예요 ($arch). 같은 모델을 엔진이 아는 구조로 바꾼 GGUF 를 넣어 주세요"
                    Regex("out of memory|failed to allocate|bad_alloc", RegexOption.IGNORE_CASE).containsMatchIn(log) -> "메모리가 모자라요. 더 작은 모델을 넣거나 다른 앱을 닫아 주세요"
                    else -> "모델이 멈췄어요 ($code)"
                }
            }
            changed()
        }.start()
        val until = System.currentTimeMillis() + START_MS
        while (System.currentTimeMillis() < until) {
            if (!s.proc.isAlive) {
                Thread.sleep(100) // 위 스레드가 까닭을 적을 때까지
                throw IllegalStateException(errors[role] ?: "모델을 올리지 못했어요. 파일이 깨졌거나 이 엔진이 모르는 모델이에요")
            }
            val ok = try {
                (URL("http://127.0.0.1:$port/health").openConnection() as HttpURLConnection).run {
                    connectTimeout = 1000
                    readTimeout = 1000
                    try { responseCode == 200 } finally { disconnect() }
                }
            } catch (e: IOException) {
                false
            }
            if (ok) {
                errors.remove(role)
                return s
            }
            Thread.sleep(300)
        }
        stop(role)
        throw IllegalStateException("모델을 올리는 데 너무 오래 걸려요")
    }

    private fun stop(role: String) {
        val s = servers.remove(role) ?: return
        s.stopping = true
        s.idle?.cancel(false)
        s.proc.destroy()
        if (!s.proc.waitFor(3, TimeUnit.SECONDS)) s.proc.destroyForcibly()
        changed()
    }

    /**
     * 모델에 묻기 (route: /v1/chat/completions · /v1/embeddings, body: JSON 글) → 답 JSON 글.
     * onLine 을 주면 스트리밍 답을 줄마다 넘기고 null. job 으로 멈출 수 있다 (cancel)
     */
    fun request(ctx: Context, role: String, route: String, body: String, job: String?, onLine: ((String) -> Unit)?): String? {
        require(role in ROLES) { "모르는 모델이에요" }
        val s = server(ctx, role)
        s.idle?.cancel(false)
        val c = URL("http://127.0.0.1:${s.port}$route").openConnection() as HttpURLConnection
        if (job != null) jobs[job] = c
        try {
            c.requestMethod = "POST"
            c.doOutput = true
            c.connectTimeout = 10_000
            c.readTimeout = 5 * 60_000
            c.setRequestProperty("content-type", "application/json")
            c.setRequestProperty("authorization", "Bearer ${s.key}")
            c.outputStream.use { it.write(body.toByteArray()) }
            if (c.responseCode !in 200..299) throw IllegalStateException("AI 가 답하지 못했어요 (${c.responseCode})")
            c.inputStream.bufferedReader().use { r ->
                if (onLine == null) return r.readText()
                r.forEachLine(onLine)
            }
            return null
        } catch (e: IOException) {
            if (job != null && !jobs.containsKey(job)) throw IllegalStateException("멈췄어요")
            throw e
        } finally {
            if (job != null) jobs.remove(job)
            c.disconnect()
            s.idle = timer.schedule(Runnable { stop(role) }, IDLE_MS, TimeUnit.MILLISECONDS)
        }
    }

    fun cancel(job: String) {
        jobs.remove(job)?.disconnect()
    }

    /** AI 검색용 조각 · 벡터 (이 휴대폰에만 — 메모 폴더에는 넣지 않음) */
    fun cacheRead(ctx: Context): String? = File(dir(ctx), "vectors.json").takeIf { it.isFile }?.readText()
    fun cacheWrite(ctx: Context, text: String) = File(dir(ctx), "vectors.json").writeText(text)
}
