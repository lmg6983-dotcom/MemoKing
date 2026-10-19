package com.memoking.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.ByteArrayInputStream

/** 소리·동영상 Range 응답: WebView 가 스스로 건너뛰든(지금 판) 안 건너뛰든 같은 바이트가 나와야 한다 */
class RangeStreamTest {
    private val file = ByteArray(10_000) { (it * 7 % 251).toByte() }

    private fun stream(start: Long, end: Long) = RangeStream(ByteArrayInputStream(file), start, end)

    // WebView(android_webview InputStreamReader)가 하는 그대로: available() 로 크기 → 범위 확인 → start 만큼 skip → 읽기
    private fun readLikeWebView(s: RangeStream, start: Long, end: Long): ByteArray {
        val size = s.available()
        require(start < size && end < size) { "범위가 맞지 않음" }
        var left = start
        while (left > 0) {
            val n = s.skip(left)
            require(n > 0) { "건너뛰지 못함" }
            left -= n
        }
        return s.readBytes()
    }

    @Test
    fun webViewSkipsItself() {
        // 끝에 목차(moov)가 있는 동영상: 맨 끝 부분 요청
        assertArrayEquals(file.copyOfRange(9_000, 10_000), readLikeWebView(stream(9_000, 9_999), 9_000, 9_999))
        assertArrayEquals(file.copyOfRange(1_234, 5_679), readLikeWebView(stream(1_234, 5_678), 1_234, 5_678))
    }

    @Test
    fun webViewDoesNotSkip() {
        assertArrayEquals(file.copyOfRange(9_000, 10_000), stream(9_000, 9_999).readBytes())
        assertArrayEquals(file.copyOfRange(0, 100), stream(0, 99).readBytes())
    }

    @Test
    fun singleByteReads() {
        val s = stream(10, 12)
        assertEquals(file[10].toInt() and 0xff, s.read())
        assertEquals(file[11].toInt() and 0xff, s.read())
        assertEquals(file[12].toInt() and 0xff, s.read())
        assertEquals(-1, s.read())
    }

    @Test
    fun shorterFileEndsCleanly() {
        val s = RangeStream(ByteArrayInputStream(file.copyOf(50)), 100, 199)
        assertEquals(-1, s.read(ByteArray(10), 0, 10))
    }

    @Test
    fun parsesRangeHeader() {
        assertEquals(0L..9_999L, RangeStream.parse("bytes=0-", 10_000))
        assertEquals(9_000L..9_999L, RangeStream.parse("bytes=9000-", 10_000))
        assertEquals(100L..199L, RangeStream.parse("bytes=100-199", 10_000))
        assertEquals(9_500L..9_999L, RangeStream.parse("bytes=-500", 10_000))
        assertEquals("끝을 넘으면 파일 끝까지", 9_000L..9_999L, RangeStream.parse("bytes=9000-20000", 10_000))
        assertNull(RangeStream.parse(null, 10_000))
        assertNull(RangeStream.parse("bytes=-", 10_000))
        assertNull("여러 범위는 전체로", RangeStream.parse("bytes=0-1,5-6", 10_000))
    }
}
