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
 *  - "vosk"   : 오픈소스 Vosk (alphacep/vosk-api, Apache-2.0) + 한국어 모델(vosk-model-small-ko, 약 82MB, 처음 한 번 받음).
 *               인터넷 없이 휴대폰 안에서만 돌아서 회의 내용이 밖으로 나가지 않는다. 모든 안드로이드 버전.
 *  - "system" : 휴대폰의 음성 인식(보통 Google). 더 정확하지만 안드로이드 13 이상, 녹음한 소리를 직접 넘기는 방식.
 */
interface Transcriber {
    fun feed(pcm: ByteArray, len: Int)
    /** 남은 소리까지 마저 옮기고 끝낸다 → 마지막 조각 */
    fun finish(): String
    fun close()
}

/** 받아쓴 글 조각: final = 한 문장이 끝남, partial = 말하는 중(바뀔 수 있음) */
typealias SttListener = (final: String?, partial: String?) -> Unit

object Stt {
    const val SAMPLE_RATE = 16000
    const val ENGINE_VOSK = "vosk"
    const val ENGINE_SYSTEM = "system"

    fun systemAvailable(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isRecognitionAvailable(ctx)

    /** 이 엔진으로 지금 받아쓸 수 있는가 — 안 되면 이유 */
    fun unavailableReason(ctx: Context, engine: String): String? = when (engine) {
        ENGINE_SYSTEM -> if (systemAvailable(ctx)) null else "이 휴대폰에서는 휴대폰 음성 인식으로 받아쓸 수 없어요 (안드로이드 13 이상)"
        else -> if (VoskModels.ready(ctx)) null else "받아쓰기 모델을 아직 받지 않았어요 (설정 › 녹음 › 한국어 받아쓰기 모델)"
    }

    fun create(ctx: Context, engine: String, listener: SttListener): Transcriber =
        if (engine == ENGINE_SYSTEM && Build.VERSION.SDK_INT >= 33) SystemTranscriber(ctx, listener)
        else VoskTranscriber(VoskModels.load(ctx), listener)

    fun status(ctx: Context): JSONObject = JSONObject()
        .put("model", if (VoskModels.ready(ctx)) "ready" else if (VoskModels.progress >= 0) "downloading" else "missing")
        .put("progress", VoskModels.progress)
        .put("modelSize", VoskModels.SIZE_LABEL)
        .put("system", systemAvailable(ctx))
}

// ---------- Vosk (오픈소스, 인터넷 없이) ----------

class VoskTranscriber(model: Model, private val listener: SttListener) : Transcriber {
    private val rec = Recognizer(model, Stt.SAMPLE_RATE.toFloat())
    private var lastPartial = ""
    private var partialAt = 0L

    override fun feed(pcm: ByteArray, len: Int) {
        if (rec.acceptWaveForm(pcm, len)) {
            val text = JSONObject(rec.result).optString("text").trim()
            lastPartial = ""
            if (text.isNotEmpty()) listener(text, "")
        } else {
            val now = System.currentTimeMillis()
            if (now - partialAt < 300) return // 말하는 중 글은 0.3초마다만
            partialAt = now
            val partial = JSONObject(rec.partialResult).optString("partial").trim()
            if (partial != lastPartial) {
                lastPartial = partial
                listener(null, partial)
            }
        }
    }

    override fun finish(): String = try {
        JSONObject(rec.finalResult).optString("text").trim()
    } catch (e: Exception) {
        ""
    }

    override fun close() = rec.close()
}

/** Vosk 한국어 모델: 앱 안 저장 공간(files/stt/)에 한 번 받아 두고 쓴다 */
object VoskModels {
    const val NAME = "vosk-model-small-ko-0.22"
    const val URL_ZIP = "https://alphacephei.com/vosk/models/$NAME.zip"
    const val SIZE_LABEL = "약 82MB"

    /** 받는 중이면 0~100, 아니면 -1 */
    @Volatile
    var progress = -1
        private set

    private var model: Model? = null

    private fun root(ctx: Context) = File(ctx.filesDir, "stt")
    fun dir(ctx: Context) = File(root(ctx), NAME)
    fun ready(ctx: Context) = File(dir(ctx), ".ok").isFile

    @Synchronized
    fun load(ctx: Context): Model {
        model?.let { return it }
        if (!ready(ctx)) throw IllegalStateException("받아쓰기 모델이 없어요")
        LibVosk.setLogLevel(LogLevel.WARNINGS)
        return Model(dir(ctx).absolutePath).also { model = it }
    }

