package com.memoking.app

import org.junit.Assert.assertEquals
import org.junit.Test

class TranscriptTest {
    @Test
    fun 문장부호를_붙인다() {
        assertEquals("회의를 시작하겠습니다.", Transcript.punctuate("회의를 시작하겠습니다"))
        assertEquals("다음 주에 할까요?", Transcript.punctuate("다음 주에 할까요"))
        assertEquals("이미 있어요!", Transcript.punctuate("이미 있어요!"))
        assertEquals("사과 배 감", Transcript.punctuate("사과 배 감"))
    }

    @Test
    fun 문장마다_줄을_바꾼다() {
        val text = Transcript.joinText(listOf("하나입니다", "둘이에요", "", "셋인가요"))
        assertEquals("하나입니다.\n둘이에요.\n셋인가요?", text)
    }

    @Test
    fun 말한_사람이_바뀌면_표시한다() {
        val text = Transcript.join(listOf(
            Transcript.Line("안녕하세요", 1),
            Transcript.Line("오늘 안건입니다", 1),
            Transcript.Line("네 좋아요", 2),
            Transcript.Line("음", 0),
            Transcript.Line("시작하죠", 1),
        ))
        assertEquals("화자 1: 안녕하세요.\n오늘 안건입니다.\n화자 2: 네 좋아요.\n음\n화자 1: 시작하죠.", text)
        // 한 사람뿐이면 표시 없이 줄만
        assertEquals("안녕하세요.\n네.", Transcript.join(listOf(Transcript.Line("안녕하세요", 1), Transcript.Line("네", 1))))
    }

    @Test
    fun 목소리_특징으로_사람을_나눈다() {
        val t = SpeakerTracker()
        val a = FloatArray(8) { if (it < 4) 1f else 0.1f }
        val b = FloatArray(8) { if (it >= 4) 1f else 0.1f }
        assertEquals(1, t.assign(a, 200))
        assertEquals(2, t.assign(b, 200))
        assertEquals(1, t.assign(FloatArray(8) { if (it < 4) 0.9f else 0.2f }, 200))
        assertEquals(1, t.assign(b, 20)) // 아주 짧은 말은 앞사람으로
        assertEquals(2, t.assign(b, 200))
        assertEquals(0, t.assign(null, 0))
    }
}
