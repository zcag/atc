#!/usr/bin/env python3
"""--stop-words: their stop words count even when delta has just said a word like them, a run of delta's own words in
its order is still echo, and without the flag nothing changes."""
import os, sys, unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_press import talk
from langpack import Pack


def line(flag=True, echoing=False, said="Dur bakayım. Bir saniye, bakayım.", playing="Şimdi şöyle, durum iyi."):
    t = talk.Talk.__new__(talk.Talk)
    t.a = NS(stop_words=flag)
    t.packs, t.lang, t.app, t.echoing = {"tr": Pack("tr")}, "tr", True, echoing
    t.said_recently = [(0, w) for w in said.lower().replace(",", "").replace(".", "").split()]
    t.speaking, t.said_item = [[playing, 0, False, b""]], [playing, 0, False, b""]
    return t


class StopWords(unittest.TestCase):
    def test_their_stop_words_count(self):
        t = line()
        for heard in ("durdur", "bir saniye dur", "kapatabilirsin", "tamam tamam", "dur"):
            self.assertTrue(t.stop_heard(heard), heard)

    def test_backchannels_do_not(self):
        t = line()
        for heard in ("tamam", "evet", "hı hı", "aynen"):
            self.assertFalse(t.stop_heard(heard), heard)

    def test_delta_own_words_in_order_are_echo(self):
        self.assertFalse(line().stop_heard("dur bakayım"))
        self.assertFalse(line(playing="Kapatalım mı?").stop_heard("kapatalım"))

    def test_off_without_the_flag_or_on_an_echoing_line(self):
        self.assertFalse(line(flag=False).stop_heard("durdur"))
        self.assertFalse(line(echoing=True).stop_heard("durdur"))


if __name__ == "__main__":
    unittest.main()
