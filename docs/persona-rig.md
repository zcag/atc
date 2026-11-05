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
  degree from the drawings' own nose tips. The nearest angle is drawn and the rest of the turn is bent (up to about
  6 degrees); a new angle dissolves in over 140 ms, with wide hysteresis so it comes rarely and doesn't flicker. During
  the dissolve both angles warp along the measured flow between them (`flows.png`), so the glasses and eyes meet
  instead of showing twice.
- **Poses**: layers cut (SAM) from image edits of the portrait: a hand to the chin (thinking), a notebook in both
  hands (reading), a pen and notebook (writing), an open hand explaining (now and then at a phrase start while
  speaking). They swing in from below the frame, each dropping as far as it needs to be fully out of view, so nothing
  fades or pops into sight.
- **Mood**: a grade (contrast, cool shadows, warm highlights, a key light on the face from the lamp side) baked into
  the character.
- **Room**: separate from the character, in `room.json`: the plate (the room behind the character, darkened and
  softened for depth), a vignette, the lamp's glow with a slow flicker, dust drifting in its light. `opts.room: false`
  draws the character alone on a transparent canvas; `opts.background` puts another picture in the plate's place and
  leaves out the glow and dust, which belong to the character's own room.
- **Acting** (`Behaviour` in `web/rig.js`): eyes lead, the head follows on springs, the body trails; blinks every
  2-6 s, breathing, glances. Listening is relaxed; hearing the user leans in, tilts, nods at their pauses; thinking puts a
  hand to the chin (after a moment, so a short pause raises nothing) or looks up and away with knit brows and an
  unsmiling mouth; a tool means reading (eyes scanning the page) or writing, and that prop stays through the short gaps
  between tools; speaking keeps eye contact with glances away at phrase starts, nods and brow lifts on stressed
  syllables, and a mouth from the played voice, judged against that voice's own recent loudness and tone, so a loud
  voice, a quiet one and each client's filters look the same. `Director` turns that into drawings.

## Building a character

Scripts in `tools/persona/rig/`, run with a venv holding mediapipe, torch (CPU is enough), transformers,
simple-lama-inpainting and triangle. Working files go in `$PERSONA_WORK/rig/` (`PERSONA_WORK` defaults to
`~/.local/share/persona2d`), including `face_landmarker.task` (MediaPipe's) and `esr/` (realesrgan-ncnn-vulkan).

Each character has a work dir with its portrait as `base.png` (768x1344). `tools/persona/gen.py <out dir> [jobs.json]`
makes portraits through an OpenAI-compatible image server at `$IMAGES_URL`. Use an original face, not a likeness of anyone,
with a neutral, unsmiling mouth: smiles are added as drawings, while a smile in the portrait can't be taken out. Write
the prompt, model and seed to `source.json` in the character's folder.

1. `prep.py <work>`: 2x upscale, figure matte, LaMa fills (room, body without the head), the head crop the drawings
   are rendered from (`crop.png`, `crop.json`) and the lamp position (`char.json`).
2. `drawings.py list.json`, then on a GPU machine in a LivePortrait checkout:
   `render_lp.py <crop.png> <list.json> <out>` (`tools/persona/render_lp.py`, ~0.6 s a drawing); copy to `<draw>/lp/`.
3. Pose edits: `tools/persona/edit.py` (mflux with FLUX.2 klein, on Apple silicon) with `rig/poses_edit.json`, then `poses.py <work> <poses> <work> name=file=x0,y0,x1,y1;...`
   (boxes around each piece at 1x) writes `<work>/pose_<name>.png`.
4. `build.py <work> <draw> <out>`: per angle landmarks, face parse, head mesh, patches into one atlas per angle, poses,
   overlays, `rig.json` and `persona.json`.
5. `polish.py <out> <final> [--erase poly] [--move pose=dx,dy] [--serious k]`: repairs on the built drawings (stray body
   pieces, stronger knit brows, blink drawings that leave the glasses alone, a pose nudged into place) and moves the room
   to `room.json`. It takes a fresh build only, since it exaggerates the knit each time.
6. `flows.py <final>`: draws each pair of neighbouring angles through `web/rig.js`, bent to the same pose, and measures
   the flow between them. Needs playwright and a browser with WebGL2.
7. `verify.py <final>`: the gate. See "Checking it". Fix what fails, then look at `verify.jpg`.
8. `publish.py <final> <name> --sources <work>`: copies it to atc's personas folder, bumps its rev, and archives the
   sources to `$PERSONA_SOURCES/<name>`. It refuses anything that hasn't passed `verify.py` as it stands now.

## Checking it

`verify.py` measures each fault the first two characters had: the record of the prompt, every drawing the director can
ask for, a room of its own, measured morphs, a body in one piece, a jaw line that holds while talking, blinks that touch
only the lid, knit brows that show but don't look worried, a thinking hand that reaches the chin, poses that don't pop,
and head swaps that stay sharp. Numbers can't judge a face: `verify.jpg` is a contact sheet, and a person looks at it,
at phone size, before publishing. A repair that passes the numbers can still look wrong. Compare against the portrait.

- `node --test web/` (part of `make check`): pose maths, the dissolve, the director's choices (angle hysteresis,
  blink, gaze sign, mouth, reading, only drawings that exist), ten simulated minutes of behaviour, poses per state, props
  across tool gaps, blinks while reading, the mouth at two loudnesses.
- `rec.sh <out> <mp4> [timeline.json]`: frame-exact render of a simulated call at phone size. A timeline is
  `{"plan": [[state, seconds], ...], "you": [...], "it": [...], "lo": [...], "hi": [...]}` (loudness at 50 Hz), default
  `$PERSONA_WORK/clip/timeline.json`, with `mix.wav` beside it for audio. The record page logs each frame's parameters and drawings
  (`rig/clip/frames/states`). `strip.py` grids consecutive frames' crops; `masks.py` shows every patch of an angle over
  its head drawing with its mask.
- `live.py <out> <mp4>`: the app's own path (the same default timeline) in real time at phone DPR; prints frame pacing and every long frame.
