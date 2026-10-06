package com.memoking.app

import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import org.json.JSONObject
import org.vosk.LibVosk
import org.vosk.LogLevel
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.SpeakerModel
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * 받아쓰기(STT) — 녹음하는 소리(16kHz 모노 PCM)를 그대로 받아 글로 옮긴다.
 *
 *  - "vosk"   : 오픈소스 Vosk (alphacep/vosk-api, Apache-2.0) + 한국어 모델(vosk-model-small-ko, 약 87MB, 처음 한 번 받음).
 *               인터넷 없이 휴대폰 안에서만 돌아서 회의 내용이 밖으로 나가지 않는다. 모든 안드로이드 버전.
 *  - "system" : 휴대폰의 음성 인식(보통 Google). 더 정확하지만 안드로이드 13 이상, 녹음한 소리를 직접 넘기는 방식.
 */
interface Transcriber {
    fun feed(pcm: ByteArray, len: Int)
    /** 남은 소리까지 마저 옮기고 끝낸다 → 마지막 조각 */
    fun finish(): String
    fun close()
}

/**
 * 받아쓴 글 조각: final = 한 문장이 끝남, partial = 말하는 중(바뀔 수 있음)
 * speaker = 말한 사람 번호(1, 2, …), 모르면 0 — Vosk 말한 사람 모델을 받았을 때만
 */
typealias SttListener = (final: String?, partial: String?, speaker: Int) -> Unit

object Stt {
    const val SAMPLE_RATE = 16000
    const val ENGINE_VOSK = "vosk"
    const val ENGINE_SYSTEM = "system"

    fun systemAvailable(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isRecognitionAvailable(ctx)

    /** 이 엔진으로 지금 받아쓸 수 있는가 — 안 되면 이유 */
    fun unavailableReason(ctx: Context, engine: String): String? = when (engine) {
        ENGINE_SYSTEM -> if (systemAvailable(ctx)) null else "이 휴대폰은 '정확도 우선' 받아쓰기를 지원하지 않아요 (Android 13 이상)"
        else -> if (VoskModels.ready(ctx)) null else "받아쓰기 데이터를 먼저 다운로드해 주세요 (설정 › 받아쓰기 데이터)"
    }

    /**
     * @param terms 이 메모 폴더에서 자주 쓰는 낱말(태그·제목 등) — 휴대폰 음성 인식에 "이런 말이 나올 수 있어요" 힌트로
     * 받아쓰기 엔진에 넘기기 전에 소리를 다듬는다 (SpeechConditioner: 낮은 웅웅 소리 빼기 · 작은 목소리 키우기)
     */
    fun create(ctx: Context, engine: String, listener: SttListener, terms: List<String> = emptyList()): Transcriber {
        val inner = if (engine == ENGINE_SYSTEM && Build.VERSION.SDK_INT >= 33) SystemTranscriber(ctx, listener, terms)
        else VoskTranscriber(VoskModels.load(ctx), if (SpeakerModels.on(ctx)) SpeakerModels.load(ctx) else null, listener)
        return Conditioned(inner)
    }

    /** 받아쓰기용으로만 다듬은 소리를 넘긴다 (녹음 파일은 원래 소리 그대로) */
    private class Conditioned(private val inner: Transcriber) : Transcriber {
        private val conditioner = SpeechConditioner(SAMPLE_RATE)
        override fun feed(pcm: ByteArray, len: Int) {
            val copy = pcm.copyOf(len)
            conditioner.process(copy, len)
            inner.feed(copy, len)
        }
        override fun finish() = inner.finish()
        override fun close() = inner.close()
    }

    fun status(ctx: Context): JSONObject = JSONObject()
        .put("model", if (VoskModels.ready(ctx)) "ready" else if (VoskModels.progress >= 0) "downloading" else "missing")
        .put("progress", VoskModels.progress)
        .put("modelSize", VoskModels.SIZE_LABEL)
        .put("system", systemAvailable(ctx))
        .put("speaker", if (SpeakerModels.ready(ctx)) "ready" else if (SpeakerModels.progress >= 0) "downloading" else "missing")
        .put("speakerOn", SpeakerModels.on(ctx))
        .put("speakerSize", SpeakerModels.SIZE_LABEL)
}

// ---------- Vosk (오픈소스, 인터넷 없이) ----------

class VoskTranscriber(model: Model, spk: SpeakerModel?, private val listener: SttListener) : Transcriber {
    private val rec = (if (spk != null) Recognizer(model, Stt.SAMPLE_RATE.toFloat(), spk) else Recognizer(model, Stt.SAMPLE_RATE.toFloat())).also {
        // 문장 끝을 조금 빨리 끊는다(0.6초 쉬면 한 문장) — 문장마다 줄을 바꾸고, 말한 사람이 바뀌는 자리를 놓치지 않게
        try {
            it.setEndpointerDelays(5.0f, 0.6f, 20.0f)
        } catch (e: Throwable) {
            // 옛 라이브러리
        }
    }
    private val speakers = SpeakerTracker()
    private var lastPartial = ""
    private var partialAt = 0L

