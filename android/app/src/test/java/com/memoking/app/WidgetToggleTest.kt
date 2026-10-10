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
}
