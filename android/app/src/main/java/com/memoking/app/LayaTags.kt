package com.memoking.app

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.nio.LongBuffer
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/**
 * AI 태그 (휴대폰) — Laya 다국어 모델을 이 휴대폰 안에서 onnxruntime 으로 (인터넷 없이).
 *   PC desktop/ai/laya-service.js 와 같은 일: 모델 받기(파일마다 SHA-256) · 지우기, 쓸 때만 올리고 5분 쉬면 내리기.
 *   글 나누기 · 질문 붙이기 · 답 풀기는 화면(android/web/js/local-ai.js → app/js/core/laya-*.js)이 PC 와 같은 코드로 하고,
 *   여기는 encoder · head 계산만 (run). tokenizer.json 은 WebServer 의 /ai/ 로 화면이 읽는다
 */
object LayaTags {
    private const val IDLE_MS = 5 * 60_000L
    val FILES = listOf("encoder.onnx", "head.onnx", "tokenizer.json", "rl_agent_config.json")

    private class Loaded(val encoder: OrtSession, val head: OrtSession)

    @Volatile private var loaded: Loaded? = null
    @Volatile private var progress: Double? = null
    @Volatile private var error = ""
    private var idle: ScheduledFuture<*>? = null
    private val timer = Executors.newSingleThreadScheduledExecutor()

    /** 상태가 바뀌면 (화면에 알림) */
    @Volatile var listener: (() -> Unit)? = null
    private fun changed() = listener?.invoke()

    fun dir(ctx: Context) = File(ctx.filesDir, "ai/laya").apply { mkdirs() }
    private fun have(ctx: Context) = FILES.all { File(dir(ctx), it).isFile }

    fun status(ctx: Context): JSONObject {
        val size = if (have(ctx)) FILES.sumOf { File(dir(ctx), it).length() } else 0L
        val state = when {
            progress != null -> "downloading"
            size == 0L -> "missing"
            loaded != null -> "running"
            else -> "ready"
        }
        return JSONObject().put("state", state).put("size", size).put("progress", progress ?: JSONObject.NULL).put("error", error)
    }

    /** 모델 받기 — files: [{ name, size, sha256 }] (화면이 app/js/core/model-catalog.js 에서), 파일마다 .part 로 받고 SHA-256 이 맞아야 넣는다 */
    fun download(ctx: Context, base: String, files: JSONArray): JSONObject {
        require(base.startsWith("https://github.com/")) { "받을 수 없는 주소예요" }
        check(progress == null) { "이미 받는 중이에요" }
        progress = 0.0
        error = ""
        changed()
        val list = List(files.length()) { files.getJSONObject(it) }
        require(list.all { it.getString("name") in FILES && Regex("[0-9a-f]{64}").matches(it.getString("sha256")) }) { "모델 정보가 맞지 않아요" }
        val total = list.sumOf { it.getLong("size") }.coerceAtLeast(1)
        var done = 0L
        try {
            for (f in list) {
                val name = f.getString("name")
                val target = File(dir(ctx), name)
                if (target.isFile && target.length() == f.getLong("size")) { // 끊겼다 다시 받을 때 다 받은 파일은 건너뛴다
                    done += target.length()
                    continue
                }
                val part = File(dir(ctx), "$name.part")
                val digest = MessageDigest.getInstance("SHA-256")
                val c = URL(base + name).openConnection() as HttpURLConnection // GitHub → 파일 저장소 리디렉트는 저절로 따라간다
                c.connectTimeout = 20_000
                c.readTimeout = 60_000
                try {
                    val code = try { c.responseCode } catch (e: IOException) { throw IOException("인터넷에 연결하지 못했어요. 인터넷이 될 때 다시 눌러 주세요") }
                    if (code !in 200..299) throw IOException("받지 못했어요 ($code). 인터넷을 확인하고 다시 눌러 주세요")
                    try {
                        c.inputStream.use { i ->
                            part.outputStream().use { o ->
                                val buf = ByteArray(1 shl 20)
                                var shown = progress ?: 0.0
                                while (true) {
                                    val n = i.read(buf)
                                    if (n < 0) break
                                    digest.update(buf, 0, n)
                                    o.write(buf, 0, n)
                                    done += n
                                    if (done.toDouble() / total - shown >= 0.01) {
                                        shown = done.toDouble() / total
                                        progress = shown
                                        changed()
                                    }
                                }
                            }
                        }
                    } catch (e: IOException) {
                        throw IOException(if (e.message?.contains("ENOSPC") == true) "저장 공간이 모자라요" else "받다가 끊겼어요. 인터넷을 확인하고 다시 눌러 주세요")
                    }
                } finally {
                    c.disconnect()
                }
                if (digest.digest().joinToString("") { "%02x".format(it) } != f.getString("sha256")) {
                    part.delete()
                    throw IOException("받은 파일이 맞지 않아요. 다시 받아 주세요")
                }
                check(part.renameTo(target)) { "모델 파일을 넣지 못했어요" }
            }
        } catch (e: Exception) {
            error = e.message ?: "받지 못했어요"
        } finally {
            progress = null
            changed()
        }
        return status(ctx)
    }

