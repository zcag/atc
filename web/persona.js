// The call screen's illustrated characters ("kind": "illustration"): one painted portrait, edits of its face
// (blink, glances, brows, mouth shapes) in an atlas, the room without him and his matte. Every frame the face
// controller (a port of Animator.kt) picks how much of each edit shows in the eye, brow and mouth regions and how
// far to turn, nod, tilt and breathe him over the room. Android draws the same shader (Illustration.kt).

const PI = Math.PI, rad = (d) => d * PI / 180, clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };

class Spring {
  constructor(hz) { this.x = 0; this.v = 0; this.hz = hz; }
  to(target, dt) {
    const w = 2 * PI * this.hz, f = 1 + 2 * dt * w, dtw2 = dt * w * w;
    this.v = (this.v + dtw2 * (target - this.x)) / (f + dt * dtw2);
    this.x += this.v * dt;
    return this.x;
  }
}

class Animator {
  constructor() {
    Object.assign(this, { t: 0, s: {}, blinkAt: 1.5, blinkStart: -1, gazeAt: 0, gazeYaw: 0, gazePitch: 0, slow: 0, nod: 0, brow: 0, youSince: -1, lastState: "" });
    for (const [k, hz] of [["eyeYaw", 9], ["eyePitch", 9], ["headYaw", 1.2], ["headPitch", 1.2], ["headRoll", .9], ["jaw", 11], ["smile", .8], ["focus", 1.5], ["tilt", .7]]) this[k + "S"] = new Spring(hz);
  }
  wave(a, b) { return (Math.sin(this.t * a * 2 * PI) + Math.sin(this.t * b * 2 * PI * 1.618 + 1.3)) * .5; }
  step(dt, state, you, it) {
    const t = (this.t += dt), s = this.s;
    const speaking = state === "speaking", thinking = state === "thinking" || state === "tool", listening = state === "listening" || state === "hearing";
    if (state !== this.lastState) { this.gazeAt = t; this.lastState = state; }
    this.blink(thinking ? 4.5 : speaking ? 2.6 : 3.4);
    this.gaze(thinking, speaking);
    this.listen(dt, you, listening);
    const voice = speaking ? it : 0;
    this.emphasis(dt, voice);
    const sway = listening ? .6 : 1;
    this.eyeYaw = this.eyeYawS.to(this.gazeYaw, dt);
    this.eyePitch = this.eyePitchS.to(this.gazePitch, dt);
    this.yaw = this.headYawS.to(this.gazeYaw * .35 + rad(2.2) * sway * this.wave(.13, .07), dt);
    this.pitch = this.headPitchS.to(this.gazePitch * .3 + rad(1.2) * sway * this.wave(.11, .17) + rad(.6) * Math.sin(2 * PI * .22 * t) + this.nod, dt);
    this.roll = this.headRollS.to(rad(1.4) * sway * this.wave(.09, .05) + this.tiltS.to(state === "hearing" ? rad(3) : thinking ? rad(-2) : 0, dt), dt);
    s.jawOpen = this.jawS.to(speaking ? Math.min(.6, Math.pow(voice, .8) * .55) : 0, dt);
    s.smile = this.smileS.to(listening ? .22 : speaking ? .12 : .02, dt);
    s.focus = this.focusS.to(thinking ? 1 : 0, dt);
    s.browUp = .06 + this.brow * .55 + (state === "hearing" ? .12 : 0);
    return this;
  }
  blink(every) {
    const t = this.t;
    if (this.blinkStart < 0 && t >= this.blinkAt) this.blinkStart = t;
    let shut = 0;
    if (this.blinkStart >= 0) {
      const k = t - this.blinkStart;
      if (k < .07) shut = k / .07;
      else if (k < .1) shut = 1;
      else if (k < .22) shut = 1 - (k - .1) / .12;
      else { this.blinkStart = -1; this.blinkAt = t + (Math.random() < .12 ? .18 : every * (.45 + Math.random() * 1.1)); }
    }
    this.s.blink = shut;
  }
  gaze(thinking, speaking) {
    const t = this.t;
    if (t < this.gazeAt) return;
    if (thinking || (speaking && Math.random() < .18)) {
      this.gazeYaw = rad(9 + Math.random() * 8) * (Math.random() < .5 ? 1 : -1);
      this.gazePitch = rad(thinking ? 5 + Math.random() * 6 : -2 + Math.random() * 4);
      this.gazeAt = t + (thinking ? 1.4 + Math.random() * 1.6 : .5 + Math.random() * .5);
    } else {
      this.gazeYaw = rad((Math.random() - .5) * 3);
      this.gazePitch = rad((Math.random() - .5) * 2);
      this.gazeAt = t + .6 + Math.random() * 1.6;
    }
    if (Math.abs(this.gazeYaw - this.eyeYawS.x) > rad(8) && this.blinkStart < 0 && Math.random() < .5) this.blinkAt = t;
  }
  listen(dt, you, listening) {
    if (you > .12) { if (this.youSince < 0) this.youSince = this.t; }
    else if (this.youSince >= 0) {
      if (listening && this.t - this.youSince > .9 && Math.random() < .7) this.nod += rad(4);
      this.youSince = -1;
    }
    this.nod *= Math.exp(-dt * 5);
  }
  emphasis(dt, voice) {
    this.slow += (voice - this.slow) * Math.min(1, dt * 2.5);
    if (voice - this.slow > .22 && this.brow < .3) { this.brow = 1; this.nod += rad(1.8); }
    this.brow *= Math.exp(-dt * 3.5);
  }
}

