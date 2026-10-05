package com.memoking.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * 녹음 · 받아쓰기 — 화면을 끄거나 다른 앱을 써도 계속 녹음하는 포그라운드 서비스 (알림에 시간·멈춤·끝내기).
 *
 * 마이크(AudioRecord, 16kHz 모노) 소리 하나를 두 곳에 나눠 준다:
 *   1) AAC 로 눌러(MediaCodec) .m4a 파일로 (MediaMuxer)  → 메모의 attachments/ 에 들어간다
 *   2) 받아쓰기(Stt.kt: 오픈소스 Vosk 또는 휴대폰 음성 인식) → 받아쓴 글이 메모에 함께 들어간다
 * 끝나면 결과를 앱 안에 적어 두고(RecordStore) 화면이 메모에 넣은 뒤 지운다 — 알림에서 끝내 앱이 꺼져 있어도 잃지 않는다.
 */
class RecorderService : Service() {
    companion object {
        const val CHANNEL = "recording"
        private const val NOTIFY_ID = 7301
        const val ACTION_START = "com.memoking.app.REC_START"
        const val ACTION_STOP = "com.memoking.app.REC_STOP"
        const val ACTION_PAUSE = "com.memoking.app.REC_PAUSE"
        const val ACTION_RESUME = "com.memoking.app.REC_RESUME"

        @Volatile
        var session: Session? = null
            private set

        /** 화면에 소식 보내기 (MainActivity 가 정함) */
        @Volatile
        var listener: ((JSONObject) -> Unit)? = null

        fun hasMic(ctx: Context) = ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

        /** 녹음 시작 → { stt: 받아쓰는지, reason: 못 받아쓰는 이유 } */
        fun start(ctx: Context, memoId: String, stt: Boolean, engine: String, terms: List<String> = emptyList()): JSONObject {
            if (session != null) throw IllegalStateException("이미 녹음하고 있어요")
            if (!hasMic(ctx)) throw IllegalStateException("마이크 권한이 없어요")
            val reason = if (stt) Stt.unavailableReason(ctx, engine) else null
            val s = Session(ctx.applicationContext, memoId, stt && reason == null, engine, wantedStt = stt, terms = terms)
            session = s
            val intent = Intent(ctx, RecorderService::class.java).setAction(ACTION_START)
            try {
                ctx.startForegroundService(intent)
            } catch (e: Exception) {
                session = null
                throw IllegalStateException("녹음을 시작하지 못했어요. 다른 앱이 마이크를 쓰고 있는지 확인해 주세요")
            }
            return JSONObject().put("stt", s.stt).put("reason", reason ?: "")
        }

        fun status(): JSONObject = session?.status() ?: JSONObject()
            .put("active", false).put("paused", false).put("memoId", JSONObject.NULL)
            .put("elapsedMs", 0).put("stt", false).put("text", "").put("partial", "")

        /** 끝내기 (오래 걸릴 수 있음: 파일 마무리·남은 받아쓰기) → 결과 */
        fun stop(ctx: Context): JSONObject? {
            val s = session ?: return null
            val result = s.stop()
            session = null
            ctx.startService(Intent(ctx, RecorderService::class.java).setAction(ACTION_STOP))
            return result
        }

        fun ensureChannel(ctx: Context) {
            val nm = ctx.getSystemService(NotificationManager::class.java)!!
            if (nm.getNotificationChannel(CHANNEL) != null) return
            val ch = NotificationChannel(CHANNEL, "녹음", NotificationManager.IMPORTANCE_LOW)
            ch.description = "녹음하는 동안 보이는 알림 (시간·멈춤·끝내기)"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
    }

    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val s = session ?: run {
                    stopSelf()
                    return START_NOT_STICKY
                }
                ensureChannel(this)
                val n = notification(s)
                if (Build.VERSION.SDK_INT >= 30) startForeground(NOTIFY_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                else startForeground(NOTIFY_ID, n)
                // 화면이 꺼져도 CPU 가 잠들지 않게 (받아쓰기·파일 쓰기)
                wake = getSystemService(PowerManager::class.java)!!
                    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MemoKing:recording").apply { acquire(6 * 60 * 60 * 1000L) }
                s.onChange = { refresh() }
                try {
                    s.begin()
                } catch (e: Exception) {
                    android.util.Log.e("MemoKing", "녹음 시작 실패", e)
                    session = null
                    listener?.invoke(JSONObject().put("type", "error").put("message", "마이크를 쓸 수 없어요 (다른 앱이 쓰는 중일 수 있어요)"))
                    finishService()
                }
            }
            ACTION_PAUSE -> session?.let {
                it.pause(true)
                refresh()
            }
            ACTION_RESUME -> session?.let {
                it.pause(false)
                refresh()
            }
            ACTION_STOP -> {
                // 알림의 "끝내기": 마무리는 따로 스레드에서, 결과는 RecordStore 에 남는다
                val s = session
                if (s != null) {
                    session = null
                    Thread {
                        val result = s.stop()
                        listener?.invoke(JSONObject().put("type", "done").put("result", result))
                        finishService()
                    }.start()
                } else finishService()
            }
        }
        return START_NOT_STICKY
    }

    private fun refresh() {
        val s = session ?: return
        listener?.invoke(JSONObject().put("type", "status").put("status", s.status()))
        try {
            getSystemService(NotificationManager::class.java)!!.notify(NOTIFY_ID, notification(s))
        } catch (e: SecurityException) {
            // 알림 권한 없음 — 녹음은 계속된다
        }
    }

    private fun finishService() {
        wake?.let { if (it.isHeld) it.release() }
        wake = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        wake?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun action(act: String, label: String, req: Int): Notification.Action {
        val pi = PendingIntent.getService(this, req, Intent(this, RecorderService::class.java).setAction(act), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(null, label, pi).build()
    }

    private fun notification(s: Session): Notification {
        val open = Intent(this, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_MEMO)
            .setData(Uri.parse("memoking://memo/" + Uri.encode(s.memoId) + "?rec=1"))
            .putExtra("memoId", s.memoId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val content = PendingIntent.getActivity(this, 7302, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val b = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_crown)
            .setColor(0xFFE5484D.toInt())
            .setContentTitle(if (s.paused) "녹음 일시 정지" else if (s.stt) "녹음·받아쓰는 중" else "녹음 중")
            .setContentText(s.lastText().ifEmpty { "눌러서 메모 열기" })
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setContentIntent(content)
            .addAction(if (s.paused) action(ACTION_RESUME, "이어서", 7303) else action(ACTION_PAUSE, "일시 정지", 7304))
            .addAction(action(ACTION_STOP, "끝내기", 7305))
        if (!s.paused) b.setUsesChronometer(true).setWhen(System.currentTimeMillis() - s.elapsedMs()).setShowWhen(true)
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build()
    }

    /** 녹음 한 번 */
    class Session(
        private val ctx: Context,
        val memoId: String,
        val stt: Boolean,
        private val engine: String,
        private val wantedStt: Boolean,
        private val terms: List<String> = emptyList(),
    ) {
        val id: String = UUID.randomUUID().toString()
        val startedAt = System.currentTimeMillis()
        private val file = File(RecordStore.dir(ctx), "$id.m4a")
        @Volatile
        var paused = false
            private set
        @Volatile
        private var running = false
        private var thread: Thread? = null
        private var samples = 0L // 녹음한(멈춘 동안 빼고) 표본 수
        private val parts = ArrayList<Transcript.Line>()
        @Volatile
        private var partial = ""
        var onChange: (() -> Unit)? = null
        private var sttError = false

        fun elapsedMs(): Long = samples * 1000 / Stt.SAMPLE_RATE

        fun text(): String = synchronized(parts) { Transcript.join(parts) }
        fun lastText(): String = synchronized(parts) { parts.lastOrNull()?.text ?: partial }

        fun status(): JSONObject = JSONObject()
            .put("active", true).put("paused", paused).put("memoId", memoId)
            .put("elapsedMs", elapsedMs()).put("stt", stt && !sttError).put("text", text()).put("partial", partial)

        fun pause(on: Boolean) {
            paused = on
        }

        @SuppressLint("MissingPermission") // start() 에서 권한을 확인했다
        fun begin() {
            val min = AudioRecord.getMinBufferSize(Stt.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val size = maxOf(min, Stt.SAMPLE_RATE / 5 * 2) // 0.2초
            // 받아쓰기에 맞춘 마이크(VOICE_RECOGNITION: 기기의 소리 꾸밈 없이 고른 소리) — 안 되는 기기는 보통 마이크로
            fun open(source: Int) = AudioRecord(source, Stt.SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, size * 2)
            var rec = open(if (stt) MediaRecorder.AudioSource.VOICE_RECOGNITION else MediaRecorder.AudioSource.MIC)
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                rec = open(MediaRecorder.AudioSource.MIC)
            }
            if (rec.state != AudioRecord.STATE_INITIALIZED) {
                rec.release()
                throw IllegalStateException("마이크를 열지 못했어요")
            }
            val encoder = AacEncoder(file, Stt.SAMPLE_RATE)
            val transcriber = if (stt) try {
                Stt.create(ctx, engine, { final, part, spk -> onText(final, part, spk) }, terms)
            } catch (e: Exception) {
                android.util.Log.w("MemoKing", "받아쓰기를 시작하지 못했어요", e)
                sttError = true
                null
            } else null
            running = true
            rec.startRecording()
            var lastTick = 0L
            thread = Thread({
                val buf = ByteArray(size)
                try {
                    while (running) {
                        val n = rec.read(buf, 0, buf.size)
                        if (n <= 0) continue
                        if (paused) continue // 멈춘 동안의 소리는 버린다
                        encoder.feed(buf, n)
                        emitLevel(buf, n)
                        try {
                            transcriber?.feed(buf, n)
                        } catch (e: Exception) {
                            if (!sttError) android.util.Log.w("MemoKing", "받아쓰기 오류", e)
                            sttError = true
                        }
                        samples += n / 2
                        val sec = samples / Stt.SAMPLE_RATE
                        if (sec != lastTick) {
                            lastTick = sec
                            if (sec % 5 == 0L) onChange?.invoke() // 5초마다 화면·알림 시간 맞추기
                        }
                    }
                } finally {
                    try {
                        rec.stop()
                    } catch (e: Exception) {
                        // 이미 멈춤
                    }
                    rec.release()
                    encoder.finish()
                    val tail = try {
                        transcriber?.finish().orEmpty()
                    } catch (e: Exception) {
                        ""
                    }
                    if (tail.isNotBlank()) synchronized(parts) { parts.add(Transcript.Line(tail)) }
                    transcriber?.close()
                }
            }, "memoking-recorder")
            thread!!.start()
        }

        private var levelAt = 0L

        /** 소리 크기(0~1)를 화면에 — 마이크가 듣고 있는지 보이게 (0.1초마다만) */
        private fun emitLevel(buf: ByteArray, n: Int) {
            val now = System.currentTimeMillis()
            if (now - levelAt < 100) return
            levelAt = now
            var sum = 0.0
            var i = 0
            while (i + 1 < n) {
                val v = ((buf[i].toInt() and 0xff) or (buf[i + 1].toInt() shl 8)).toShort() / 32768.0
                sum += v * v
                i += 2
            }
            val rms = kotlin.math.sqrt(sum / maxOf(1, n / 2))
            // dB 로 바꿔 -60dB → 0, 0dB → 1
            val level = ((20 * kotlin.math.log10(rms.coerceAtLeast(1e-6)) + 60) / 60).coerceIn(0.0, 1.0)
            RecorderService.listener?.invoke(JSONObject().put("type", "level").put("level", Math.round(level * 100) / 100.0))
        }

        private fun onText(final: String?, part: String?, speaker: Int) {
            if (!final.isNullOrBlank()) synchronized(parts) { parts.add(Transcript.Line(final, speaker)) }
            partial = part ?: ""
            RecorderService.listener?.invoke(JSONObject().put("type", "status").put("status", status()))
            if (!final.isNullOrBlank()) onChange?.invoke()
        }

        /** 녹음을 끝내고 결과를 RecordStore 에 남긴다 */
        fun stop(): JSONObject {
            running = false
            thread?.join(15_000)
            val result = JSONObject()
                .put("id", id)
                .put("memoId", memoId)
                .put("temp", "rec-$id")
                .put("name", "녹음.m4a")
                .put("mime", "audio/mp4")
                .put("size", file.length())
                .put("durationMs", elapsedMs())
                .put("startedAt", startedAt)
                .put("transcript", text())
                // 받아쓰기를 원했지만 녹음 중에는 못 했으면, 화면이 모델을 받은 뒤 파일로 다시 받아쓸 수 있다
                .put("sttPending", wantedStt && (!stt || sttError))
            RecordStore.add(ctx, result)
            return result
        }
    }
}

/** 16비트 모노 PCM → AAC-LC .m4a */
class AacEncoder(file: File, private val rate: Int, bitRate: Int = 48_000) {
    private val codec: MediaCodec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    private val muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    private var track = -1
    private var started = false
    private var written = 0L // 넣은 표본 수 (시각 계산)
    private val info = MediaCodec.BufferInfo()

    init {
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 1).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
        }
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
    }

    fun feed(pcm: ByteArray, len: Int) {
        var off = 0
        while (off < len) {
            val i = codec.dequeueInputBuffer(10_000)
            if (i >= 0) {
                val buf = codec.getInputBuffer(i)!!
                buf.clear()
                val n = minOf(buf.remaining(), len - off)
                buf.put(pcm, off, n)
                codec.queueInputBuffer(i, 0, n, written * 1_000_000 / rate, 0)
                written += n / 2
                off += n
            }
            drain(false)
        }
    }

    private fun drain(end: Boolean) {
        while (true) {
            val o = codec.dequeueOutputBuffer(info, if (end) 10_000 else 0)
            when {
                o == MediaCodec.INFO_TRY_AGAIN_LATER -> if (!end) return
                o == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    started = true
                }
                o >= 0 -> {
                    val buf = codec.getOutputBuffer(o)!!
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (info.size > 0 && started) {
                        buf.position(info.offset)
                        buf.limit(info.offset + info.size)
                        muxer.writeSampleData(track, buf, info)
                    }
                    codec.releaseOutputBuffer(o, false)
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
            }
        }
    }

    fun finish() {
        try {
            val i = codec.dequeueInputBuffer(50_000)
            if (i >= 0) codec.queueInputBuffer(i, 0, 0, written * 1_000_000 / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            drain(true)
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "녹음 파일 마무리 오류", e)
        }
        try {
            codec.stop()
        } catch (e: Exception) {
            // 무시
        }
        codec.release()
        try {
            if (started) muxer.stop()
        } catch (e: Exception) {
            android.util.Log.w("MemoKing", "녹음 파일을 닫지 못했어요", e)
        }
        muxer.release()
    }
}

