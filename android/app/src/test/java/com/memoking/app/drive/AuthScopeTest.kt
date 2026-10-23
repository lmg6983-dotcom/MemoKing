package com.memoking.app.drive

import org.junit.Assert.assertEquals
import org.junit.Test

/** 권한: 메모킹이 만든 파일만(drive.file) 요청한다 — Drive 전체는 요청하지 않음 (PC google-auth.js 와 같음) */
class AuthScopeTest {
    @Test
    fun requestsOnlyDriveFile() {
        assertEquals("https://www.googleapis.com/auth/drive.file", GoogleAuth.SCOPE)
    }
}
