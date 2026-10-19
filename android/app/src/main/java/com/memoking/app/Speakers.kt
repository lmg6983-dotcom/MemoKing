package com.memoking.app

import android.content.Context
import android.os.Build
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 화자 구분 — 받아쓴 문장마다 "누가 말했나"를 목소리로 나눠 "화자 1·2" 이름표를 붙인다.
 *  - 목소리 특징: sherpa-onnx(Apache-2.0) + CAM++ 화자 모델(3D-Speaker, 약 28MB, 켤 때 한 번 받음). 인터넷 없이 휴대폰 안에서.
 *  - 녹음하는 동안 문장이 하나 끝날 때마다 그 문장 소리(최대 12초)의 특징만 남기고(소리는 버림),
 *    녹음이 끝나면 모든 문장을 한꺼번에 견주어 묶는다 — 처음 몇 문장에서 잘못 나눈 것이 끝까지 남지 않게.
 *  - 1.5초보다 짧은 말("네", "음")은 목소리로 가리기 어려워 앞사람으로 둔다.
 */
object SpeakerModel {
    private const val NAME = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
    private const val URL_MODEL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/$NAME"
    private const val SHA256 = "aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2"
    private const val PREFS = "speakers"
    const val SIZE_LABEL = "약 28MB"

    /** 받는 중이면 0~100, 아니면 -1 */
    @Volatile
    var progress = -1
        private set

    private fun file(ctx: Context) = File(File(ctx.filesDir, "speaker"), NAME)

    /** 이 휴대폰에서 돌릴 수 있나 (앱에 넣은 엔진은 ARM 용만) */
    fun supported() = Build.SUPPORTED_ABIS.any { it == "arm64-v8a" || it == "armeabi-v7a" }

    fun ready(ctx: Context) = file(ctx).isFile
    fun on(ctx: Context) = supported() && ready(ctx) && ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false)
    fun setOn(ctx: Context, on: Boolean) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply()

    fun delete(ctx: Context) {
        setOn(ctx, false)
        File(ctx.filesDir, "speaker").deleteRecursively()
    }

    /** 모델 받기 (GitHub 릴리스 → 앱 저장 공간). 오래 걸리므로 백그라운드 스레드에서 */
    @Synchronized
    fun download(ctx: Context, onProgress: (Int) -> Unit) {
        if (ready(ctx)) return
        val dest = file(ctx).apply { parentFile?.mkdirs() }
        val part = File(dest.parentFile, "$NAME.part")
        progress = 0
        onProgress(0)
        try {
            var conn = URL(URL_MODEL).openConnection() as HttpURLConnection
            for (i in 0 until 5) { // GitHub 는 실제 파일 주소로 넘겨준다(리다이렉트)
                conn.instanceFollowRedirects = true
                conn.connectTimeout = 20_000
                conn.readTimeout = 30_000
                val code = conn.responseCode
                if (code in 300..399) {
                    val next = conn.getHeaderField("Location") ?: break
                    conn.disconnect()
                    conn = URL(URL(URL_MODEL), next).openConnection() as HttpURLConnection
                    continue
                }
                if (code != 200) throw IOException("다운로드하지 못했어요. 잠시 후 다시 시도해 주세요")
                break
            }
            val total = conn.contentLengthLong
            val sha = MessageDigest.getInstance("SHA-256")
            conn.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var last = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        sha.update(buf, 0, n)
                        done += n
                        val p = if (total > 0) (done * 99 / total).toInt() else 0
                        if (p != last) {
                            last = p
                            progress = p
                            onProgress(p)
                        }
                    }
                }
            }
            conn.disconnect()
            val got = sha.digest().joinToString("") { "%02x".format(it) }
            if (got != SHA256) throw IOException("받은 파일이 깨졌어요. 다시 시도해 주세요")
            if (!part.renameTo(dest)) throw IOException("저장하지 못했어요. 저장 공간을 확인하고 다시 해 주세요")
            onProgress(100)
        } finally {
            part.delete()
            progress = -1
        }
    }

    fun load(ctx: Context): SpeakerEmbeddingExtractor =
        SpeakerEmbeddingExtractor(null, SpeakerEmbeddingExtractorConfig(model = file(ctx).absolutePath, numThreads = 2, debug = false, provider = "cpu"))
}

/**
 * 녹음하며 문장마다 목소리 특징을 모아 두었다가, 끝에 한꺼번에 묶어 문장별 화자 번호를 낸다.
 *  feed(): 녹음 스레드 · mark(): 받아쓴 문장이 끝났을 때 (다른 스레드) · finish(): 녹음이 끝난 뒤 한 번
 */
class SpeakerLabeler(private val extractor: SpeakerEmbeddingExtractor, private val rate: Int = Stt.SAMPLE_RATE) {
    private val ring = ShortArray(rate * MAX_SECONDS)
    private var total = 0L // 지금까지 받은 표본 수
    private var marked = 0L // 앞 문장이 끝난 자리
    private val vectors = ArrayList<FloatArray?>()
    private val worker = Executors.newSingleThreadExecutor()