    private fun emit(json: String) {
        val o = JSONObject(json)
        val text = o.optString("text").trim()
        lastPartial = ""
        if (text.isEmpty()) return
        val vec = o.optJSONArray("spk")?.let { a -> FloatArray(a.length()) { a.optDouble(it).toFloat() } }
        listener(text, "", speakers.assign(vec, o.optInt("spk_frames", 0)))
    }

    override fun feed(pcm: ByteArray, len: Int) {
        if (rec.acceptWaveForm(pcm, len)) {
            emit(rec.result)
        } else {
            val now = System.currentTimeMillis()
            if (now - partialAt < 300) return // 말하는 중 글은 0.3초마다만
            partialAt = now
            val partial = JSONObject(rec.partialResult).optString("partial").trim()
            if (partial != lastPartial) {
                lastPartial = partial
                listener(null, partial, 0)
            }
        }
    }

    override fun finish(): String {
        try {
            emit(rec.finalResult)
        } catch (e: Exception) {
            // 남은 소리 없음
        }
        return ""
    }

    override fun close() = rec.close()
}

/**
 * 말한 사람 나누기 (가볍게): Vosk 말한 사람 모델이 문장마다 주는 목소리 특징(x-vector, 128개 수)을
 * 지금까지의 사람별 평균과 견줘(코사인 유사도) 가장 닮은 사람으로, 아무와도 안 닮으면 새 사람으로.
 * 아주 짧은 말("네", "음")은 특징이 흔들리므로 바로 앞 사람으로 둔다.
 */
class SpeakerTracker(private val threshold: Float = 0.45f, private val maxSpeakers: Int = 6, private val minFrames: Int = 80) {
    private val centroids = ArrayList<FloatArray>()
    private val counts = ArrayList<Int>()
    private var last = 0

    /** @return 말한 사람 번호(1부터), 특징이 없으면 0 */
    fun assign(vec: FloatArray?, frames: Int): Int {
        if (vec == null || vec.isEmpty()) return 0
        if (frames in 1 until minFrames && last > 0) return last
        val v = unit(vec)
        var best = -1
        var bestSim = -2f
        for (i in centroids.indices) {
            val s = dot(v, centroids[i])
            if (s > bestSim) {
                bestSim = s
                best = i
            }
        }
        if (best < 0 || (bestSim < threshold && centroids.size < maxSpeakers)) {
            centroids.add(v)
            counts.add(1)
            last = centroids.size
            return last
        }
        // 사람별 평균을 조금씩 다듬기
        val n = counts[best]
        val c = centroids[best]
        for (i in c.indices) c[i] = (c[i] * n + v[i]) / (n + 1)
        centroids[best] = unit(c)
        counts[best] = minOf(n + 1, 50)
        last = best + 1
        return last
    }