    /** 모델 받기 (zip 을 받아 풀기). 오래 걸리므로 백그라운드 스레드에서 */
    @Synchronized
    fun download(ctx: Context, onProgress: (Int) -> Unit) {
        if (ready(ctx)) return
        val root = root(ctx).apply { mkdirs() }
        val zip = File(root, "$NAME.zip.part")
        val unpack = File(root, "$NAME.part")
        progress = 0
        try {
            var conn = URL(URL_ZIP).openConnection() as HttpURLConnection
            for (i in 0 until 5) { // https → 다른 주소로 넘겨주기(리다이렉트) 따라가기
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 30_000
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location") ?: break
                    conn.disconnect()
                    conn = URL(URL(URL_ZIP), next).openConnection() as HttpURLConnection
                    continue
                }
                if (code != 200) throw IOException("모델을 받지 못했어요 (HTTP $code)")
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
            // 풀기: zip 안의 "vosk-model-small-ko-0.22/..." → files/stt/vosk-model-small-ko-0.22/...
            unpack.deleteRecursively()
            unpack.mkdirs()
            ZipInputStream(zip.inputStream().buffered()).use { zin ->
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
            File(unpack, ".ok").writeText(NAME)
            dir(ctx).deleteRecursively()
            if (!unpack.renameTo(dir(ctx))) throw IOException("모델을 풀지 못했어요")
            progress = 100
            onProgress(100)
        } finally {
            zip.delete()
            unpack.deleteRecursively()
            progress = -1
        }
    }

    @Synchronized
    fun delete(ctx: Context) {
        model?.close()
        model = null
        dir(ctx).deleteRecursively()
    }
}

// ---------- 휴대폰 음성 인식 (안드로이드 13+, 녹음한 소리를 파이프로 넘긴다) ----------

class SystemTranscriber(private val ctx: Context, private val listener: SttListener) : Transcriber {
    private val main = Handler(Looper.getMainLooper())
    private val pipe = ParcelFileDescriptor.createPipe()
    private val out = ParcelFileDescriptor.AutoCloseOutputStream(pipe[1])
    private var recognizer: SpeechRecognizer? = null
    private val ended = CountDownLatch(1)
    @Volatile
    private var failed = false

    init {
        main.post { begin() }
    }

    private fun begin() {
        if (Build.VERSION.SDK_INT < 33) return
        val sr = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = sr
        sr.setRecognitionListener(object : RecognitionListener {
            override fun onSegmentResults(segmentResults: Bundle) {
                val text = segmentResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                if (text.isNotEmpty()) listener(text, "")
            }
            override fun onPartialResults(partialResults: Bundle) {
                val text = partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
                listener(null, text)
            }
            override fun onResults(results: Bundle) {
                onSegmentResults(results)
                ended.countDown()
            }
            override fun onEndOfSegmentedSession() {
                ended.countDown()
            }
            override fun onError(error: Int) {
                failed = true
                ended.countDown()
                android.util.Log.w("MemoKing", "음성 인식 오류 $error")
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
        sr.startListening(intent)
    }

    override fun feed(pcm: ByteArray, len: Int) {
        if (failed) return
        try {
            out.write(pcm, 0, len)
        } catch (e: IOException) {
            failed = true
        }
    }

    override fun finish(): String {
        try {
            out.close() // 소리가 끝났다고 알린다 → 남은 글을 보내고 끝남
        } catch (e: IOException) {
            // 이미 닫힘
        }
        ended.await(8, TimeUnit.SECONDS)
        return ""
    }

    override fun close() {
        main.post {
            recognizer?.destroy()
            recognizer = null
        }
        try {
            pipe[0].close()
        } catch (e: IOException) {
            // 무시
        }
    }
}

// ---------- 소리 파일 받아쓰기 (다른 앱에서 받은 m4a·mp3 등) ----------

object FileTranscriber {
    /** 파일을 16kHz 모노로 풀어 받아쓴다. onProgress: 0~100 */
    fun run(ctx: Context, file: File, engine: String, onProgress: (Int) -> Unit): String {
        val parts = ArrayList<String>()
        val stt = Stt.create(ctx, engine) { final, _ -> if (!final.isNullOrBlank()) synchronized(parts) { parts.add(final) } }
        try {
            AudioDecoder.decode16k(file, onProgress) { pcm -> stt.feed(pcm, pcm.size) }
            val tail = stt.finish()
            if (tail.isNotBlank()) synchronized(parts) { parts.add(tail) }
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
            } ?: throw IllegalArgumentException("소리가 들어 있지 않은 파일이에요")
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

/** 받아쓴 조각들을 읽기 좋은 글로: 조각 사이는 띄어쓰기, 몇 조각마다 문단 */
object Transcript {
    fun join(parts: List<String>, perParagraph: Int = 4): String {
        val sb = StringBuilder()
        parts.filter { it.isNotBlank() }.forEachIndexed { i, p ->
            if (i > 0) sb.append(if (i % perParagraph == 0) "\n\n" else " ")
            sb.append(p.trim())
        }
        return sb.toString()
    }
}
