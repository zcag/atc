#!/usr/bin/env python3
"""tr.json with their names gives exactly the words talk.py had before packs (tr_snapshot.json), so nothing they hear
changes, and every pack has the same keys and slots."""
import json, os, re, sys, tempfile, unittest

VOICE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, VOICE)
from langpack import Pack, agreement, fill, first_language, hangup_tags, saved_names



def load(*path):
    with open(os.path.join(VOICE, *path), encoding="utf-8") as f:
        return f.read()


SNAP = json.loads(load("test", "tr_snapshot.json"))
NAMES = {"assistant": "Max", "user": "Ada"}
RENAMED = {"AYLAR": "MONTHS", "GUNLER": "DAYS"}
SPLIT = "ACKS_en", "STT_en"


def raw(code):
    return json.loads(load("lang", code + ".json"))


class LineBack(unittest.TestCase):
    def test_back_to_the_assistant(self):
        for code, yes, no in (
            ("tr", ["asistana dön", "Asistana geri dönelim, asistana geç", "asistanı bağla", "geri dön asistana"], ["asistan ne dedi", "bunu asistana söyleyeceğim sonra"]),
            ("en", ["back to the assistant", "put the assistant on", "get the assistant"], ["what did the assistant say", "the assistant was wrong"]),
        ):
            p = Pack(code)
            for text in yes:
                self.assertTrue(p.LINE_BACK.search(text), text)
            for text in no:
                self.assertFalse(p.LINE_BACK.search(text), text)


    def test_back_by_the_assistants_own_name(self):
        for code, yes, no in (
            ("tr", ["delta'ya dön", "deltaya dön", "Delta’ya geri dön", "delta ya geç", "dön deltaya", "deltayı bağla"], ["delta verisini aç", "delta grafiğine dön", "delta ne dedi"]),
            ("en", ["back to delta", "put delta on", "get delta"], ["the delta is wrong", "what did delta say"]),
        ):
            p = Pack(code, assistant="delta")
            for text in yes:
                self.assertTrue(p.LINE_BACK.search(text), text)
            for text in no:
                self.assertFalse(p.LINE_BACK.search(text), text)


class Tr(unittest.TestCase):
    def test_every_constant_is_today(self):
        p = Pack("tr", **NAMES)
        for key, want in SNAP.items():
            if key in SPLIT:
                continue
            got = getattr(p, RENAMED.get(key, key))
            if isinstance(got, re.Pattern):
                got = got.pattern
            if isinstance(got, set):
                got = sorted(got)
            self.assertEqual(got, want, key)

    def test_regex_flags_are_ignorecase(self):
        p = Pack("tr", **NAMES)
        self.assertTrue(p.STOP.search("DUR"))

    def test_lines_as_spoken(self):
        p = Pack("tr", **NAMES)
        self.assertEqual(p.GREETING, "Alo, merhaba, ben Max.")
        self.assertEqual(p.OUTBOUND, "[Ada'ı arıyorsun, telefon çalıyor. Açıp «Alo» deyince ilk bu cevabını duyacak: kısaca selam ver, ben Max de ve neden aradığını söyle.]")
        self.assertEqual(fill(p.OUTBOUND_GUEST, guest="sam", reason="x"),
                         "[sam'yı Ada'ın isteğiyle sen arıyorsun, telefon çalıyor; sebep: x. Açıp «Alo» deyince ilk bu cevabını duyacak: selam ver, Max olduğunu ve neden aradığını kısaca söyle.]")
        self.assertEqual(fill(p.CUT_OFF, heard="a", text="b"), "(sözünü kestim; cevabından sadece şunu duydum: «a») b")

    def test_kapat_and_hangup_both_end_the_call(self):
        for packs in ({"tr": Pack("tr", **NAMES), "en": Pack("en", **NAMES)}, {"en": Pack("en", **NAMES), "tr": Pack("tr", **NAMES)}):
            end = hangup_tags(packs)
            self.assertEqual(end.sub("", "Görüşürüz. [KAPAT]"), "Görüşürüz. ")
            self.assertEqual(end.sub("", "Bye. [HANGUP]"), "Bye. ")


