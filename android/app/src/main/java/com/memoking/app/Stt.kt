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
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 받아쓰기(STT) — 녹음하는 소리(16kHz 모노 PCM)를 그대로 받아 글로 옮긴다.
 *  휴대폰의 음성 인식(보통 Google)만 쓴다 — 안드로이드 13 이상, 녹음한 소리를 직접 넘기는 방식.
 *  (예전의 오픈소스 Vosk · 말한 사람 모델은 v0.15 에서 뺐다 — 받아 둔 데이터는 removeOldModels 가 지운다)
 */
interface Transcriber {
    fun feed(pcm: ByteArray, len: Int)
    /** 남은 소리까지 마저 옮기고 끝낸다 → 마지막 조각 */
    fun finish(): String
    fun close()
    /** finish() 뒤: 받아쓴 문장(listener 의 final) 순서대로 화자 번호 (화자 구분을 안 쓰면 null) */
    fun speakers(): IntArray? = null
}

/**
 * 받아쓴 글 조각: final = 한 문장이 끝남, partial = 말하는 중(바뀔 수 있음)
 * speaker = 말한 사람 번호 (말하는 중에는 늘 0 — 화자 구분은 녹음이 끝난 뒤 Transcriber.speakers() 로)
 */
typealias SttListener = (final: String?, partial: String?, speaker: Int) -> Unit

object Stt {
    const val SAMPLE_RATE = 16000

    fun systemAvailable(ctx: Context): Boolean =
        Build.VERSION.SDK_INT >= 33 && SpeechRecognizer.isRecognitionAvailable(ctx)

    /** 지금 받아쓸 수 있는가 — 안 되면 이유 */
    fun unavailableReason(ctx: Context): String? = when {
        Build.VERSION.SDK_INT < 33 -> "이 휴대폰(안드로이드 13 아래)은 받아쓰기를 쓸 수 없어 녹음만 해요"
        !SpeechRecognizer.isRecognitionAvailable(ctx) -> "휴대폰에 Google 음성 인식이 없어 녹음만 해요 (Google 앱을 설치·업데이트해 주세요)"
        else -> null
    }

    /**
     * @param terms 이 메모 폴더에서 자주 쓰는 낱말(태그·제목 등) — 휴대폰 음성 인식에 "이런 말이 나올 수 있어요" 힌트로
     * 받아쓰기 엔진에 넘기기 전에 소리를 다듬는다 (SpeechConditioner: 낮은 웅웅 소리 빼기 · 작은 목소리 키우기)
     */
    fun create(ctx: Context, listener: SttListener, terms: List<String> = emptyList()): Transcriber {
        val labeler = if (SpeakerModel.on(ctx)) try {
            SpeakerLabeler(SpeakerModel.load(ctx))
        } catch (e: Throwable) { // 엔진을 못 불러와도(드문 기기) 받아쓰기는 그대로
            android.util.Log.w("MemoKing", "화자 구분을 시작하지 못했어요", e)
            null
        } else null
        if (labeler == null) return Conditioned(SystemTranscriber(ctx, listener, terms))
        val marking: SttListener = { final, part, spk ->
            if (!final.isNullOrBlank()) labeler.mark()
            listener(final, part, spk)
        }
        return Labeled(Conditioned(SystemTranscriber(ctx, marking, terms)), labeler)
    }

    /** 화자 구분: 원래 소리(다듬기 전)로 목소리 특징을 모으고, 끝나면 문장별 화자 번호 */
    private class Labeled(private val inner: Transcriber, private val labeler: SpeakerLabeler) : Transcriber {
        private var labels: IntArray? = null
        override fun feed(pcm: ByteArray, len: Int) {
            labeler.feed(pcm, len)
            inner.feed(pcm, len)
        }
        override fun finish(): String {
            val tail = inner.finish()
            labels = try {
                labeler.finish()
            } catch (e: Throwable) {
                null
            }
            return tail
        }
        override fun close() {
            inner.close()
            labeler.close()
        }
        override fun speakers() = labels
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

    fun status(ctx: Context): JSONObject = JSONObject().put("system", systemAvailable(ctx))
        .put("speakerSupported", SpeakerModel.supported())
        .put("speaker", if (SpeakerModel.ready(ctx)) "ready" else if (SpeakerModel.progress >= 0) "downloading" else "missing")
        .put("speakerOn", SpeakerModel.on(ctx))
        .put("speakerSize", SpeakerModel.SIZE_LABEL)

    /** 예전 버전이 받아 둔 Vosk 받아쓰기·말한 사람 데이터(약 100MB)를 지워 저장 공간을 돌려준다 */
    fun removeOldModels(ctx: Context) {
        File(ctx.filesDir, "stt").deleteRecursively()
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
    fun run(ctx: Context, file: File, terms: List<String> = emptyList(), onProgress: (Int) -> Unit): String {
        val parts = ArrayList<Transcript.Line>()
        val stt = Stt.create(ctx, { final, _, spk -> if (!final.isNullOrBlank()) synchronized(parts) { parts.add(Transcript.Line(final, spk)) } }, terms)
        try {
            AudioDecoder.decode16k(file, onProgress) { pcm -> stt.feed(pcm, pcm.size) }
            val tail = stt.finish()
            synchronized(parts) { Transcript.relabel(parts, stt.speakers()) }
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
 * 받아쓴 조각들을 읽기 좋은 글로: 조각(한 문장)마다 줄을 바꾸고, 끝에 문장부호(없으면).
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

    /** 녹음이 끝난 뒤 받은 화자 번호(문장 순서대로)를 붙인다 */
    fun relabel(parts: MutableList<Line>, speakers: IntArray?) {
        if (speakers == null) return
        for (i in parts.indices) if (i < speakers.size) parts[i] = parts[i].copy(speaker = speakers[i])
    }
}
