import { useState, useEffect } from "./vendor/preact-htm.js";
import { rig } from "./rig.js";

const ROOMS = "/app/personas/_rooms/";
const WIDTH = 360, HEIGHT = 480;
const drawn = new Map();
let turn = Promise.resolve();

/** One still of a drawn character in its background, from the same renderer a call uses, so it can't drift from what
 *  a call shows. Each needs a whole rig loaded, so they take turns, and each is kept in this browser until the character's rev
 *  changes. Returns a data URL. */
function portrait(character, background, rev) {
  const key = `atc.portrait.${character}.${rev || 0}.${background}`;
  if (drawn.has(key)) return drawn.get(key);
  let kept = null;
  try { kept = localStorage.getItem(key); } catch {}
  const made = kept ? Promise.resolve(kept) : (turn = turn.catch(() => {}).then(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const still = () => ({ state: "listening", you: 0, it: 0, lo: 0, hi: 0 });
    const frame = await rig(canvas, `/app/personas/${character}/`, still, { dt: 1 / 30, background: background && ROOMS + background });
    for (let i = 0; i < 3; i++) frame(i * 33);
    const url = canvas.toDataURL("image/jpeg", .85);
    canvas.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
    try { localStorage.setItem(key, url); } catch {}
    return url;
  }));
  drawn.set(key, made);
  made.catch(() => drawn.delete(key));
  return made;
}

/** The still of a drawn character, null until it is ready or for a kind that has none. */
export function usePortrait(character, background, rev, kind) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    setUrl(null);
    if (kind !== "rig") return;
    let gone = false;
    portrait(character, background || "", rev).then((u) => !gone && setUrl(u), (e) => console.warn("portrait", character, e));
    return () => { gone = true; };
  }, [character, background, rev, kind]);
  return url;
}
