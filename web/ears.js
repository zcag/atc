// How loud a voice is and where its energy sits, measured from the audio as it plays: what moves a character's mouth.

const SPEECH_GAIN = 2.5;
const scratch = new Float32Array(512);

export const rms = (an, gain = 6) => {
  if (!an) return 0;
  an.getFloatTimeDomainData(scratch);
  let s = 0;
  for (const v of scratch) s += v * v;
  return Math.min(1, Math.sqrt(s / scratch.length) * gain);
};

/** Taps a voice node: level() is its loudness, speech() is [loudness, below 700 Hz, above 3 kHz] as a character reads them. */
export function voiceTap(ctx, node) {
  const all = new AnalyserNode(ctx, { fftSize: 1024 }), low = new AnalyserNode(ctx, { fftSize: 1024 }), high = new AnalyserNode(ctx, { fftSize: 1024 });
  node.connect(all);
  node.connect(new BiquadFilterNode(ctx, { type: "lowpass", frequency: 700, Q: .5 })).connect(low);
  node.connect(new BiquadFilterNode(ctx, { type: "highpass", frequency: 3000, Q: .5 })).connect(high);
  return { level: () => rms(all), speech: () => [rms(all, SPEECH_GAIN), rms(low, SPEECH_GAIN), rms(high, SPEECH_GAIN)] };
}
