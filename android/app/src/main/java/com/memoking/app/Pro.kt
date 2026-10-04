package com.memoking.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.bzip2.BZip2CompressorInputStream
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.UUID
import kotlin.math.sqrt

/**
 * 정확하게 다시 받아쓰기 · 말한 사람 구분 — 녹음이 끝난 소리 파일을 한 번 더, 더 무거운 오픈소스 모델로.
 *
 *  - 받아쓰기: OpenAI Whisper small (MIT) 을 sherpa-onnx (k2-fsa/sherpa-onnx, Apache-2.0) 로 휴대폰 안에서
 *  - 말한 사람 구분: pyannote segmentation-3.0 (MIT) + 3D-Speaker ERes2Net (Apache-2.0) 목소리 특징 → 묶기
 * 인터넷 없이 돈다 (모델만 처음 한 번 받음). 1시간 회의도 화면을 끄고 끝까지 하도록 포그라운드 서비스(ProService)에서.
 * sherpa-onnx 를 부르는 곳은 ProEngine (src/sherpa — 라이브러리가 있을 때만 빌드에 들어감).
 */

/** 말한 사람 구간 (초) — speaker 가 -1 이면 구분하지 않음 */
data class Seg(val start: Float, val end: Float, val speaker: Int)

interface ProRecognizer {
    fun transcribe(samples: FloatArray): String
    fun release()
}

// ---------- 모델 받기 ----------

object ProModels {
    private const val GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
    private const val HF = "https://huggingface.co/csukuangfj"

    /** 모델 하나 = 파일 몇 개. 파일마다 받을 곳을 차례로 (앞이 안 되면 다음) — tar 는 압축 파일 안의 그 파일 */
    class Source(val url: String, val inTar: String? = null)
    class ModelFile(val name: String, val sources: List<Source>)
    class Model(val key: String, val label: String, val sizeLabel: String, val files: List<ModelFile>)

    private val whisperTar = "$GH/asr-models/sherpa-onnx-whisper-small.tar.bz2"
    val WHISPER = Model(
        "whisper", "정확한 받아쓰기 (Whisper small)", "약 360MB",
        listOf("small-encoder.int8.onnx", "small-decoder.int8.onnx", "small-tokens.txt").map { f ->
            ModelFile(f, listOf(Source("$HF/sherpa-onnx-whisper-small/resolve/main/$f"), Source(whisperTar, "sherpa-onnx-whisper-small/$f")))
        },
    )
    val DIARIZE = Model(
        "diarize", "말한 사람 구분 (pyannote + 3D-Speaker)", "약 45MB",
        listOf(
            ModelFile(
                "segmentation.onnx",
                listOf(
                    Source("$GH/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"),
                    Source("$HF/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx"),
                ),
            ),
            ModelFile(
                "embedding.onnx",
                listOf(
                    Source("$GH/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx"),
                    Source("$GH/speaker-recongition-models/nemo_en_titanet_small.onnx"),
                ),
            ),
        ),
    )
    val ALL = listOf(WHISPER, DIARIZE)

    private val progress = java.util.concurrent.ConcurrentHashMap<String, Int>() // 받는 중인 모델 → 0~100

    fun dir(ctx: Context, m: Model) = File(ctx.filesDir, "pro/${m.key}")
    fun file(ctx: Context, m: Model, name: String) = File(dir(ctx, m), name)
    fun ready(ctx: Context, m: Model) = File(dir(ctx, m), ".ok").isFile

    fun status(ctx: Context): JSONObject {
        val o = JSONObject().put("available", ProEngine.AVAILABLE)
        for (m in ALL) {
            o.put(
                m.key,
                JSONObject().put("state", if (ready(ctx, m)) "ready" else if (progress.containsKey(m.key)) "downloading" else "missing")
                    .put("progress", progress[m.key] ?: -1).put("label", m.label).put("size", m.sizeLabel),
            )
        }
        return o.put("busy", ProService.current?.status() ?: JSONObject.NULL)
    }