const pick = (list) => {
  let r = Math.random() * list.reduce((a, [, w]) => a + w, 0);
  for (const [n, w] of list) if ((r -= w) <= 0) return n;
  return list[0][0];
};

const MOUTHS = ["m_small", "m_a", "m_o", "m_u", "m_e", "m_m"];

// A new mouth shape each time the jaw starts to open (a syllable), sometimes pressed lips in a short gap.
class Mouth {
  constructor() { this.w = Object.fromEntries(MOUTHS.map((n) => [n, new Spring(14)])); this.cur = "m_small"; this.gap = null; this.prev = 0; this.rising = false; }
  step(dt, open, speaking) {
    if (open > this.prev + .004 && !this.rising && open > .06) {
      this.rising = true;
      this.cur = pick([["m_a", 3], ["m_e", 2.5], ["m_o", 1.6], ["m_small", 2], ["m_u", .8]]);
    }
    if (open < this.prev - .004 && this.rising) {
      this.rising = false;
      if (speaking && open < .18 && Math.random() < .25) this.gap = "m_m";
    }
    if (open > .15) this.gap = null;
    this.prev = open;
    const level = smooth(.02, .3, open);
    return Object.fromEntries(MOUTHS.map((n) => [n, this.w[n].to(n === this.cur ? level : n === this.gap ? (1 - level) * .9 : 0, dt)]));
  }
}