    private fun unit(x: FloatArray): FloatArray {
        var s = 0.0
        for (f in x) s += f * f
        val n = kotlin.math.sqrt(s).toFloat().takeIf { it > 0f } ?: 1f
        return FloatArray(x.size) { x[it] / n }
    }

    private fun dot(a: FloatArray, b: FloatArray): Float {
        var s = 0f
        for (i in 0 until minOf(a.size, b.size)) s += a[i] * b[i]
        return s
    }
}

/** Vosk 모델 하나: 앱 안 저장 공간(files/stt/)에 한 번 받아 두고 쓴다 */
open class VoskPack(val name: String, val sizeLabel: String) {
    private val urlZip = "https://alphacephei.com/vosk/models/$name.zip"

    /** 받는 중이면 0~100, 아니면 -1 */
    @Volatile
    var progress = -1
        private set

    private fun root(ctx: Context) = File(ctx.filesDir, "stt")
    fun dir(ctx: Context) = File(root(ctx), name)
    fun ready(ctx: Context) = File(dir(ctx), ".ok").isFile

    /** 모델 받기 (zip 을 받아 풀기). 오래 걸리므로 백그라운드 스레드에서 */
    @Synchronized
    fun download(ctx: Context, onProgress: (Int) -> Unit) {
        if (ready(ctx)) return
        val root = root(ctx).apply { mkdirs() }
        val zip = File(root, "$name.zip.part")
        val unpack = File(root, "$name.part")
        progress = 0
        onProgress(0) // 누르자마자 "다운로드 중 0%" 가 보이게
        try {
            var conn = URL(urlZip).openConnection() as HttpURLConnection
            for (i in 0 until 5) { // https → 다른 주소로 넘겨주기(리다이렉트) 따라가기
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 30_000
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location") ?: break
                    conn.disconnect()
                    conn = URL(URL(urlZip), next).openConnection() as HttpURLConnection
                    continue
                }
                if (code != 200) throw IOException("다운로드하지 못했어요. 잠시 후 다시 시도해 주세요")
                break
            }
            val total = conn.contentLengthLong
            conn.inputStream.use { input ->
                zip.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val p = if (total > 0) (done * 90 / total).toInt() else 0
                        if (p != last) {
                            last = p
                            progress = p
                            onProgress(p)
                        }
                    }
                }
            }
            conn.disconnect()
            // 풀기: zip 안의 "<모델 이름>/..." → files/stt/<모델 이름>/...
            unpack.deleteRecursively()
            unpack.mkdirs()
            // 푸는 동안도 90~99% 로 (읽은 zip 크기 기준) — 설치 중에도 멈춘 것처럼 보이지 않게
            val zipSize = zip.length().coerceAtLeast(1)
            val counted = object : java.io.FilterInputStream(zip.inputStream()) {
                var read = 0L
                var last = 90
                private fun count(n: Int) {
                    if (n <= 0) return
                    read += n
                    val p = 90 + (read * 9 / zipSize).toInt().coerceAtMost(9)
                    if (p != last) {
                        last = p
                        progress = p
                        onProgress(p)
                    }
                }
                override fun read(): Int = super.read().also { if (it >= 0) count(1) }
                override fun read(b: ByteArray, off: Int, len: Int): Int = super.read(b, off, len).also { count(it) }
            }
            ZipInputStream(counted.buffered()).use { zin ->
                while (true) {
                    val e = zin.nextEntry ?: break
                    val rel = e.name.substringAfter('/', "")
                    if (rel.isEmpty()) continue
                    val target = File(unpack, rel).canonicalFile
                    if (!target.path.startsWith(unpack.canonicalPath + File.separator)) continue // zip 밖으로 나가는 경로
                    if (e.isDirectory) target.mkdirs()
                    else {
                        target.parentFile?.mkdirs()
                        target.outputStream().use { zin.copyTo(it) }
                    }
                }
            }
            File(unpack, ".ok").writeText(name)
            dir(ctx).deleteRecursively()
            if (!unpack.renameTo(dir(ctx))) throw IOException("설치하지 못했어요. 저장 공간을 확인해 주세요")
            progress = 100
            onProgress(100)
        } finally {
            zip.delete()
            unpack.deleteRecursively()
            progress = -1
        }
    }

    protected open fun unload() {}

    @Synchronized
    fun delete(ctx: Context) {
        unload()
        dir(ctx).deleteRecursively()
    }
}