    /** 모델 받기 (백그라운드 스레드). onProgress(모델 키, 0~100) */
    fun download(ctx: Context, keys: List<String>, onProgress: (String, Int) -> Unit) {
        for (m in ALL.filter { it.key in keys && !ready(ctx, it) }) {
            synchronized(m) {
                if (ready(ctx, m)) return@synchronized
                val dir = dir(ctx, m).apply { mkdirs() }
                try {
                    m.files.forEachIndexed { i, f ->
                        val target = File(dir, f.name)
                        if (target.isFile && target.length() > 0) return@forEachIndexed
                        var last: Exception? = null
                        for (src in f.sources) {
                            try {
                                fetch(ctx, src, target) { p ->
                                    val total = (i * 100 + p) / m.files.size
                                    progress[m.key] = total
                                    onProgress(m.key, total)
                                }
                                last = null
                                break
                            } catch (e: Exception) {
                                android.util.Log.w("MemoKing", "모델 받기 실패 ${src.url}", e)
                                last = e
                            }
                        }
                        last?.let { throw IOException("${m.label} 모델을 받지 못했어요: ${it.message}") }
                    }
                    File(dir, ".ok").writeText(m.key)
                    onProgress(m.key, 100)
                } finally {
                    progress.remove(m.key)
                }
            }
        }
    }

    fun delete(ctx: Context, key: String) {
        ALL.firstOrNull { it.key == key }?.let { dir(ctx, it).deleteRecursively() }
    }

    private fun fetch(ctx: Context, src: Source, target: File, onProgress: (Int) -> Unit) {
        val part = File(target.parentFile, "${target.name}.part")
        val conn = URL(src.url).openConnection() as HttpURLConnection
        conn.instanceFollowRedirects = true
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.setRequestProperty("User-Agent", "MemoKing-Android")
        try {
            if (conn.responseCode != 200) throw IOException("HTTP ${conn.responseCode}")
            val total = conn.contentLengthLong
            var done = 0L
            var last = -1
            val counting = object : java.io.FilterInputStream(conn.inputStream.buffered(256 * 1024)) {
                override fun read(b: ByteArray, off: Int, len: Int): Int {
                    val n = super.read(b, off, len)
                    if (n > 0) {
                        done += n
                        val p = if (total > 0) (done * 100 / total).toInt() else 0
                        if (p != last) {
                            last = p
                            onProgress(p)
                        }
                    }
                    return n
                }
            }
            counting.use { input ->
                if (src.inTar == null) {
                    part.outputStream().use { input.copyTo(it, 256 * 1024) }
                } else {
                    // .tar.bz2 안의 파일 하나만 꺼낸다
                    var found = false
                    TarArchiveInputStream(BZip2CompressorInputStream(input)).use { tar ->
                        while (true) {
                            val e = tar.nextEntry ?: break
                            if (e.name.trimStart('.', '/') == src.inTar) {
                                part.outputStream().use { tar.copyTo(it, 256 * 1024) }
                                found = true
                                break
                            }
                        }
                    }
                    if (!found) throw IOException("압축 파일에 ${src.inTar} 가 없어요")
                }
            }
        } finally {
            conn.disconnect()
        }
        if (!part.renameTo(target)) throw IOException("모델 파일을 저장하지 못했어요")
    }
}

// ---------- 소리 → 조각 → 받아쓰기 ----------

object ProPipeline {
    private const val RATE = Stt.SAMPLE_RATE
    private const val MAX_CHUNK = 28f // Whisper 는 30초까지 한 번에
    private const val MIN_CHUNK = 16f
    private const val WHOLE_LIMIT_SEC = 75 * 60 // 이보다 길면 30분씩 나눠 말한 사람을 구분

    // 조용한 곳에서 Whisper 가 지어내는 흔한 문장
    private val HALLUCINATIONS = Regex("^\\s*(시청해\\s?주셔서 감사합니다|구독과 좋아요|MBC 뉴스|감사합니다)[.!\\s]*$")

