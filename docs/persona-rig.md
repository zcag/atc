# Call persona: the layered 2D rig ("kind": "rig")

The fresh start after v1-v8 (see `persona-handover.md`). One painted portrait, cut into parts that are animated
together as meshes, drawn by a small WebGL renderer of our own (`web/rig.js`); no Live2D, Spine or Rive.

## Why this and not a 2D animation tool

Nobody draws or rigs by hand here, so the rig file has to be written by a script. Live2D (.moc3) and Rive (.riv)
files come only out of their GUI editors (Rive's exports also need a paid plan since Oct 2025); Spine's JSON can be
generated and its runtime is excellent, but shipping it needs a Spine editor licence, and the user chose to keep it
free; Inochi2D's format is open but its web runtime (inox2d) calls itself a prototype. What we need from a runtime
is small: weighted meshes, deformers and a draw order, which is one shader.

## The parts and how they move

Draw order: room (`plate`), body, mouth inside, sclera and iris per eye, head, glasses.

- **Head**: one mesh with two holes (the eye openings) and a cut along the line between the lips. The eyeballs and
  the inside of the mouth are drawn behind it, so a blink is the upper edge of the hole sliding onto the lower one
  (the hole closes, the lid skin stretches) and speech is the lower half of the cut moving with the jaw.
- **Deformers** (additive, in the rest pose): `jaw`, `uplip`, `lolip`, `cornerR/L`, `lidR/L`, `lidloR/L`,
  `browR/L`, `cheekR/L`, `irisR/L`. Each vertex has up to four, with weights solved as harmonic fields over the mesh
  (fixed values on the lips, lids and far away; smooth in between), so nothing tears at a paste edge.
- **Bones** (skinning, after the deformers): `root`, `body`, `neck`, `head`, `face`, `back`. A head turn moves
  `face` (weighted by depth from the face landmarks, the nose most) more than the outline, and `back` (the ears)
  the other way.
- Each bone and deformer has an origin and, per parameter, `[dx, dy, degrees, scale x - 1, scale y - 1]`; the
  renderer sums parameter x vector and builds the affine. Parameters come from `Behaviour` in `web/rig.js`:
  yaw, pitch, roll, sway, lean, breath, gazeX/Y, blinkR/L, browR/L, knit, smile, jaw, round, wide, lipup, lipdown.

## Building a character

Scripts in `tools/persona/rig/`, run with the venv in desktop `~/.local/share/persona2d/rig/.venv` (mediapipe,
torch CPU, transformers, simple-lama-inpainting, triangle). Working files in `~/.local/share/persona2d/rig/work`.

1. Upscale the portrait 2x (`esr/realesrgan-ncnn-vulkan -n realesrgan-x4plus`, then down to 2x): `base2.png`.
2. `lm.py` face landmarks, `parse.py` face parsing (head, ears, neck).
3. `glasses.py` with `glasses.json` (rim ellipses refined on the painted line, bridge and arms as polylines): the
   face without the frame (LaMa) and the frame as its own layer.
4. `eyes.py`: eye openings, the sclera and the iris completed into a disk.
5. `build.py <work> <out>`: masks, layers, meshes, weights, `rig.json` and `persona.json`. The LaMa fills of the
   room and of the neck under the head are cached in `work/fill_*.png` (delete them to redo).
6. `publish.py <out> professor-2d`: copies it to atc's personas folder and bumps its rev.

## Checking it

- `node --test web/` (part of `make check`): pose maths, and ten simulated minutes of behaviour stay finite, in
  range and blink at a human rate.
- `rec.sh <out> <mp4>`: frame-exact render of the simulated call at phone size with its audio;
  `rec.sh <out> <mp4> "" poses=poses.json` renders the stress poses one per frame. `strip.py` puts consecutive
  frames' crops in a grid to read motion frame by frame.
- `live.py <out> <mp4>`: the app's own path in real time (`persona.js` -> `rig.js`, requestAnimationFrame) at
  phone DPR, recorded, and prints frame pacing.