/** Vosk 한국어 받아쓰기 모델 (약 87MB) */
object VoskModels : VoskPack("vosk-model-small-ko-0.22", "약 87MB") {
    const val SIZE_LABEL = "약 87MB"
    private var model: Model? = null

    @Synchronized
    fun load(ctx: Context): Model {
        model?.let { return it }
        if (!ready(ctx)) throw IllegalStateException("받아쓰기 데이터가 없어요")
        LibVosk.setLogLevel(LogLevel.WARNINGS)
        return Model(dir(ctx).absolutePath).also { model = it }
    }

    override fun unload() {
        model?.close()
        model = null
    }
}

/** Vosk 말한 사람 모델 (약 13MB, 모든 언어) — 받아 두고 켜면 받아쓴 글을 말한 사람별로 나눈다 */
object SpeakerModels : VoskPack("vosk-model-spk-0.4", "약 13MB") {
    const val SIZE_LABEL = "약 13MB"
    private var model: SpeakerModel? = null
    private const val PREFS = "memoking.stt"

    fun on(ctx: Context) = ready(ctx) && ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("speakers", true)
    fun setOn(ctx: Context, on: Boolean) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("speakers", on).apply()

    @Synchronized
    fun load(ctx: Context): SpeakerModel? {
        model?.let { return it }
        return try {
            SpeakerModel(dir(ctx).absolutePath).also { model = it }
        } catch (e: Throwable) {
            android.util.Log.w("MemoKing", "말한 사람 모델을 열지 못했어요", e)
            null
        }
    }

    override fun unload() {
        model?.close()
        model = null
    }
}

// ---------- 휴대폰 음성 인식 (안드로이드 13+, 녹음한 소리를 파이프로 넘긴다) ----------
//   - 자주 쓰는 낱말을 힌트로 (EXTRA_BIASING_STRINGS) — 사람 이름·회사·제품 이름 같은 말을 더 잘 알아듣게
//   - 문장부호·띄어쓰기 다듬기 (EXTRA_ENABLE_FORMATTING, 정확도 우선)
//   - 인식기가 오류로 멈추면(네트워크가 잠깐 끊김 등) 새 파이프로 다시 시작 — 긴 회의에서 받아쓰기가 끊기지 않게

class SystemTranscriber(private val ctx: Context, private val listener: SttListener, private val terms: List<String> = emptyList()) : Transcriber {
    private val main = Handler(Looper.getMainLooper())
    @Volatile
    private var out: java.io.OutputStream? = null
    private var readEnd: ParcelFileDescriptor? = null
    private var recognizer: SpeechRecognizer? = null
    private val ended = CountDownLatch(1)
    @Volatile
    private var finishing = false
    @Volatile
    private var dead = false
    private var restarts = 0

    init {
        main.post { begin() }
    }