    /**
     * @param speakers 말한 사람 수 (0 = 자동)
     * @param onStage (단계, 0~100) — decode · diarize · transcribe
     */
    fun run(ctx: Context, audio: File, work: File, diarize: Boolean, speakers: Int, cancelled: () -> Boolean, onStage: (String, Int) -> Unit): JSONObject {
        if (!ProEngine.AVAILABLE) throw IllegalStateException("이 빌드에는 정확한 받아쓰기가 들어 있지 않아요")
        if (!ProModels.ready(ctx, ProModels.WHISPER)) throw IllegalStateException("정확한 받아쓰기 모델을 먼저 받아 주세요")
        if (diarize && !ProModels.ready(ctx, ProModels.DIARIZE)) throw IllegalStateException("말한 사람 구분 모델을 먼저 받아 주세요")
        // 1) 16kHz 모노 PCM 파일로 풀기 (긴 회의도 메모리에 다 올리지 않게)
        val pcm = File(work, "audio.pcm")
        pcm.outputStream().buffered(1 shl 20).use { out ->
            AudioDecoder.decode16k(audio, { onStage("decode", it) }) { out.write(it) }
        }
        val total = pcm.length() / 2
        if (total < RATE / 2) throw IllegalArgumentException("소리가 너무 짧아요")
        RandomAccessFile(pcm, "r").use { raf ->
            // 2) 말한 사람 구간
            val segs: List<Seg> = if (diarize) diarizeAll(ctx, raf, total, speakers, cancelled) { onStage("diarize", it) } else listOf(Seg(0f, total.toFloat() / RATE, -1))
            if (cancelled()) throw InterruptedException()
            // 3) 받아쓸 조각 (28초 이하, 조용한 곳에서 자름)
            val chunks = chunk(raf, total, segs)
            // 4) Whisper
            val rec = ProEngine.whisper(
                ProModels.file(ctx, ProModels.WHISPER, "small-encoder.int8.onnx").absolutePath,
                ProModels.file(ctx, ProModels.WHISPER, "small-decoder.int8.onnx").absolutePath,
                ProModels.file(ctx, ProModels.WHISPER, "small-tokens.txt").absolutePath,
            )
            val out = JSONArray()
            val speakerIds = HashSet<Int>()
            try {
                val allSec = chunks.sumOf { (it.end - it.start).toDouble() }.coerceAtLeast(0.1)
                var doneSec = 0.0
                for (c in chunks) {
                    if (cancelled()) throw InterruptedException()
                    val samples = read(raf, (c.start * RATE).toLong(), (c.end * RATE).toLong())
                    val text = if (rms(samples) < 0.004f) "" else rec.transcribe(samples).trim()
                    doneSec += c.end - c.start
                    onStage("transcribe", (doneSec * 100 / allSec).toInt().coerceIn(0, 99))
                    if (text.isEmpty() || HALLUCINATIONS.matches(text)) continue
                    if (c.speaker >= 0) speakerIds.add(c.speaker)
                    out.put(JSONObject().put("start", c.start.toDouble()).put("end", c.end.toDouble()).put("speaker", c.speaker).put("text", text))
                }
            } finally {
                rec.release()
            }
            onStage("transcribe", 100)
            return JSONObject().put("engine", "whisper-small").put("diarize", diarize)
                .put("speakers", speakerIds.size).put("durationSec", total.toDouble() / RATE).put("segments", out)
        }
    }

    private fun diarizeAll(ctx: Context, raf: RandomAccessFile, total: Long, speakers: Int, cancelled: () -> Boolean, onProgress: (Int) -> Unit): List<Seg> {
        val seg = ProModels.file(ctx, ProModels.DIARIZE, "segmentation.onnx").absolutePath
        val emb = ProModels.file(ctx, ProModels.DIARIZE, "embedding.onnx").absolutePath
        fun window(windowSec: Int): List<Seg> {
            val out = ArrayList<Seg>()
            val step = windowSec.toLong() * RATE
            var from = 0L
            var offsetSpeaker = 0
            while (from < total) {
                if (cancelled()) throw InterruptedException()
                val to = minOf(total, from + step)
                val samples = read(raf, from, to)
                val part = ProEngine.diarize(seg, emb, samples, speakers) { p -> onProgress(((from + (to - from) * p / 100) * 100 / total).toInt()) }
                val base = from.toFloat() / RATE
                var maxSpeaker = -1
                for (s in part) {
                    out.add(Seg(base + s.start, base + s.end, offsetSpeaker + s.speaker))
                    maxSpeaker = maxOf(maxSpeaker, s.speaker)
                }
                // 나눠서 구분하면 조각마다 사람 번호가 따로 붙는다 (자동이면 번호를 이어서)
                if (speakers <= 0) offsetSpeaker += maxSpeaker + 1
                from = to
            }
            return out
        }
        val list = try {
            window(if (total > WHOLE_LIMIT_SEC.toLong() * RATE) 30 * 60 else WHOLE_LIMIT_SEC)
        } catch (e: OutOfMemoryError) {
            System.gc()
            window(15 * 60)
        }
        onProgress(100)
        return list.sortedBy { it.start }
    }

