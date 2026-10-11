package com.memoking.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 위젯에서 체크: 파일의 i 번째 할 일 (규칙은 app/js/core/widget-lines.js 와 같음 — tests/widget-lines.test.js) */
class WidgetToggleTest {
    private val memo = "---\nid: a\ntitle: 장보기\n---\n# 장보기\n\n- [ ] 우유\n- [x] **빵**\n\n```\n- [ ] 코드 안은 할 일 아님\n```\n1. [ ] 달걀\n* [X] 김"

    @Test
    fun togglesTheNthTask() {
        assertEquals(memo.replace("- [ ] 우유", "- [x] 우유"), Widgets.toggleTaskText(memo, 0))
        assertEquals(memo.replace("- [x] **빵**", "- [ ] **빵**"), Widgets.toggleTaskText(memo, 1))
        assertEquals("코드 블록 안은 세지 않는다", memo.replace("1. [ ] 달걀", "1. [x] 달걀"), Widgets.toggleTaskText(memo, 2))
        assertEquals(memo.replace("* [X] 김", "* [ ] 김"), Widgets.toggleTaskText(memo, 3))
    }

    @Test
    fun leavesFrontmatterAlone() {
        val withTaskInMeta = "---\nnote: \"- [ ] 머리말\"\n---\n- [ ] 본문"
        assertEquals("---\nnote: \"- [ ] 머리말\"\n---\n- [x] 본문", Widgets.toggleTaskText(withTaskInMeta, 0))
    }

    @Test
    fun missingTaskIsNull() {
        assertNull(Widgets.toggleTaskText(memo, 9))
    }

    @Test
    fun findsTheSameTaskAfterReorder() {
        // 위젯은 [A, B] 를 보고 있는데 PC 에서 순서가 [B, A] 로 바뀜 → 위젯의 B(1번)를 누르면 파일의 B 가 체크
        val reordered = "- [ ] B\n- [ ] A"
        assertEquals("- [x] B\n- [ ] A", Widgets.toggleTaskText(reordered, 1, "B", false))
        assertEquals("같은 자리면 그대로", "- [ ] B\n- [x] A", Widgets.toggleTaskText(reordered, 1, "A", false))
        assertNull("그 할 일이 없어졌으면 아무것도 바꾸지 않음", Widgets.toggleTaskText(reordered, 0, "C", false))
    }

    @Test
    fun setsTheOppositeOfWhatTheWidgetShowed() {
        // 위젯에는 안 끝낸 할 일로 보였는데 파일에선 이미 체크됨 → 누르면 체크된 채로 (풀어 버리지 않음)
        assertEquals("- [x] 우유", Widgets.toggleTaskText("- [x] 우유", 0, "우유", false))
        assertEquals("- [ ] 우유", Widgets.toggleTaskText("- [x] 우유", 0, "우유", true))
    }

    @Test
    fun stampsUpdatedAndDevice() {
        val text = "---\nid: a\nupdated: 2026-10-01T09:00:00+09:00\ndevice: pc\n---\n- [x] 우유"
        assertEquals("---\nid: a\nupdated: 2026-10-11T10:00:00+09:00\ndevice: phone\n---\n- [x] 우유", Widgets.stampEdit(text, "2026-10-11T10:00:00+09:00"))
        assertEquals("---\nid: a\nupdated: N\ndevice: phone\n---\nx", Widgets.stampEdit("---\nid: a\nupdated: O\n---\nx", "N"))
        assertEquals("머리말 없음", "- [ ] a", Widgets.stampEdit("- [ ] a", "N"))
    }

    @Test
    fun stampKeepsCrlf() {
        assertEquals("---\r\nid: a\r\nupdated: N\r\ndevice: phone\r\n---\r\nx", Widgets.stampEdit("---\r\nid: a\r\nupdated: O\r\n---\r\nx", "N"))
    }
}
