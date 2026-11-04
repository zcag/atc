# Call persona: drawings in a rig ("kind": "rig")

Rendered by our own small WebGL renderer (`web/rig.js`);
no Live2D, Spine or Rive (their rig files only come out of their GUI editors, or need a paid licence to ship).

## How it works

Like cel animation: a library of separate drawings, and the right one is swapped in for each moment with a very
short dissolve (20-120 ms), instead of stretching one painting.

- **Drawings**, all rendered by LivePortrait from the one painted portrait, so they keep its look
  (`tools/persona/rig/drawings.py`): the head at 10 angles (yaw -8/0/+8 x pitch -6/0/+6, and a bowed 0/+12 for
  reading); per angle eyes (8 gaze directions, half shut, shut; reading: hard down at a low page), brows (up, knit),
  mouth shapes (a, o, e open at several sizes, a small u, two smiles).
- **Patches**: for each angle and feature class (eyes, brows, mouth) the part of each drawing that differs from that
  angle's neutral drawing, under one feathered mask per class, so swaps never show a seam. Brows are drawn before
  eyes, so an eye drawing always wins where they overlap.
- **Bending between angles**: each angle's head is a mesh skinned to parallax bones (`face` follows landmark depth,
  so the nose and eyes move more than the outline, `back` moves the ears the other way), measured in pixels per
  degree from the drawings' own nose tips. The nearest angle is drawn and the rest of the turn is bent (at most a
  few degrees); a new angle dissolves in over 110 ms, with hysteresis so it doesn't flicker at a midpoint.
- **Poses**: layers cut (SAM) from image edits of the portrait: a hand to the chin (thinking), a notebook in both
  hands (reading), a pen and notebook (writing), an open hand explaining (now and then at a phrase start while speaking). They rise into frame from below and sink back out.
- **Mood**: a grade (contrast, cool shadows, warm highlights, a key light on the face from the lamp side), the room
  darkened and softened for depth, a vignette, the lamp's glow with a slow flicker, dust drifting in its light.
- **Acting** (`Behaviour` in `web/rig.js`): eyes lead, the head follows on springs, the body trails; blinks every
  2-6 s, breathing, glances. Listening is relaxed; hearing the user leans in, tilts, nods at their pauses; thinking puts a
  hand to the chin (or looks up and away) with knit brows; a tool means reading (eyes scanning the page) or writing;
  speaking keeps eye contact with glances away at phrase starts, nods and brow lifts on stressed syllables, and the
  mouth shape picked from the played voice's loudness and bands. `Director` turns that into drawings.

## Building a character

Scripts in `tools/persona/rig/`, run with a venv holding mediapipe, torch (CPU is enough), transformers,
simple-lama-inpainting and triangle. Working files go in `$PERSONA_WORK/rig/` (`PERSONA_WORK` defaults to
`~/.local/share/persona2d`), including `face_landmarker.task` (MediaPipe's) and `esr/` (realesrgan-ncnn-vulkan).

Each character has a work dir with its portrait as `base.png` (768x1344). `tools/persona/gen.py <out dir> [jobs.json]`
makes portraits through an OpenAI-compatible image server at `$IMAGES_URL`. Use an original face, not a likeness of anyone.

1. `prep.py <work>`: 2x upscale, figure matte, LaMa fills (room, body without the head), the head crop the drawings
   are rendered from (`crop.png`, `crop.json`) and the lamp position (`char.json`).
2. `drawings.py list.json`, then on a GPU machine in a LivePortrait checkout:
   `render_lp.py <crop.png> <list.json> <out>` (`tools/persona/render_lp.py`, ~0.6 s a drawing); copy to `<draw>/lp/`.
3. Pose edits: `tools/persona/edit.py` (mflux with FLUX.2 klein, on Apple silicon) with `rig/poses_edit.json`, then `poses.py <work> <poses> <work> name=file=x0,y0,x1,y1;...`
   (boxes around each piece at 1x) writes `<work>/pose_<name>.png`.
4. `build.py <work> <draw> <out>`: per angle landmarks, face parse, head mesh, patches into one atlas per angle, poses,
   overlays, `rig.json` and `persona.json`.
5. `publish.py <out> <name>`: copies it to atc's personas folder and bumps its rev.

## Checking it

- `node --test web/` (part of `make check`): pose maths, the dissolve, the director's choices (angle hysteresis,
  blink, gaze sign, mouth, reading), ten simulated minutes of behaviour, poses per state.
- `rec.sh <out> <mp4> [timeline.json]`: frame-exact render of a simulated call at phone size. A timeline is
  `{"plan": [[state, seconds], ...], "you": [...], "it": [...], "lo": [...], "hi": [...]}` (loudness at 50 Hz), default
  `$PERSONA_WORK/clip/timeline.json`, with `mix.wav` beside it for audio. The record page logs each frame's parameters and drawings
  (`rig/clip/frames/states`). `strip.py` grids consecutive frames' crops; `masks.py` shows every patch of an angle over
  its head drawing with its mask.
- `live.py <out> <mp4>`: the app's own path (the same default timeline) in real time at phone DPR; prints frame pacing and every long frame.
