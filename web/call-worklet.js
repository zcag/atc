const IN_RATE = 16000, IN_FRAME = 320, OUT_RATE = 24000;
const MIN_HOLD = 3, MAX_HOLD = 15, SLACK = 10;

class Up extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / IN_RATE;
    this.t = 0;
    this.prev = 0;
    this.frame = new Int16Array(IN_FRAME);
    this.n = 0;
    this.quiet = false;
    this.port.onmessage = (e) => {
      this.quiet = e.data.quiet;
      if (e.data.ack) this.port.postMessage("closed");
    };
  }

  process(inputs) {
    const x = inputs[0][0];
    if (!x) return true;
    const at = (i) => (i < 0 ? this.prev : x[i]);
    let t = this.t;
    for (; t < x.length - 1; t += this.step) {
      const i = Math.floor(t), f = t - i;
      const v = this.quiet ? 0 : at(i) + (at(i + 1) - at(i)) * f;
      this.frame[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
      if (this.n === IN_FRAME) {
        const out = this.frame.buffer;
        this.port.postMessage(out, [out]);
        this.frame = new Int16Array(IN_FRAME);
        this.n = 0;
      }
    }
    this.t = t - x.length;
    this.prev = x[x.length - 1];
    return true;
  }
}

class Down extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = OUT_RATE / sampleRate;
    this.q = [];
    this.cur = null;
    this.at = 0;
    this.a = 0;
    this.b = 0;
    this.frac = 0;
    this.hold = MIN_HOLD + 1;
    this.holdMax = this.hold;
    this.buffering = true;
    this.started = false;
    this.clean = currentTime;
    this.report = currentTime;
    this.s = { played: 0, underruns: 0, dropped: 0, deepest: 0 };
    this.port.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) this.q.push(new Int16Array(e.data));
      else if (e.data === "flush") { this.q = []; this.cur = null; }
    };
  }

  next() {
    if (!this.cur || this.at >= this.cur.length) {
      this.cur = this.pop();
      this.at = 0;
      if (!this.cur) return 0;
    }
    return this.cur[this.at++] / 32768;
  }

  pop() {
    if (this.buffering) {
      if (this.q.length < this.hold) return null;
      this.buffering = false;
      this.started = true;
    }
    const f = this.q.shift();
    if (!f) {
      this.buffering = true;
      this.hold = Math.min(this.hold + 2, MAX_HOLD);
      this.holdMax = Math.max(this.holdMax, this.hold);
      this.s.underruns++;
      this.clean = currentTime;
      return null;
    }
    if (currentTime - this.clean >= 10 && this.hold > MIN_HOLD) {
      this.hold--;
      this.clean = currentTime;
    }
    this.s.deepest = Math.max(this.s.deepest, this.q.length);
    while (this.q.length > this.hold + SLACK) {
      this.q.shift();
      this.s.dropped++;
    }
    this.s.played++;
    return f;
  }

  process(_, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      while (this.frac >= 1) {
        this.a = this.b;
        this.b = this.next();
        this.frac -= 1;
      }
      out[i] = this.a + (this.b - this.a) * this.frac;
      this.frac += this.step;
    }
    if (currentTime - this.report >= 1) {
      this.report = currentTime;
      const s = this.s;
      this.port.postMessage({ played: s.played, underruns: s.underruns, dropped: s.dropped, hold_ms: this.hold * 20, hold_max_ms: this.holdMax * 20, deepest_ms: s.deepest * 20 });
    }
    return true;
  }
}

registerProcessor("call-up", Up);
registerProcessor("call-down", Down);
