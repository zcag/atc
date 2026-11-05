"""Renders one line in a pocket-tts voice to a WAV, for the demo's made-up caller: say.py <voice> <out.wav> <text>."""
import sys
import wave

import numpy as np
from pocket_tts import TTSModel

voice, out, text = sys.argv[1:4]
tts = TTSModel.load_model()
audio = tts.generate_audio(tts.get_state_for_audio_prompt(voice), text).numpy()
with wave.open(out, "wb") as w:
    w.setnchannels(1), w.setsampwidth(2), w.setframerate(tts.sample_rate)
    w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
