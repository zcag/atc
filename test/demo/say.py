"""Renders one line to a WAV, for the demo's made-up caller: say.py <voice> <out.wav> <text>. A voice with a _ in its name is Kokoro's (TALK_MODELS), any other pocket-tts's."""
import os
import sys
import wave

import numpy as np

voice, out, text = sys.argv[1:4]
if "_" in voice:
    from kokoro_onnx import Kokoro

    models = os.environ["TALK_MODELS"] + "/kokoro"
    audio, rate = Kokoro(f"{models}/kokoro-v1.0.int8.onnx", f"{models}/voices-v1.0.bin").create(text, voice=voice, speed=.9, lang="en-gb" if voice[0] == "b" else "en-us")
else:
    from pocket_tts import TTSModel

    tts = TTSModel.load_model()
    audio, rate = tts.generate_audio(tts.get_state_for_audio_prompt(voice), text).numpy(), tts.sample_rate
with wave.open(out, "wb") as w:
    w.setnchannels(1), w.setsampwidth(2), w.setframerate(rate)
    w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
