package com.memoking.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 링크 미리보기는 안 네트워크 주소(공유기 · NAS · 이 휴대폰)를 받지 않는다 (PC files.rs previews_stay_off_the_local_network 와 같음) */
class HttpTest {
    @Test
    fun localAddressesAreNotPublic() {
        for (h in listOf("192.168.0.1", "127.0.0.1", "10.1.2.3", "172.16.0.5", "169.254.169.254", "[::1]", "fd00::1", "100.64.0.1", "0.0.0.0", "::ffff:192.168.0.1", "localhost")) {
            assertFalse(h, Http.publicHost(h))
        }
        assertTrue(Http.publicHost("8.8.8.8"))
        assertTrue(Http.publicHost("2606:4700::1111"))
    }
}
