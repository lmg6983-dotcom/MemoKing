package com.memoking.app

import android.content.Context
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.ResponseFormat
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.CancellationException

/**
 * 글 모델이 .litertlm 일 때 — 구글 LiteRT-LM 으로 휴대폰 GPU 에서 (llama.cpp 의 CPU 보다 훨씬 빠르다).
 *   llama-server 와 같은 모양(OpenAI /v1/chat/completions)으로 받고 돌려줘서, 화면 코드(app/js/core/llama-client.js)는 그대로.
 */
class LiteRtChat(ctx: Context, model: File) {
    private val engine: Engine
    private val jobs = ConcurrentHashMap<String, Conversation>()

    init {
        // GPU 를 못 쓰는 휴대폰은 CPU 로. cacheDir: 두 번째부터 빨리 올라오게
        fun open(backend: Backend) = Engine(EngineConfig(model.path, backend, maxNumTokens = 4096, cacheDir = ctx.cacheDir.path)).apply { initialize() }
        engine = try {
            open(Backend.GPU())
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "LiteRT GPU 안 됨, CPU 로", e)
            open(Backend.CPU())
        }
    }

    /** body: /v1/chat/completions 의 JSON → 답 JSON (onLine 이 있으면 "data: …" 줄마다 넘기고 null) */
    @Synchronized // 한 번에 하나 (llama-server 의 -np 1 처럼)
    fun request(body: String, job: String?, onLine: ((String) -> Unit)?): String? {
        val b = JSONObject(body)
        val messages = b.getJSONArray("messages").let { a -> List(a.length()) { a.getJSONObject(it) } }
        val system = messages.filter { it.getString("role") == "system" }.joinToString("\n\n") { it.getString("content") }
        val talk = messages.filter { it.getString("role") != "system" }
        val temperature = b.optDouble("temperature", 0.3)
        val schema = b.optJSONObject("response_format")?.optJSONObject("json_schema")?.optJSONObject("schema")
        val config = ConversationConfig(
            systemInstruction = system.takeIf { it.isNotEmpty() }?.let { Contents.of(it) },
            initialMessages = talk.dropLast(1).map { if (it.getString("role") == "assistant") Message.model(it.getString("content")) else Message.user(it.getString("content")) },
            samplerConfig = SamplerConfig(topK = if (temperature == 0.0) 1 else 64, topP = 0.95, temperature = temperature),
            maxOutputToken = b.optInt("max_tokens", 512),
            thinkingConfig = ThinkingConfig(enableThinking = false),
            enableResponseFormat = schema != null,
        )
        engine.createConversation(config).use { c ->
            if (job != null) jobs[job] = c
            try {
                val text = StringBuilder()
                var failed: Throwable? = null
                val done = CountDownLatch(1)
                c.sendMessageAsync(Message.user(talk.last().getString("content")), object : MessageCallback {
                    override fun onMessage(message: Message) {
                        val piece = message.toString()
                        text.append(piece)
                        onLine?.invoke("data: " + JSONObject().put("choices", JSONArray().put(JSONObject().put("delta", JSONObject().put("content", piece)))))
                    }
                    override fun onDone() = done.countDown()
                    override fun onError(throwable: Throwable) {
                        failed = throwable
                        done.countDown()
                    }
                }, responseFormat = schema?.let { ResponseFormat.json(it.toString()) })
                if (!done.await(5, TimeUnit.MINUTES)) {
                    c.cancelProcess()
                    throw IllegalStateException("AI 가 너무 오래 걸려요")
                }
                failed?.let { throw if (it is CancellationException) IllegalStateException("멈췄어요") else it }
                if (onLine != null) return null
                return JSONObject().put("choices", JSONArray().put(JSONObject().put("message", JSONObject().put("content", text.toString())))).toString()
            } finally {
                if (job != null) jobs.remove(job)
            }
        }
    }

    fun cancel(job: String): Boolean = jobs.remove(job)?.let { runCatching { it.cancelProcess() }; true } ?: false

    /** 묻는 중이면 멈추고, 그 물음이 끝난 뒤 닫는다 (request 와 같은 잠금) */
    fun close() {
        jobs.values.forEach { runCatching { it.cancelProcess() } }
        synchronized(this) { engine.close() }
    }

    companion object {
        /** .litertlm 파일의 첫 8바이트 */
        const val MAGIC = "LITERTLM"
    }
}