    fun remove(ctx: Context): JSONObject {
        unload()
        dir(ctx).listFiles()?.forEach { it.delete() }
        error = ""
        changed()
        return status(ctx)
    }

    @Synchronized
    private fun sessions(ctx: Context): Loaded {
        loaded?.let { return it }
        check(have(ctx)) { "AI 태그 모델을 먼저 받아 주세요 (설정의 AI 태그)" }
        val env = OrtEnvironment.getEnvironment()
        val opts = OrtSession.SessionOptions().apply { setIntraOpNumThreads(4) } // 큰 코어 넷 (작은 코어까지 쓰면 오히려 느리다)
        val l = try {
            Loaded(env.createSession(File(dir(ctx), "encoder.onnx").path, opts), env.createSession(File(dir(ctx), "head.onnx").path, opts))
        } catch (e: Throwable) {
            error = "AI 태그 모델을 올리지 못했어요. 지우고 다시 받아 주세요"
            changed()
            throw IllegalStateException(error)
        }
        loaded = l
        changed()
        return l
    }

    @Synchronized
    private fun unload() {
        idle?.cancel(false)
        val l = loaded ?: return
        loaded = null
        l.encoder.close()
        l.head.close()
        changed()
    }

    private fun longs(env: OrtEnvironment, rows: JSONArray, cols: Int): OnnxTensor {
        val buf = LongBuffer.allocate(rows.length() * cols)
        for (i in 0 until rows.length()) {
            val r = rows.getJSONArray(i)
            for (j in 0 until cols) buf.put(if (j < r.length()) r.optLong(j) else 0L)
        }
        buf.rewind()
        return OnnxTensor.createTensor(env, buf, longArrayOf(rows.length().toLong(), cols.toLong()))
    }

    private fun widest(rows: JSONArray, min: Int) = (0 until rows.length()).maxOfOrNull { rows.getJSONArray(it).length() }?.coerceAtLeast(min) ?: min

    /**
     * laya-ts 의 Batch(JSON: inputIds · attentionMask · markerPos · markerMask · qtype) → { logits, act } (core/laya-agent.js ortProvider 와 같은 계산)
     */
    fun run(ctx: Context, batch: String): JSONObject {
        val s = sessions(ctx)
        synchronized(this) { idle?.cancel(false) }
        try {
            val b = JSONObject(batch)
            val env = OrtEnvironment.getEnvironment()
            val ids = b.getJSONArray("inputIds")
            val mask = b.getJSONArray("attentionMask")
            val len = widest(ids, 1)
            val hidden = longs(env, ids, len).use { i -> longs(env, mask, len).use { m -> s.encoder.run(mapOf("input_ids" to i, "attention_mask" to m)) } }
            hidden.use { h ->
                val markers = b.getJSONArray("markerPos")
                val k = widest(markers, 2) // 보기가 하나여도 둘 칸 (laya onnx_agent 와 같게)
                val flags = b.getJSONArray("markerMask")
                val bools = Array(flags.length()) { i -> BooleanArray(k) { j -> flags.getJSONArray(i).optBoolean(j) } }
                val qtype = JSONArray().apply { val q = b.getJSONArray("qtype"); for (i in 0 until q.length()) put(JSONArray().put(q.getLong(i))) }
                val feeds = mapOf(
                    "hidden_states" to h.get(0) as OnnxTensor,
                    "marker_pos" to longs(env, markers, k),
                    "marker_mask" to OnnxTensor.createTensor(env, bools),
                    "qtype" to longs(env, qtype, 1),
                    "attention_mask" to longs(env, mask, len),
                )
                try {
                    s.head.run(feeds).use { out ->
                        fun rows(name: String): JSONArray {
                            @Suppress("UNCHECKED_CAST")
                            val v = (out.get(name).orElse(null) ?: out.get(1)).value as Array<FloatArray>
                            return JSONArray().apply { v.forEach { r -> put(JSONArray().apply { r.forEach { put(it.toDouble()) } }) } }
                        }
                        return JSONObject().put("logits", rows("logits")).put("act", rows("act_logits"))
                    }
                } finally {
                    feeds.filterKeys { it != "hidden_states" }.values.forEach { it.close() }
                }
            }
        } finally {
            synchronized(this) { idle = timer.schedule(Runnable { unload() }, IDLE_MS, TimeUnit.MILLISECONDS) }
        }
    }
}
