package com.memoking.app

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class SpeakerClusteringTest {
    // 사람마다 한 방향 + 문장마다 조금씩 흔들림 (같은 사람끼리 닮음 0.8 안팎, 다른 사람과는 0.25 안팎)
    private fun voice(who: Int, wobble: Int): FloatArray {
        val v = FloatArray(8) { 0.1f }
        v[who] = 1f
        v[(who + 1 + wobble) % 8] += 0.5f
        return v
    }

    @Test
    fun 두_사람을_나누고_처음_말한_차례로_번호() {
        val labels = SpeakerClustering.label(listOf(voice(3, 0), voice(5, 1), voice(3, 2), voice(5, 3), voice(3, 4)))
        assertArrayEquals(intArrayOf(1, 2, 1, 2, 1), labels)
    }

    @Test
    fun 짧은_말은_0_으로_남겨_앞사람으로() {
        val labels = SpeakerClustering.label(listOf(voice(0, 0), null, voice(4, 1), null))
        assertArrayEquals(intArrayOf(1, 0, 2, 0), labels)
        val text = Transcript.join(listOf("안녕하세요", "네", "반가워요", "음").mapIndexed { i, t -> Transcript.Line(t, labels[i]) })
        assertEquals("화자 1: 안녕하세요.\n네.\n화자 2: 반가워요.\n음", text)
    }

    @Test
    fun 한_사람뿐이면_이름표_없음() {
        assertArrayEquals(intArrayOf(0, 0, 0), SpeakerClustering.label(listOf(voice(2, 0), voice(2, 1), voice(2, 2))))
        assertArrayEquals(intArrayOf(0), SpeakerClustering.label(listOf(voice(2, 0))))
    }

    @Test
    fun 끝난_뒤_번호를_문장에_붙임() {
        val parts = mutableListOf(Transcript.Line("하나"), Transcript.Line("둘"), Transcript.Line("셋"))
        Transcript.relabel(parts, intArrayOf(1, 2))
        assertEquals(listOf(1, 2, 0), parts.map { it.speaker })
        Transcript.relabel(parts, null) // 화자 구분을 안 쓰면 그대로
        assertEquals(listOf(1, 2, 0), parts.map { it.speaker })
    }
}