/**
 * 끝난 녹음들 (files/recordings/): 소리 파일 + done.json.
 * 화면이 메모에 넣고(commitTemp 로 메모 폴더로 옮김) recordAck 하면 지운다.
 */
object RecordStore {
    fun dir(ctx: Context) = File(ctx.filesDir, "recordings").apply { mkdirs() }
    private fun list(ctx: Context) = File(dir(ctx), "done.json")

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

    /** 아직 메모에 넣지 않은 것 (소리 파일이 남아 있는 것만) */
    @Synchronized
    fun pending(ctx: Context): JSONArray {
        val out = JSONArray()
        val arr = all(ctx)
        for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            if (file(ctx, r.optString("temp"))?.isFile == true) out.put(r)
        }
        return out
    }

    @Synchronized
    fun ack(ctx: Context, id: String) {
        val arr = all(ctx)
        val keep = JSONArray()
        for (i in 0 until arr.length()) {
            val r = arr.getJSONObject(i)
            if (r.optString("id") == id) file(ctx, r.optString("temp"))?.delete() else keep.put(r)
        }
        list(ctx).writeText(keep.toString())
    }

    /** "rec-<id>" → 녹음 파일 (Temp.file 이 함께 찾는다) */
    fun file(ctx: Context, temp: String): File? {
        if (!temp.startsWith("rec-")) return null
        val id = temp.removePrefix("rec-")
        if (!Regex("[0-9a-f-]{36}").matches(id)) return null
        return File(dir(ctx), "$id.m4a")
    }
}
