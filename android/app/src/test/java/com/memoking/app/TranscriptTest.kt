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
    fun 조각을_문단으로() {
        val text = Transcript.join(listOf("하나입니다", "둘이에요", "", "셋인가요", "넷이죠", "다섯"), perParagraph = 4)
        assertEquals("하나입니다. 둘이에요. 셋인가요? 넷이죠.\n\n다섯", text)
    }
}