const VS = `#version 300 es
in vec2 p; out vec2 v; void main() { v = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;

export const ILLUSTRATION_FS = `#version 300 es
precision highp float;
in vec2 v; out vec4 o;
uniform sampler2D plate, chr, atlas;
uniform vec4 box, eyes, mouth, brows, fade;
uniform vec2 grid, span, center, head, pivot, iris, parallax;
uniform float W[18];
uniform float roll, turn, nodY, breath, light, premul;
vec4 cell(int i, vec2 f) {
  vec2 g = vec2(float(i % int(grid.x)), float(i / int(grid.x)));
  return texture(atlas, (g + clamp(f, .002, .998)) / grid);
}
float region(vec2 f, vec4 r) {
  vec2 d = abs(f - r.xy) / r.zw;
  return smoothstep(1., .55, max(d.x, d.y * 1.15) + .25 * min(d.x, d.y));
}
vec3 blend(vec3 col, vec2 f, int a, int b, float m) {
  float s = 0.; vec3 acc = vec3(0.);
  for (int i = a; i < b; i++) { acc += cell(i, f).rgb * W[i]; s += W[i]; }
  return s > .001 ? mix(col, acc / s, min(s, 1.) * m) : col;
}
void main() {
  vec2 uv = center + (v - .5) * span;
  vec2 q = uv;
  float hw = exp(-pow(length((q - head) * vec2(1., 1.25)) / .24, 2.6));
  float a = -roll * hw;
  q = pivot + mat2(cos(a), -sin(a), sin(a), cos(a)) * (q - pivot);
  q.x -= turn * exp(-pow(length((q - head) * vec2(1., 1.1)) / .17, 2.));
  q.y -= nodY * hw;
  float body = smoothstep(.45, .62, q.y);
  q.y -= breath * body * (q.y - 1.);
  q.x -= breath * .35 * body * (q.x - .5);
  vec4 c = texture(chr, q);
  if (premul > .5) c.rgb /= max(c.a, .001);
  vec2 f = (q - box.xy) / box.zw;
  if (all(greaterThan(f, vec2(0.))) && all(lessThan(f, vec2(1.)))) {
    float fm = smoothstep(0., .08, min(min(f.x, f.y), min(1. - f.x, 1. - f.y)));
    vec3 col = blend(cell(0, f).rgb, f, 1, 3, 1.);
    col = blend(col, f, 3, 5, region(f, brows));
    float me = region(f, eyes);
    col = mix(col, blend(cell(0, f - iris * me).rgb, f, 5, 11, 1.), me);
    col = blend(col, f, 11, 18, region(f, mouth));
    c.rgb = mix(c.rgb, col, fm * c.a);
  }
  vec3 rgb = mix(texture(plate, uv + parallax).rgb, c.rgb, c.a);
  rgb *= 1. + light * exp(-pow(length((uv - vec2(.17, .41)) * vec2(1., .6)) / .35, 2.));
  float edge = smoothstep(0., fade.x, v.y) * smoothstep(0., fade.y, 1. - v.y) * smoothstep(0., fade.z, v.x) * smoothstep(0., fade.z, 1. - v.x);
  o = vec4(rgb * edge, edge);
}`;

const CELLS = ["base", "smile", "laugh", "brows_up", "brows_knit", "blink", "half", "gaze_l", "gaze_r", "gaze_up", "gaze_down", ...MOUTHS, "m_f"];

/** The face's state for one frame: the edit weights by atlas cell and the warp, from the controller's pose. */
export class Face {
  constructor(rig) {
    this.rig = rig;
    this.idx = Object.fromEntries(rig.cells.map((n, i) => [n, i]));
    this.anim = new Animator();
    this.mouth = new Mouth();
    this.half = new Spring(3);
    this.w = new Float32Array(18);
  }
  step(dt, state, you, it) {
    const a = this.anim.step(dt, state, you, it), s = a.s, w = this.w, i = this.idx;
    w.fill(0);
    const set = (n, x) => { if (n in i) w[i[n]] = x; };
    set("smile", smooth(.1, .3, s.smile) * .6);
    set("brows_up", clamp((s.browUp - .06) * 1.6));
    set("brows_knit", s.focus * .7);
    const yawN = a.eyeYaw / rad(17), pitN = a.eyePitch / rad(11), open = 1 - smooth(0, .4, s.blink), shut = smooth(.45, .95, s.blink);
    set("gaze_l", smooth(.35, .8, -yawN) * open);
    set("gaze_r", smooth(.35, .8, yawN) * open);
    set("gaze_up", smooth(.3, .8, pitN) * .9 * open);
    set("gaze_down", smooth(.3, .8, -pitN) * open);
    set("half", Math.max(this.half.to(s.focus * .45 + s.smile * .3, dt), smooth(0, .4, s.blink)) * (1 - shut));
    set("blink", shut);
    for (const [n, x] of Object.entries(this.mouth.step(dt, s.jawOpen / .6, state === "speaking"))) set(n, x);
    const small = 1 - smooth(.35, .8, Math.abs(yawN)), [, , bw, bh] = this.rig.box, [W, H] = this.rig.size;
    return {
      w, roll: a.roll, turn: a.yaw * .055, nodY: -a.pitch * .03, breath: .006 * Math.sin(a.t * 2 * PI / 4.2),
      iris: [a.eyeYaw * this.rig.irisPx[0] / rad(10) / bw * small, -a.eyePitch * this.rig.irisPx[1] / rad(10) / bh * small],
      parallax: [a.yaw * -.01, a.pitch * .006], light: .03 * Math.sin(a.t * 1.7) * Math.sin(a.t * .37),
      box: [this.rig.box[0] / W, this.rig.box[1] / H, bw / W, bh / H],
    };
  }
}

/** How much of the picture a w x h view shows (cover, zoomed by view.zoom) and where, kept inside the picture. */
export function framing(rig, w, h) {
  const [W, H] = rig.size, view = rig.view || {}, zoom = view.zoom || 1, [fx, fy] = view.focus || [.5, .4];
  let sx = 1, sy = (h * W) / (w * H);
  if (sy > 1) { sx = 1 / sy; sy = 1; }
  sx /= zoom; sy /= zoom;
  return { span: [sx, sy], center: [clamp(fx, sx / 2, 1 - sx / 2), clamp(fy, sy / 2, 1 - sy / 2)] };
}

/** Draws the character at `base` (a persona folder URL) into a canvas until the returned stop is called. */
export async function illustration(canvas, base, now) {
  const rig = await (await fetch(base + "rig.json")).json();
  rig.cells ||= CELLS;
  const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true });
  if (!gl) throw new Error("no WebGL2");
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, ILLUSTRATION_FS]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n) => gl.getUniformLocation(prog, n);
  await Promise.all([["plate.jpg", "plate"], ["char.png", "chr"], ["atlas.jpg", "atlas"]].map(async ([file, name], unit) => {
    const img = new Image();
    img.src = base + file;
    await img.decode();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    gl.uniform1i(U(name), unit);
  }));
  gl.uniform2f(U("grid"), ...rig.grid);
  for (const k of ["eyes", "mouth", "brows"]) gl.uniform4f(U(k), ...rig.regions[k]);
  gl.uniform2f(U("head"), ...rig.head);
  gl.uniform2f(U("pivot"), ...rig.pivot);
  gl.uniform4f(U("fade"), ...(rig.view?.fade || [.06, .12, .04]), 0);
  gl.uniform1f(U("premul"), 0);
  const face = new Face(rig);
  let raf, last = performance.now();
  const frame = (ms) => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(.1, (ms - last) / 1000);
    last = ms;
    const k = Math.min(devicePixelRatio || 1, 2), w = Math.round(canvas.clientWidth * k), h = Math.round(canvas.clientHeight * k);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const { state, you, it } = now();
    const f = face.step(dt, state, you, it), view = framing(rig, w, h);
    gl.uniform1fv(U("W"), f.w);
    gl.uniform4f(U("box"), ...f.box);
    gl.uniform2f(U("span"), ...view.span);
    gl.uniform2f(U("center"), ...view.center);
    gl.uniform2f(U("iris"), ...f.iris);
    gl.uniform2f(U("parallax"), ...f.parallax);
    for (const k of ["roll", "turn", "nodY", "breath", "light"]) gl.uniform1f(U(k), f[k]);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };
  raf = requestAnimationFrame(frame);
  return () => cancelAnimationFrame(raf);
}