    /** 말한 사람 구간 → 받아쓸 조각: 같은 사람이 이어 말하면 붙이고, 길면 조용한 곳에서 자른다 */
    fun chunk(raf: RandomAccessFile, total: Long, segs: List<Seg>): List<Seg> {
        val merged = ArrayList<Seg>()
        for (s in segs) {
            if (s.end - s.start < 0.3f) continue
            val last = merged.lastOrNull()
            if (last != null && last.speaker == s.speaker && s.start - last.end < 0.8f && s.end - last.start <= MAX_CHUNK) {
                merged[merged.size - 1] = Seg(last.start, s.end, s.speaker)
            } else merged.add(s)
        }
        val out = ArrayList<Seg>()
        for (s in merged) {
            var start = s.start
            while (s.end - start > MAX_CHUNK) {
                val cut = quietest(raf, total, start + MIN_CHUNK, start + MAX_CHUNK)
                out.add(Seg(start, cut, s.speaker))
                start = cut
            }
            out.add(Seg(start, s.end, s.speaker))
        }
        return out
    }

    /** from~to (초) 사이에서 가장 조용한 20ms 자리 */
    private fun quietest(raf: RandomAccessFile, total: Long, from: Float, to: Float): Float {
        val a = (from * RATE).toLong().coerceIn(0, total)
        val b = (to * RATE).toLong().coerceIn(a, total)
        val samples = read(raf, a, b)
        val frame = RATE / 50
        var best = 0
        var bestE = Float.MAX_VALUE
        var i = 0
        while (i + frame <= samples.size) {
            var e = 0f
            for (k in i until i + frame) e += samples[k] * samples[k]
            if (e < bestE) {
                bestE = e
                best = i
            }
            i += frame
        }
        return (a + best + frame / 2).toFloat() / RATE
    }

    /** PCM 파일에서 [from, to) 표본을 -1~1 로 */
    fun read(raf: RandomAccessFile, from: Long, to: Long): FloatArray {
        val n = (to - from).coerceAtLeast(0).toInt()
        val bytes = ByteArray(n * 2)
        raf.seek(from * 2)
        raf.readFully(bytes, 0, bytes.size)
        val shorts = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        return FloatArray(n) { shorts.get(it) / 32768f }
    }

    private fun rms(s: FloatArray): Float {
        if (s.isEmpty()) return 0f
        var sum = 0.0
        for (v in s) sum += v * v
        return sqrt(sum / s.size).toFloat()
    }
}

// ---------- 백그라운드에서 끝까지 (포그라운드 서비스) ----------

class ProService : Service() {
    companion object {
        const val CHANNEL = "transcribe"
        private const val NOTIFY_ID = 7401
        private const val ACTION_CANCEL = "com.memoking.app.PRO_CANCEL"

        @Volatile
        var current: Job? = null
            private set

        @Volatile
        var listener: ((JSONObject) -> Unit)? = null

        /** 일 시작 → 일 id. 소리 파일은 일 폴더로 복사해 둔 것 */
        fun start(ctx: Context, memoId: String, rel: String, audio: File, diarize: Boolean, speakers: Int): String {
            if (current != null) throw IllegalStateException("다른 받아쓰기를 하고 있어요. 끝난 뒤 다시 해 주세요")
            val job = Job(ctx.applicationContext, memoId, rel, audio, diarize, speakers)
            current = job
            ctx.startForegroundService(Intent(ctx, ProService::class.java))
            return job.id
        }

        fun cancel() {
            current?.cancelled = true
        }

        fun jobsDir(ctx: Context) = File(ctx.filesDir, "jobs").apply { mkdirs() }
    }