class En(unittest.TestCase):
    def test_acks_and_stt_he_hears_in_english_mode_are_today(self):
        p = Pack("en", **NAMES)
        self.assertEqual(p.ACKS, SNAP["ACKS_en"])
        for k, v in SNAP["STT_en"].items():
            self.assertEqual(p.STT[k], v, k)

    def test_neutral_defaults(self):
        self.assertEqual(Pack("en").GREETING, "Hello, this is your assistant.")
        self.assertEqual(Pack("en", assistant="Ada").GREETING, "Hello, this is Ada.")
        self.assertNotIn("{", Pack("en").OUTBOUND)

    def test_marker_matches_the_built_in_modes(self):
        marker = Pack("en").CUT_OFF.split("«")[0]
        for mode in ("phone.md", "guest-call.md"):
            text = load("..", "modes", mode)
            self.assertIn(marker, text, mode)
            self.assertIn(Pack("en").HANGUP[0], text, mode)


class Packs(unittest.TestCase):
    def test_same_keys_and_slots(self):
        tr, en = raw("tr"), raw("en")
        self.assertEqual(set(tr), set(en))
        slots = lambda v: sorted(set(re.findall(r"\{(\w+)\}", v))) if isinstance(v, str) else None
        for k in tr:
            self.assertEqual(slots(tr[k]), slots(en[k]), k)

    def test_fill_leaves_his_braces_alone(self):
        self.assertEqual(fill("{a} {b}", a="{b}", b="x"), "{b} x")


class FirstLanguage(unittest.TestCase):
    PACKS = {"tr": None, "en": None}

    def pick(self, content):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "settings.json")
            if content is not None:
                with open(path, "w") as f:
                    f.write(content)
            return first_language(path, self.PACKS, "tr")

    def test_the_users_setting_when_the_talker_has_it(self):
        self.assertEqual(self.pick('{"language": "en"}'), "en")
        self.assertEqual(self.pick('{"language": " EN "}'), "en")

    def test_otherwise_what_the_talker_was_installed_with(self):
        for content in (None, "{", "{}", '{"language": ""}', '{"language": "de"}'):
            self.assertEqual(self.pick(content), "tr", content)


class SavedNames(unittest.TestCase):
    def names(self, content):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "settings.json")
            if content is not None:
                with open(path, "w") as f:
                    f.write(content)
            return saved_names(path)

    def test_settings_name_the_call(self):
        assistant, user = self.names('{"assistant": "Max", "user": "Ada"}')
        self.assertEqual((assistant, user), ("Max", "Ada"))
        self.assertEqual(Pack("en", assistant, user).GREETING, "Hello, this is Max.")

    def test_without_settings_the_pack_stays_neutral(self):
        for content in (None, "{", "{}", '{"assistant": ""}'):
            self.assertEqual(self.names(content), (None, None), content)
        self.assertEqual(Pack("en", *self.names(None)).GREETING, "Hello, this is your assistant.")


class Agreement(unittest.TestCase):
    SAME_SPEECH = .5

    def test_english_speech_both_transcribers_spell(self):
        for tr, en in (
            ("Okey, you can just keep talking for a bit", "Okay, you can just keep talking for a bit"),
            ("Aywas to king to maybe like we have this un ations and buttons", "I was thinking to maybe like we have this animations and buttons"),
        ):
            self.assertGreaterEqual(agreement(tr, en), self.SAME_SPEECH, tr)

    def test_turkish_speech_the_english_transcriber_mangles(self):
        for tr, en in (
            ("Türkçeye dönebilirsin", "to children every listen"),
            ("biraz Türkçe konuşabilir misin?", "Brastructure consequence"),
            ("Okey tamam şimdi. Peki çalışan session'lar nasıl gidiyor?", "Okay, Tim Shamble is session though on session on the sigh"),
        ):
            self.assertLess(agreement(tr, en), self.SAME_SPEECH, tr)

    def test_no_english_reading_at_all(self):
        self.assertEqual(agreement("evet", ""), 0)


if __name__ == "__main__":
    unittest.main(verbosity=0)
