/**
 * D #44 — band-limited downsampling for browser-direct listening.
 *
 * Bug: the capture worklet reduced 48 kHz microphone audio to 16 kHz by KEEPING every third sample and dropping the
 * rest, with no low-pass filter. Everything above 8 kHz (fricatives, room noise, keyboard clicks) folded back into the
 * speech band as aliasing, which distorts consonants and lowers transcription accuracy.
 *
 * Now: a Hann-windowed-sinc FIR low-pass (cut-off 0.45 x the OUTPUT rate, ~8 zero crossings) evaluated at each output
 * position, streaming across 128-sample worklet blocks and valid for any input rate (48000, 44100, 32000, ...).
 *
 * The implementation is ONE plain-JavaScript source string. The AudioWorklet is built from exactly this string, and the
 * unit tests evaluate exactly this string — what is tested is what ships (a worklet cannot import modules).
 */
export const DOWNSAMPLER_SRC = `
class Downsampler {
  constructor(inRate, outRate) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.ratio = inRate / outRate;
    // Cut-off as a fraction of the INPUT rate (cycles/sample): 0.45 of the output Nyquist-pair => 0.45 * outRate / inRate.
    this.fc = 0.45 / Math.max(1, this.ratio);
    this.radius = Math.ceil(8 * Math.max(1, this.ratio));
    this.pass = this.ratio <= 1; // nothing to filter when not reducing the rate
    // Prime with silence so the first outputs have a full kernel (adds radius/inRate seconds of latency, ~0.5 ms at 48k).
    this.buf = new Float32Array(this.radius);
    this.pos = this.radius; // centre of the next output sample, in buffer index units
  }
  weight(d) {
    // d = distance (input samples) from the output centre
    const a = Math.abs(d);
    if (a >= this.radius) return 0;
    const x = 2 * this.fc * d;
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const hann = 0.5 * (1 + Math.cos((Math.PI * d) / this.radius));
    return 2 * this.fc * sinc * hann;
  }
  push(input) {
    if (this.pass) return Float32Array.from(input);
    const merged = new Float32Array(this.buf.length + input.length);
    merged.set(this.buf, 0);
    merged.set(input, this.buf.length);
    const out = [];
    const r = this.radius;
    while (Math.floor(this.pos + r) < merged.length) {
      const c = this.pos;
      const lo = Math.ceil(c - r);
      const hi = Math.floor(c + r);
      let acc = 0;
      let wsum = 0;
      for (let i = lo; i <= hi; i++) {
        const w = this.weight(i - c);
        acc += merged[i] * w;
        wsum += w;
      }
      out.push(wsum !== 0 ? acc / wsum : 0); // normalised: unity gain at DC regardless of the fractional phase
      this.pos += this.ratio;
    }
    // Keep only what a future output can still touch.
    const keepFrom = Math.max(0, Math.floor(this.pos - r) - 1);
    this.buf = merged.slice(keepFrom);
    this.pos -= keepFrom;
    return Float32Array.from(out);
  }
}
`

export interface DownsamplerLike {
  push(input: Float32Array): Float32Array
}

/** Test/helper factory: the exact worklet implementation, instantiated in the current realm. */
export function createDownsampler(inRate: number, outRate: number): DownsamplerLike {
  const Ctor = new Function(`${DOWNSAMPLER_SRC}; return Downsampler;`)() as new (a: number, b: number) => DownsamplerLike
  return new Ctor(inRate, outRate)
}

/** The naive decimation the worklet used to do (kept ONLY so tests can prove it aliased). */
export function naiveDecimate(input: Float32Array, inRate: number, outRate: number): Float32Array {
  const ratio = inRate / outRate
  const out: number[] = []
  let acc = 0
  for (let i = 0; i < input.length; i++) {
    acc += 1
    if (acc >= ratio) {
      acc -= ratio
      out.push(input[i])
    }
  }
  return Float32Array.from(out)
}

/** Source of the capture AudioWorklet: filtered downsample to 16 kHz, 50 ms Int16 frames. */
export const CAPTURE_WORKLET_SRC = `${DOWNSAMPLER_SRC}
class Capture extends AudioWorkletProcessor {
  constructor(){ super(); this.ds = new Downsampler(sampleRate, 16000); this.buf = []; }
  process(inputs){
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const down = this.ds.push(ch);
    for (let i = 0; i < down.length; i++) this.buf.push(down[i]);
    if (this.buf.length >= 800) { // 50 ms @ 16 kHz
      const out = new Int16Array(this.buf.length);
      for (let i = 0; i < this.buf.length; i++) { const s = Math.max(-1, Math.min(1, this.buf[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
      this.port.postMessage(out.buffer, [out.buffer]);
      this.buf = [];
    }
    return true;
  }
}
registerProcessor('rv-capture', Capture);
`
