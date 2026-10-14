package com.memoking.app.drive

import org.junit.Assert.assertEquals
import org.junit.Test

/** 외부 앱 메모 연동: 기본은 drive.file, 켜면 Drive 전체를 요청 (PC google-auth.js scopeFor 와 같음) */
class AuthScopeTest {
    @Test
    fun scopeFollowsTheToggle() {
        assertEquals("https://www.googleapis.com/auth/drive.file", GoogleAuth.scopeFor(false))
        assertEquals("https://www.googleapis.com/auth/drive", GoogleAuth.scopeFor(true))
        assertEquals(GoogleAuth.SCOPE, GoogleAuth.scopeFor(false))
        assertEquals(GoogleAuth.FULL_SCOPE, GoogleAuth.scopeFor(true))
    }
}
