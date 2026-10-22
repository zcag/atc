package io.github.zcag.atc

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FeedTest {
    private val json = """{"type":"sessions","at":"2026-10-23T10:00:00.123456789Z","sessions":[
        {"id":"a1","sid":"s-1","title":"api","state":"needs-you","host":"box","pinned":true,"since":"2026-10-23T09:57:00Z"},
        {"sid":"s-2","title":"","state":"your-turn","host":"box","since":"2026-10-23T12:50:00+03:00"},
        {"id":"c3","sid":"s-3","title":"web","state":"working","host":"lap"},
        {"id":"d4","sid":"s-4","title":"docs","state":"needs-you","host":"box","since":"2026-10-23T09:59:30Z"}]}"""
    private val at = java.time.Instant.parse("2026-10-23T10:00:00.123Z").toEpochMilli()

    @Test fun parses() {
        val f = Feed.parse(json)!!
        assertEquals(at, f.at)
        assertEquals(4, f.sessions.size)
        val (a, b, c) = f.sessions
        assertEquals("a1", a.key)
        assertTrue(a.pinned)
        assertEquals("s-2", b.key)
        assertNull(b.id)
        assertEquals("s-2", b.title)
        assertEquals(0L, c.since)
        assertEquals(java.time.Instant.parse("2026-10-23T09:50:00Z").toEpochMilli(), b.since)
    }

    @Test fun rejectsAlertsAndJunk() {
        assertNull(Feed.parse("""{"title":"api","body":"done","tag":"s1","url":"/#/s/s1"}"""))
        assertNull(Feed.parse("not json"))
        assertNull(Feed.parse(null))
        assertNull(Feed.parse("""{"type":"sessions","sessions":[{"title":"no sid"}]}"""))
    }

    @Test fun summary() {
        val f = Feed.parse(json)!!
        assertEquals("2 need you · 1 your turn · 1 working", f.summary())
        assertEquals("2 need you", f.urgent())
        assertEquals("2 need you · 2 more", f.brief())
        val one = Feed.parse("""{"type":"sessions","sessions":[{"sid":"x","state":"needs-you"},{"sid":"y","state":"working"}]}""")!!
        assertEquals("1 needs you · 1 working", one.summary())
        val quiet = Feed.parse("""{"type":"sessions","sessions":[]}""")!!
        assertEquals("All quiet", quiet.summary())
        assertEquals("All quiet", quiet.brief())
        assertEquals("1 working", Feed.parse("""{"type":"sessions","sessions":[{"sid":"y","state":"working"}]}""")!!.brief())
        assertNull(quiet.urgent())
    }

    @Test fun hostsAndTargets() {
        val f = Feed.parse(json)!!
        assertTrue(f.multiHost)
        assertFalse(Feed.parse("""{"type":"sessions","sessions":[{"sid":"x","state":"working","host":"a"},{"sid":"y","state":"working"}]}""")!!.multiHost)
        assertEquals(listOf("s-1" to "api", "s-3" to "web", "s-4" to "docs"), f.targets())
    }

    @Test fun detail() {
        val (a, b, c, d) = Feed.parse(json)!!.sessions
        assertEquals("needs you · 3m", a.detail(at))
        assertEquals("your turn · 10m", b.detail(at))
        assertEquals("working", c.detail(at))
        assertEquals("needs you · now", d.detail(at))
    }

    @Test fun elapsedTimes() {
        assertEquals("now", elapsed(-5_000))
        assertEquals("now", elapsed(59_000))
        assertEquals("1m", elapsed(60_000))
        assertEquals("59m", elapsed(3_599_000))
        assertEquals("1h", elapsed(3_600_000))
        assertEquals("47h", elapsed(47 * 3_600_000L))
        assertEquals("2d", elapsed(48 * 3_600_000L))
    }
}
