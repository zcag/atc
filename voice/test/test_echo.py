#!/usr/bin/env python3
"""--echo-order: an answer that repeats the question's verb after delta stopped is theirs, delta's own words coming
back while it talks are echo, and without the flag the old any-order rule stays."""
import os, sys, time, unittest
from types import SimpleNamespace as NS

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_press import talk


def line(flag, began_after, said="Tgo ve forge raporda diğer siteler altında duruyor. Orada kalsınlar mı?"):
    t = talk.Talk.__new__(talk.Talk)
    t.a, t.app, t.speaking, t.last_voice = NS(echo_order=flag), True, [], time.monotonic()
    t.said_recently = [(time.monotonic(), w) for w in said.lower().replace(".", "").replace("?", "").split()]
    t.began_after = began_after
    return t


class EchoOrder(unittest.TestCase):
    def test_an_answer_after_delta_stopped_is_theirs(self):
        self.assertFalse(line(True, 0.74).echo("kalsınlar."))
        self.assertTrue(line(False, 0.74).echo("kalsınlar."))

    def test_delta_words_in_order_while_it_talks_are_echo(self):
        self.assertTrue(line(True, 0.0).echo("orada kalsınlar mı"))

    def test_their_own_words_over_delta_are_not(self):
        self.assertFalse(line(True, 0.0).echo("bekle turuncu sahibinden dediğin ne"))


if __name__ == "__main__":
    unittest.main()