    private fun begin() {
        if (Build.VERSION.SDK_INT < 33 || finishing) return
        val pipe = ParcelFileDescriptor.createPipe()
        readEnd = pipe[0]
        val sr = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = sr
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onSegmentResults(segmentResults: Bundle) {
                val text = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                if (text.isNotEmpty()) listener(text, "", 0)
            }
            override fun onPartialResults(partialResults: Bundle) {
                val text = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                listener(null, text, 0)
            }
            override fun onResults(results: Bundle) {
                onSegmentResults(results)
                if (finishing) ended.countDown() else restart()
            }
            override fun onEndOfSegmentedSession() {
                if (finishing) ended.countDown() else restart()
            }
            override fun onError(error: Int) {
                android.util.Log.w("MemoKing", "음성 인식 오류 $error")
                val fatal = error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE ||
                    error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS || error == SpeechRecognizer.ERROR_CLIENT
                if (finishing || fatal || restarts >= 30) {
                    dead = !finishing
                    ended.countDown()
                } else restart()
            }
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ko-KR")
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, pipe[0])
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
            .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, Stt.SAMPLE_RATE)
            .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
            .putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_QUALITY)
        if (terms.isNotEmpty()) intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, ArrayList(terms.take(100)))
        out = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
        sr.startListening(intent)
    }

    /** 멈춘 인식기를 버리고 새로 (그동안 들어오는 소리는 새 파이프로) */
    private fun restart() {
        restarts++
        val oldOut = out
        out = null
        try {
            oldOut?.close()
        } catch (e: IOException) {
            // 이미 닫힘
        }
        recognizer?.destroy()
        recognizer = null
        try {
            readEnd?.close()
        } catch (e: IOException) {
            // 무시
        }
        main.postDelayed({ begin() }, 300)
    }

    override fun feed(pcm: ByteArray, len: Int) {
        if (dead || finishing) return
        try {
            out?.write(pcm, 0, len)
        } catch (e: IOException) {
            // 인식기가 다시 시작하는 사이 — 그 조각은 버린다
        }
    }

    override fun finish(): String {
        finishing = true
        try {
            out?.close() // 소리가 끝났다고 알린다 → 남은 글을 보내고 끝남
        } catch (e: IOException) {
            // 이미 닫힘
        }
        ended.await(8, TimeUnit.SECONDS)
        return ""
    }

    override fun close() {
        finishing = true
        main.post {
            recognizer?.destroy()
            recognizer = null
            try {
                readEnd?.close()
            } catch (e: IOException) {
                // 무시
            }
        }
    }
}

/**
 * 받아쓰기 전에 소리를 가볍게 다듬는다 (연산 몇 개, 지연 없음)
 *   1) 고역 통과(약 100Hz 아래 빼기): 에어컨·책상 울림 같은 낮은 웅웅 소리가 말소리로 잘못 들리지 않게
 *   2) 자동 크기 맞춤: 멀리서 작게 말한 사람(회의 맞은편)도 들리게 키우되, 조용할 때(배경 소음)는 키우지 않는다
 *   3) 너무 큰 소리는 부드럽게 눌러 찌그러지지 않게
 */
class SpeechConditioner(rate: Int) {
    private val alpha = (1.0 / (1.0 + 2 * Math.PI * 100.0 / rate)).toFloat() // 고역 통과 계수
    private var prevIn = 0f
    private var prevOut = 0f
    private var level = 0.02f // 지금 말소리 크기 (느리게 따라감)
    private var noise = 0.005f // 배경 소음 크기 (아주 느리게 따라감)
    private var gain = 1f
    private val target = 0.12f // 맞추려는 말소리 크기 (-18dBFS 쯤)