    @Synchronized
    fun feed(pcm: ByteArray, len: Int) {
        var i = 0
        while (i + 1 < len) {
            ring[(total % ring.size).toInt()] = ((pcm[i].toInt() and 0xff) or (pcm[i + 1].toInt() shl 8)).toShort()
            total++
            i += 2
        }
    }

    /** 문장 하나가 끝남 → 그 문장 소리(앞 문장 끝부터, 최대 12초)의 목소리 특징을 뒤에서 계산 */
    fun mark() {
        val samples: FloatArray?
        synchronized(this) {
            val n = (total - marked).coerceAtMost(ring.size.toLong()).toInt()
            samples = if (n >= rate * MIN_SECONDS) FloatArray(n) { ring[((total - n + it) % ring.size).toInt()] / 32768f } else null
            marked = total
        }
        val slot = synchronized(vectors) { vectors.add(null); vectors.size - 1 }
        if (samples == null) return
        worker.execute {
            val v = try {
                val s = extractor.createStream()
                s.acceptWaveform(samples, rate)
                s.inputFinished()
                val out = if (extractor.isReady(s)) extractor.compute(s) else null
                s.release()
                out
            } catch (e: Exception) {
                null
            }
            synchronized(vectors) { vectors[slot] = v }
        }
    }

    /** 문장 순서대로 화자 번호(1부터, 모르면 0). 한 사람뿐이면 모두 0 */
    fun finish(): IntArray {
        worker.shutdown()
        worker.awaitTermination(60, TimeUnit.SECONDS)
        val list = synchronized(vectors) { ArrayList(vectors) }
        extractor.release()
        return SpeakerClustering.label(list)
    }

    fun close() {
        worker.shutdownNow()
    }

    companion object {
        const val MAX_SECONDS = 12
        const val MIN_SECONDS = 1.5
    }
}

/** 목소리 특징 묶기 (안드로이드 없이 단위 테스트) */
object SpeakerClustering {
    /** 두 사람을 같은 사람으로 볼 닮음(코사인)의 하한 — 공개 대화 녹음으로 맞춤 */
    const val THRESHOLD = 0.4f
    const val MAX_SPEAKERS = 6

    /**
     * 평균 연결 응집 군집: 가장 닮은 두 묶음을 합치기를 닮음이 THRESHOLD 아래가 될 때까지 (사람이 MAX_SPEAKERS 보다 많으면 더 합침).
     * 번호는 처음 말한 차례대로. 특징 없는 문장(짧은 말)은 0 → 글로 옮길 때 앞사람으로.
     */
    fun label(vectors: List<FloatArray?>): IntArray {
        val idx = vectors.indices.filter { vectors[it] != null }
        val out = IntArray(vectors.size)
        if (idx.size < 2) return out
        val v = idx.map { unit(vectors[it]!!) }
        // 긴 녹음(문장이 아주 많음)은 먼저 아주 닮은 것끼리 작은 묶음으로 (계산을 가볍게)
        val groups = ArrayList<MutableList<Int>>()
        if (v.size > 200) {
            val cents = ArrayList<FloatArray>()
            for (i in v.indices) {
                var best = -1
                var bestSim = 0.7f
                for (g in cents.indices) dot(v[i], cents[g]).let { if (it > bestSim) { bestSim = it; best = g } }
                if (best < 0) { cents.add(v[i].copyOf()); groups.add(mutableListOf(i)) } else groups[best].add(i)
            }
        } else v.indices.forEach { groups.add(mutableListOf(it)) }
        val sim = Array(v.size) { a -> FloatArray(v.size) { b -> dot(v[a], v[b]) } }
        fun link(a: List<Int>, b: List<Int>): Float {
            var s = 0f
            for (i in a) for (j in b) s += sim[i][j]
            return s / (a.size * b.size)
        }
        val n = groups.size
        val L = Array(n) { a -> FloatArray(n) { b -> if (a == b) -2f else link(groups[a], groups[b]) } }
        val alive = BooleanArray(n) { true }
        var count = n
        while (count > 1) {
            var best = -2f
            var ba = -1
            var bb = -1
            for (a in 0 until n) if (alive[a]) for (b in a + 1 until n) if (alive[b] && L[a][b] > best) { best = L[a][b]; ba = a; bb = b }
            if (best < THRESHOLD && count <= MAX_SPEAKERS) break
            // bb 를 ba 에 합치고 ba 와 다른 묶음의 평균 연결을 크기 가중으로 갱신
            val na = groups[ba].size.toFloat()
            val nb = groups[bb].size.toFloat()
            for (c in 0 until n) if (alive[c] && c != ba && c != bb) {
                val s = (L[ba][c] * na + L[bb][c] * nb) / (na + nb)
                L[ba][c] = s
                L[c][ba] = s
            }
            groups[ba].addAll(groups[bb])
            alive[bb] = false
            count--
        }
        val members = (0 until n).filter { alive[it] }.map { groups[it] }
        if (members.size < 2) return out
        // 번호는 처음 말한 차례대로
        members.sortedBy { it.min() }.forEachIndexed { k, g -> for (i in g) out[idx[i]] = k + 1 }
        return out
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
