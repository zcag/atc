# Call persona: drawings in a rig ("kind": "rig")

The fresh start after v1-v8 (see `persona-handover.md`). Rendered by our own small WebGL renderer (`web/rig.js`);
no Live2D, Spine or Rive (their rig files only come out of their GUI editors, or need a paid licence to ship).

## How it works

Like cel animation: a library of separate drawings, and the right one is swapped in for each moment with a very
short dissolve (20-120 ms), instead of stretching one painting.

- **Drawings**, all rendered by LivePortrait from the one painted portrait, so they keep its look
  (`tools/persona/rig/drawings.py`): the head at 10 angles (yaw -8/0/+8 x pitch -6/0/+6, and a bowed 0/+12 for
  reading); per angle eyes (8 gaze directions, half shut, shut; reading: hard down at a low page), brows (up, knit),
  mouth shapes (a, o, e open at several sizes, a small u).
- **Patches**: for each angle and feature class (eyes, brows, mouth) the part of each drawing that differs from that
  angle's neutral drawing, under one feathered mask per class, so swaps never show a seam. Brows are drawn before
  eyes, so an eye drawing always wins where they overlap.
- **Bending between angles**: each angle's head is a mesh skinned to parallax bones (`face` follows landmark depth,
  so the nose and eyes move more than the outline, `back` moves the ears the other way), measured in pixels per
  degree from the drawings' own nose tips. The nearest angle is drawn and the rest of the turn is bent (at most a
  few degrees); a new angle dissolves in over 110 ms, with hysteresis so it doesn't flicker at a midpoint.
- **Poses**: layers cut (SAM) from image edits of the portrait: a hand to the chin (thinking), a notebook in both
  hands (reading), a pen and notebook (writing). They rise into frame from below and sink back out.
- **Mood**: a grade (contrast, cool shadows, warm highlights, a key light on the face from the lamp side), the room
  darkened and softened for depth, a vignette, the lamp's glow with a slow flicker, dust drifting in its light.
- **Acting** (`Behaviour` in `web/rig.js`): eyes lead, the head follows on springs, the body trails; blinks every
  2-6 s, breathing, glances. Listening is relaxed; hearing him leans in, tilts, nods at his pauses; thinking puts a
  hand to the chin (or looks up and away) with knit brows; a tool means reading (eyes scanning the page) or writing;
  speaking keeps eye contact with glances away at phrase starts, nods and brow lifts on stressed syllables, and the
  mouth shape picked from the played voice's loudness and bands. `Director` turns that into drawings.

## Building a character

Scripts in `tools/persona/rig/`, run with the venv in desktop `~/.local/share/persona2d/rig/.venv` (mediapipe,
torch CPU, transformers, simple-lama-inpainting, triangle). Working files in `~/.local/share/persona2d/rig/`.

1. Upscale the portrait 2x (`esr/realesrgan-ncnn-vulkan -n realesrgan-x4plus`, then down to 2x): `work/base2.png`;
   LaMa fills of the room without him and the body without the head are cached in `work/fill_*.png`.
2. `drawings.py draw/list.json`, then on gpu in the LivePortrait checkout:
   `render_lp.py <crop.png> <list.json> <out>` (`tools/persona/render_lp.py`, ~0.6 s a drawing); copy to `draw/lp/`.
   `draw/crop.json` says where the crop sits in the 2x portrait.
3. Pose edits: `tools/persona/edit.py` on gpu with `poses_edit.json` (FLUX.2 klein), then
   `poses.py work poses work name=file=x0,y0,x1,y1;...` (boxes around each piece at 1x) writes `work/pose_<name>.png`.
4. `build.py work draw out`: per angle landmarks, face parse, head mesh, patches into one atlas per angle, poses,
   overlays, `rig.json` and `persona.json`.
5. `publish.py out professor-2d`: copies it to atc's personas folder and bumps its rev.

## Checking it

- `node --test web/` (part of `make check`): pose maths, the dissolve, the director's choices (angle hysteresis,
  blink, gaze sign, mouth, reading), ten simulated minutes of behaviour, poses per state.
- `rec.sh <out> <mp4>`: frame-exact render of the simulated call at phone size with its audio; with a timeline
  argument it renders that instead (silent). The record page logs each frame's parameters and drawings
  (`clip/frames/states`). `strip.py` grids consecutive frames' crops; `masks.py` shows every patch of an angle over
  its head drawing with its mask.
- `live.py <out> <mp4>`: the app's own path in real time at phone DPR; prints frame pacing and every long frame.