    fun process(pcm: ByteArray, len: Int) {
        val n = len / 2
        if (n == 0) return
        val buf = java.nio.ByteBuffer.wrap(pcm, 0, n * 2).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        val x = FloatArray(n)
        var sum = 0.0
        for (i in 0 until n) {
            val v = buf.getShort(i * 2) / 32768f
            val y = alpha * (prevOut + v - prevIn)
            prevIn = v
            prevOut = y
            x[i] = y
            sum += y * y
        }
        val rms = kotlin.math.sqrt(sum / n).toFloat()
        // 배경 소음은 조용한 쪽으로 빨리, 큰 쪽으로는 아주 느리게
        noise = if (rms < noise) noise * 0.9f + rms * 0.1f else noise * 0.999f + rms * 0.001f
        val speaking = rms > noise * 2.5f && rms > 0.004f
        if (speaking) level = level * 0.9f + rms * 0.1f
        val want = if (speaking) (target / level.coerceAtLeast(1e-4f)).coerceIn(1f, 8f) else 1f.coerceAtLeast(gain * 0.98f).coerceAtMost(gain)
        gain += (want - gain) * 0.2f
        for (i in 0 until n) {
            var y = x[i] * gain
            if (y > 0.8f) y = 0.8f + (y - 0.8f) * 0.2f else if (y < -0.8f) y = -0.8f + (y + 0.8f) * 0.2f // 부드럽게 누르기
            buf.putShort(i * 2, (y.coerceIn(-1f, 1f) * 32767f).toInt().toShort())
        }
    }
}

// ---------- 소리 파일 받아쓰기 (다른 앱에서 받은 m4a·mp3 등) ----------

object FileTranscriber {
    /** 파일을 16kHz 모노로 풀어 받아쓴다. onProgress: 0~100 */
    fun run(ctx: Context, file: File, engine: String, terms: List<String> = emptyList(), onProgress: (Int) -> Unit): String {
        val parts = ArrayList<Transcript.Line>()
        val stt = Stt.create(ctx, engine, { final, _, spk -> if (!final.isNullOrBlank()) synchronized(parts) { parts.add(Transcript.Line(final, spk)) } }, terms)
        try {
            AudioDecoder.decode16k(file, onProgress) { pcm -> stt.feed(pcm, pcm.size) }
            val tail = stt.finish()
            if (tail.isNotBlank()) synchronized(parts) { parts.add(Transcript.Line(tail, 0)) }
            onProgress(100)
        } finally {
            stt.close()
        }
        return synchronized(parts) { Transcript.join(parts) }
    }
}

