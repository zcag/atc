package io.github.zcag.atc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.assertNull
import org.junit.Test

class PairingTest {
    @Test
    fun onlyLocalPathsOpen() {
        assertTrue(Pairing.isLocalPath(MainActivity.HOLD))
        assertTrue(Pairing.isLocalPath("/#/p/@reports/summary#intro"))
        for (bad in listOf("@evil.com", ".evil.com/", "//evil.com", "/\\evil.com", "https://evil.com", "")) {
            assertFalse(bad, Pairing.isLocalPath(bad))
        }
    }

    private val fp = "ab".repeat(32)

    @Test fun readsWhatTheServerWrites() {
        assertEquals(
            Pairing("https://atc.example:8443", "qfo5irvto2zxozwjwhnpsk2ejy", fp),
            Pairing.parse("atc://pair?ca=$fp&code=qfo5irvto2zxozwjwhnpsk2ejy&url=https%3A%2F%2Fatc.example%3A8443"),
        )
    }

    @Test fun caIsOptionalAndCaseFree() {
        assertEquals(Pairing("http://desktop:7272", "abcdefgh", null), Pairing.parse(" atc://pair?url=http%3A%2F%2Fdesktop%3A7272&code=abcdefgh\n"))
        assertEquals(fp, Pairing.parse("atc://pair?url=http%3A%2F%2Fm&code=abcdefgh&ca=${fp.uppercase()}")?.ca)
        assertEquals("m", Pairing.parse("atc://pair?url=http%3A%2F%2Fm%2F&code=abcdefgh")?.host)
    }

    @Test fun refusesWhatIsNotAPairing() {
        listOf(
            "", "not a url", "https://atc.example", "atc://open?path=/", "http://pair?url=http%3A%2F%2Fm&code=abcdefgh",
            "atc://pair?code=abcdefgh",
            "atc://pair?url=http%3A%2F%2Fm",
            "atc://pair?url=http%3A%2F%2Fm&code=short",
            "atc://pair?url=http%3A%2F%2Fm&code=has%20space1",
            "atc://pair?url=http%3A%2F%2Fm&code=abcdefgh&ca=nothex",
            "atc://pair?url=http%3A%2F%2Fm&code=abcdefgh&ca=$fp$fp",
            "atc://pair?url=javascript%3Aalert(1)&code=abcdefgh",
            "atc://pair?url=file%3A%2F%2F%2Fdata&code=abcdefgh",
            "atc://pair?url=https%3A%2F%2Fme%40evil.example&code=abcdefgh",
            "atc://pair?url=https%3A%2F%2Fm%3Fx%3D1&code=abcdefgh",
            "atc://pair?url=https%3A%2F%2Fm&url=https%3A%2F%2Fevil&code=abcdefgh",
            "atc://pair?url=https%3A%2F%2Fm&code=abc%ZZdefgh",
        ).forEach { assertNull(it, Pairing.parse(it)) }
    }

    @Test fun openLinksStayOnTheServer() {
        assertEquals("/#/s/abc", Pairing.openPath("atc://open?path=%2F%23%2Fs%2Fabc"))
        assertEquals("/", Pairing.openPath("atc://open"))
        assertNull(Pairing.openPath("atc://open?path=@evil.example"))
        assertNull(Pairing.openPath("atc://open?path=//evil.example"))
        assertNull(Pairing.openPath("atc://open?path=%2F%5Cevil.example"))
        assertNull(Pairing.openPath("atc://pair?path=/"))
    }
}