    class Job(val ctx: Context, val memoId: String, val rel: String, val audio: File, val diarize: Boolean, val speakers: Int) {
        val id: String = UUID.randomUUID().toString()
        @Volatile var cancelled = false
        @Volatile var stage = "decode"
        @Volatile var progress = 0
        fun status(): JSONObject = JSONObject().put("id", id).put("memoId", memoId).put("rel", rel).put("stage", stage).put("progress", progress).put("diarize", diarize)
    }

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) {
            cancel()
            return START_NOT_STICKY
        }
        val job = current ?: run {
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel()
        val n = notification(job)
        when {
            Build.VERSION.SDK_INT >= 35 -> startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
            Build.VERSION.SDK_INT >= 30 -> startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            else -> startForeground(NOTIFY_ID, n)
        }
        wake = getSystemService(PowerManager::class.java)!!.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MemoKing:transcribe").apply { acquire(5 * 60 * 60 * 1000L) }
        Thread({ work(job) }, "memoking-pro").start()
        return START_NOT_STICKY
    }

    private fun work(job: Job) {
        val dir = File(jobsDir(this), job.id).apply { mkdirs() }
        var lastNotify = 0L
        val result: JSONObject = try {
            val r = ProPipeline.run(this, job.audio, dir, job.diarize, job.speakers, { job.cancelled }) { stage, p ->
                job.stage = stage
                job.progress = p
                val now = System.currentTimeMillis()
                if (now - lastNotify > 1500) {
                    lastNotify = now
                    listener?.invoke(JSONObject().put("type", "progress").put("status", job.status()))
                    try {
                        getSystemService(NotificationManager::class.java)!!.notify(NOTIFY_ID, notification(job))
                    } catch (e: SecurityException) {
                        // 알림 권한 없음
                    }
                }
            }
            r.put("ok", true)
        } catch (e: InterruptedException) {
            JSONObject().put("ok", false).put("cancelled", true).put("message", "받아쓰기를 그만뒀어요")
        } catch (e: Throwable) {
            android.util.Log.e("MemoKing", "다시 받아쓰기 실패", e)
            JSONObject().put("ok", false).put("message", e.message ?: e.javaClass.simpleName)
        }
        result.put("id", job.id).put("memoId", job.memoId).put("rel", job.rel)
        dir.deleteRecursively()
        job.audio.delete()
        JobStore.add(this, result)
        current = null
        listener?.invoke(JSONObject().put("type", "done").put("result", result))
        wake?.let { if (it.isHeld) it.release() }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java)!!
        if (nm.getNotificationChannel(CHANNEL) != null) return
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "받아쓰기", NotificationManager.IMPORTANCE_LOW).apply {
            description = "녹음을 정확하게 다시 받아쓰는 동안 보이는 알림"
            setShowBadge(false)
        })
    }

    private fun notification(job: Job): Notification {
        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_MEMO)
            .setData(Uri.parse("memoking://memo/" + Uri.encode(job.memoId) + "?pro=1"))
            .putExtra("memoId", job.memoId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val content = PendingIntent.getActivity(this, 7402, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val cancel = PendingIntent.getService(this, 7403, Intent(this, ProService::class.java).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stageLabel = when (job.stage) {
            "decode" -> "소리 파일 읽는 중"
            "diarize" -> "말한 사람 나누는 중"
            else -> "받아쓰는 중"
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_crown)
            .setColor(0xFF7A4DFF.toInt())
            .setContentTitle("정확하게 다시 받아쓰기 · $stageLabel")
            .setContentText("${job.progress}% · 화면을 꺼도 계속해요")
            .setProgress(100, job.progress, false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(content)
            .addAction(Notification.Action.Builder(null, "그만두기", cancel).build())
            .build()
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}

/** 끝난 받아쓰기 결과 (화면이 메모에 넣으면 지움) */
object JobStore {
    private fun list(ctx: Context) = File(ProService.jobsDir(ctx), "done.json")

    @Synchronized
    fun all(ctx: Context): JSONArray = try {
        JSONArray(list(ctx).takeIf { it.isFile }?.readText() ?: "[]")
    } catch (e: Exception) {
        JSONArray()
    }

    @Synchronized
    fun add(ctx: Context, result: JSONObject) {
        val arr = all(ctx)
        arr.put(result)
        list(ctx).writeText(arr.toString())
    }

    @Synchronized
    fun ack(ctx: Context, id: String) {
        val arr = all(ctx)
        val keep = JSONArray()
        for (i in 0 until arr.length()) if (arr.getJSONObject(i).optString("id") != id) keep.put(arr.getJSONObject(i))
        list(ctx).writeText(keep.toString())
    }
}
