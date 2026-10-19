package com.memoking.app

import java.io.InputStream

/**
 * 소리·동영상의 Range(일부분) 요청에 내어 주는 스트림: 파일의 start..end 만 읽힌다.
 *
 * WebView 는 Range 요청이면 앱이 준 스트림을 스스로 start 만큼 건너뛴다(skip) — available() 을 전체 크기로 알고.
 *   예전처럼 미리 start 로 옮긴 스트림을 주면 두 번 건너뛰어 엉뚱한 자리를 읽거나(소리·영상이 깨짐)
 *   "범위가 맞지 않음"으로 끊겨, 끝에 목차(moov)가 있는 폰 녹음·동영상은 전혀 재생되지 않았다.
 * 그래서 파일 처음 자리부터 센다: WebView 가 건너뛰었으면 그 자리에서, 안 건너뛰었으면(다른 판) 처음 읽을 때 start 로 옮긴다.
 */
class RangeStream(private val input: InputStream, private val start: Long, private val end: Long) : InputStream() {
    private var pos = 0L // 파일에서 읽을 자리 (아직 실제로 옮기지 않았을 수 있다)
    private var real = 0L // input 이 실제로 있는 자리

    /** 실제 자리를 pos 로 (못 가면 false — 파일이 그새 짧아짐) */
    private fun ready(): Boolean {
        if (pos < start) pos = start
        while (real < pos) {
            val n = input.skip(pos - real)
            if (n > 0) {
                real += n
            } else {
                if (input.read() < 0) return false
                real++
            }
        }
        return pos <= end
    }

    override fun skip(n: Long): Long {
        if (n <= 0) return 0
        val k = minOf(n, end + 1 - pos).coerceAtLeast(0)
        pos += k
        return k
    }

    override fun available(): Int = (end + 1 - pos).coerceIn(0, Int.MAX_VALUE.toLong()).toInt()

    override fun read(): Int {
        val one = ByteArray(1)
        return if (read(one, 0, 1) <= 0) -1 else one[0].toInt() and 0xff
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (len == 0) return 0
        if (!ready()) return -1
        val n = input.read(b, off, minOf(len.toLong(), end + 1 - pos).toInt())
        if (n > 0) {
            pos += n
            real += n
        }
        return n
    }

    override fun close() = input.close()

    companion object {
        /** "bytes=a-b" → 파일의 start..end (못 읽는 모양이면 null = 전체, 범위 밖이면 빈 범위) */
        fun parse(header: String?, size: Long): LongRange? {
            val m = header?.let { Regex("""^\s*bytes=(\d*)-(\d*)\s*$""").find(it) } ?: return null
            val (a, b) = m.destructured
            if (a.isEmpty() && b.isEmpty()) return null
            val start = if (a.isEmpty()) maxOf(0, size - (b.toLongOrNull() ?: 0)) else a.toLongOrNull() ?: return null
            val end = if (a.isEmpty() || b.isEmpty()) size - 1 else minOf(b.toLongOrNull() ?: (size - 1), size - 1)
            return start..end
        }
    }
}
