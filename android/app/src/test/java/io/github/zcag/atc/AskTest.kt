package io.github.zcag.atc

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AskTest {
    private fun ask(json: String) = Ask.parse(JSONObject(json))!!

    @Test fun permissionIsAllowOnceDenyOpenNeverAlways() {
        val a = ask("""{"sid":"s1","id":"claude","key":"abc","tool":"Bash","cmd":"bundle exec rspec"}""")
        assertEquals("Wants to run bundle exec rspec", a.says())
        val c = a.choices()
        assertEquals(listOf("1 Allow once", "3 Deny", "Open"), c.map { it.button })
        assertTrue(c[0].unlock)
        assertFalse(c[1].unlock)
        assertTrue(c[2].open)
        assertEquals("once", JSONObject(c[0].body).getString("reply"))
        assertTrue(JSONObject(c[1].body).getBoolean("reject"))
        assertTrue(c.none { it.label.contains("Always") })
    }

    @Test fun questionOptionsAreNumbered() {
        val a = ask("""{"sid":"s1","id":"claude","key":"k","text":"Back closes?","options":["Close the dialog","Go back a screen"]}""")
        val c = a.choices()
        assertEquals(listOf("1 Close the dialog", "2 Go back a screen"), c.map { it.button })
        assertEquals("""{"answers":[["Go back a screen"]]}""", c[1].body)
        assertTrue(c.none { it.unlock })
    }

    @Test fun tooManyOptionsLeaveRoomForOpen() {
        val a = ask("""{"sid":"s1","id":"x","key":"k","text":"Which?","options":["a","b","c","d"]}""")
        assertEquals(listOf("1 a", "2 b", "Open"), a.choices().map { it.button })
        assertEquals(listOf("Open"), ask("""{"sid":"s1","id":"x","key":"k","text":"Two questions"}""").choices().map { it.button })
    }

    @Test fun urlSaysWhereFromAndWhichAsk() {
        val a = ask("""{"sid":"s 1","id":"claude","key":"abc","host":"laptop","text":"?"}""")
        assertEquals("https://atc.example.com/api/sessions/s+1/asks/claude?via=push&key=abc&host=laptop", a.url("https://atc.example.com", "push"))
        val again = Ask.parse(a.json())!!
        assertEquals(a.url("x", "widget"), again.url("x", "widget"))
    }

    @Test fun incompleteAsksAreDropped() {
        assertNull(Ask.parse(JSONObject("""{"id":"claude"}""")))
        assertNull(Ask.parse("not json"))
    }

    @Test fun outwardRepliesNeedTheUnlock() {
        listOf("Merge", "merge it", "Publish the APK", "Send the email", "push to origin", "Deploy").forEach { assertTrue(it, outward(it)) }
        listOf("Keep both", "why stale?", "clear it", "Close the dialog").forEach { assertFalse(it, outward(it)) }
    }

    @Test fun noteCarriesTheAskAndBay() {
        val raw = """{"title":"Q","body":"Back closes?","tag":"s1","url":"/#/s/s1","bay":"atc","ask":{"sid":"s1","id":"claude","key":"k","text":"Back closes?","options":["a"]}}"""
        val n = Note.parse(raw.toByteArray())!!
        assertEquals("atc", n.bay)
        assertEquals("k", n.ask!!.key)
        assertEquals(raw, n.raw)
        assertNull(Note.parse("""{"title":"x"}""".toByteArray())!!.ask)
    }
}
