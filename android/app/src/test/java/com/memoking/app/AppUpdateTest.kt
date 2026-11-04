package com.memoking.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** 앱 안 업데이트의 판단 규칙 (규칙은 app/js/core/app-update.js 와 같음 — tests/app-update.test.js) */
class AppUpdateTest {
    @Test
    fun newerOnlyWhenVersionCodeIsLarger() {
        assertTrue(AppUpdate.isNewer(109, 110))
        assertFalse(AppUpdate.isNewer(110, 110))
        assertFalse(AppUpdate.isNewer(110, 109))
    }

    @Test
    fun downloadsOnlyFromOurReleaseRepo() {
        val ok = "https://github.com/lmg6983-dotcom/MemoKing/releases/download/android/MemoKing-android.apk"
        assertTrue(AppUpdate.trustedApkUrl(ok))
        assertFalse("다른 저장소", AppUpdate.trustedApkUrl("https://github.com/someone/else/releases/download/android/MemoKing-android.apk"))
        assertFalse("http", AppUpdate.trustedApkUrl(ok.replace("https", "http")))
        assertFalse("apk 가 아님", AppUpdate.trustedApkUrl(ok.removeSuffix(".apk") + ".zip"))
        assertFalse("상위 폴더", AppUpdate.trustedApkUrl("https://github.com/lmg6983-dotcom/MemoKing/releases/download/../x.apk"))
    }

    @Test
    fun sha256OfAFile() {
        val file = File.createTempFile("mkup", ".apk")
        try {
            file.writeText("abc")
            assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", AppUpdate.sha256(file))
        } finally {
            file.delete()
        }
    }

    @Test
    fun installerResultToHint() {
        assertEquals(null, AppUpdate.failStatus(ok = true, canceled = false, installResult = 1))
        assertEquals("취소", 3, AppUpdate.failStatus(ok = false, canceled = true, installResult = 0))
        assertEquals("서명 다름", 7, AppUpdate.failStatus(ok = false, canceled = false, installResult = -7))
        assertEquals("공간 부족", 6, AppUpdate.failStatus(ok = false, canceled = false, installResult = -4))
        assertEquals("그 밖", 1, AppUpdate.failStatus(ok = false, canceled = false, installResult = -110))
    }
}