/** 소리 파일(m4a·mp3·wav 등)을 풀어(MediaExtractor + MediaCodec) 16kHz 모노 16비트 PCM 조각으로 */
object AudioDecoder {
    fun decode16k(file: File, onProgress: (Int) -> Unit = {}, sink: (ByteArray) -> Unit) {
        val extractor = MediaExtractor()
        try {
            extractor.setDataSource(file.absolutePath)
            val track = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("audio/") == true
            } ?: throw IllegalArgumentException("음성이 없는 파일이에요")
            extractor.selectTrack(track)
            val format = extractor.getTrackFormat(track)
            val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L
            val codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME)!!)
            codec.configure(format, null, null, 0)
            codec.start()
            var resampler = Resampler(format.getInteger(MediaFormat.KEY_SAMPLE_RATE), format.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
            val info = MediaCodec.BufferInfo()
            var inputDone = false
            var lastProgress = -1
            try {
                while (true) {
                    if (!inputDone) {
                        val i = codec.dequeueInputBuffer(10_000)
                        if (i >= 0) {
                            val buf = codec.getInputBuffer(i)!!
                            val n = extractor.readSampleData(buf, 0)
                            if (n < 0) {
                                codec.queueInputBuffer(i, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(i, 0, n, extractor.sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                    val o = codec.dequeueOutputBuffer(info, 10_000)
                    if (o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        resampler = Resampler(codec.outputFormat.getInteger(MediaFormat.KEY_SAMPLE_RATE), codec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT))
                    } else if (o >= 0) {
                        if (info.size > 0) {
                            val buf = codec.getOutputBuffer(o)!!
                            val bytes = ByteArray(info.size)
                            buf.position(info.offset)
                            buf.get(bytes)
                            val pcm = resampler.process(bytes)
                            if (pcm.isNotEmpty()) sink(pcm)
                            if (durationUs > 0) {
                                val p = (info.presentationTimeUs * 100 / durationUs).toInt().coerceIn(0, 99)
                                if (p != lastProgress) {
                                    lastProgress = p
                                    onProgress(p)
                                }
                            }
                        }
                        codec.releaseOutputBuffer(o, false)
                        if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                    }
                }
            } finally {
                codec.stop()
                codec.release()
            }
        } finally {
            extractor.release()
        }
    }
}

/** 16비트 PCM(여러 채널, 아무 표본율) → 16kHz 모노 16비트 (선형 보간) */
class Resampler(private val inRate: Int, private val channels: Int) {
    private val step = inRate.toDouble() / Stt.SAMPLE_RATE
    private var pos = 0.0 // 다음에 뽑을 입력 위치 (이번 덩어리 기준)
    private var prev = 0 // 이전 덩어리의 마지막 표본

    fun process(bytes: ByteArray): ByteArray {
        val frames = bytes.size / (2 * channels)
        if (frames == 0) return ByteArray(0)
        val mono = IntArray(frames)
        for (f in 0 until frames) {
            var sum = 0
            for (c in 0 until channels) {
                val i = (f * channels + c) * 2
                sum += (bytes[i].toInt() and 0xff) or (bytes[i + 1].toInt() shl 8)
            }
            mono[f] = sum / channels
        }
        if (inRate == Stt.SAMPLE_RATE) return toBytes(mono, frames)
        val out = ArrayList<Int>((frames / step).toInt() + 2)
        while (pos < frames) {
            val i = pos.toInt()
            val t = pos - i
            val a = if (i == 0) prev else mono[i - 1]
            val b = mono[i]
            out.add((a + (b - a) * t).toInt())
            pos += step
        }
        pos -= frames
        prev = mono[frames - 1]
        return toBytes(out.toIntArray(), out.size)
    }

    private fun toBytes(s: IntArray, n: Int): ByteArray {
        val b = ByteArray(n * 2)
        for (i in 0 until n) {
            val v = s[i].coerceIn(-32768, 32767)
            b[i * 2] = (v and 0xff).toByte()
            b[i * 2 + 1] = (v shr 8 and 0xff).toByte()
        }
        return b
    }
}

/**
 * 받아쓴 조각들을 읽기 좋은 글로: 조각(한 문장)마다 줄을 바꾸고, 끝에 문장부호(Vosk 는 안 붙여 준다).
 * 말한 사람이 둘 이상이면 사람이 바뀌는 줄 앞에 "화자 2: " (같은 사람이 이어 말하면 줄만 바꿈)
 */
object Transcript {
    data class Line(val text: String, val speaker: Int = 0)

    // 묻는 말로 끝나면 ?, 맺는 말로 끝나면 . (이미 부호가 있으면 그대로)
    private val QUESTION = Regex("(까|까요|나요|가요|는지|는지요|냐|래요|대요|할래|했니|하니|있니|없니|어때|어때요)$")
    private val STATEMENT = Regex("(다|요|죠|네|군|자|세요|니다|지|야|어|아|해|래)$")

    fun punctuate(part: String): String {
        val t = part.trim()
        if (t.isEmpty() || t.last() in ".?!,…~") return t
        return when {
            QUESTION.containsMatchIn(t) -> "$t?"
            STATEMENT.containsMatchIn(t) -> "$t."
            else -> t
        }
    }

    fun join(parts: List<Line>): String {
        val lines = parts.filter { it.text.isNotBlank() }
        val many = lines.map { it.speaker }.filter { it > 0 }.distinct().size >= 2
        val sb = StringBuilder()
        var who = -1
        for (l in lines) {
            if (sb.isNotEmpty()) sb.append('\n')
            // 모르는(0) 조각은 앞사람으로
            val spk = if (l.speaker > 0) l.speaker else who
            if (many && spk > 0 && spk != who) sb.append("화자 ").append(spk).append(": ")
            if (spk > 0) who = spk
            sb.append(punctuate(l.text))
        }
        return sb.toString()
    }

    fun joinText(parts: List<String>) = join(parts.map { Line(it) })
}
