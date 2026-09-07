// lib/resampler.js — streaming sample-rate conversion for Int16 PCM.
//
//   const rs = new Resampler(16000, 24000);
//   const out = rs.process(int16In);   // Int16Array at 24 kHz, stateful across calls
//
// Downsampling runs a windowed-sinc low-pass first (to avoid aliasing), then
// both directions use fractional-position linear interpolation, which is
// plenty for speech. State (filter history + read position) survives between
// calls so 20 ms frames join without clicks.

function designLowPass(taps, cutoffNorm) {
  const h = new Float32Array(taps);
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const k = n - m;
    const sinc = k === 0 ? 2 * cutoffNorm : Math.sin(2 * Math.PI * cutoffNorm * k) / (Math.PI * k);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / (taps - 1));
    h[n] = sinc * hamming;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

class FirFilter {
  constructor(h) {
    this.h = h;
    this.hist = new Float32Array(h.length - 1);
  }
  process(x) {
    const { h, hist } = this;
    const taps = h.length;
    const buf = new Float32Array(hist.length + x.length);
    buf.set(hist, 0);
    buf.set(x, hist.length);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let acc = 0;
      const base = i + taps - 1;
      for (let j = 0; j < taps; j++) acc += h[j] * buf[base - j];
      out[i] = acc;
    }
    this.hist.set(buf.subarray(buf.length - hist.length));
    return out;
  }
}

export class Resampler {
  constructor(inRate, outRate, { taps = 47 } = {}) {
    this.inRate = inRate;
    this.outRate = outRate;
    this.step = inRate / outRate; // input samples per output sample
    this.pos = 0;                 // fractional read position relative to `prev`
    this.prev = 0;                // last input sample from the previous call
    this.lowpass = inRate > outRate ? new FirFilter(designLowPass(taps, (0.45 * outRate) / inRate)) : null;
  }

  /** @param {Int16Array} input  @returns {Int16Array} */
  process(input) {
    if (this.inRate === this.outRate) return input;

    let x = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) x[i] = input[i];
    if (this.lowpass) x = this.lowpass.process(x);

    // src = [prev, x0, x1, …]; interpolate between src[i] and src[i+1]
    const src = new Float32Array(x.length + 1);
    src[0] = this.prev;
    src.set(x, 1);

    const outLen = Math.max(0, Math.ceil((src.length - 1 - this.pos) / this.step));
    const out = new Int16Array(outLen);
    let pos = this.pos;
    let n = 0;
    while (pos < src.length - 1 && n < outLen) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const v = src[i] + (src[i + 1] - src[i]) * frac;
      out[n++] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
      pos += this.step;
    }
    this.pos = pos - (src.length - 1);
    this.prev = src[src.length - 1];
    return n === outLen ? out : out.subarray(0, n);
  }
}

/** Buffer (s16le) → Int16Array view without copying. */
export function bufferToInt16(buf) {
  return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
}

/** Int16Array → Buffer view without copying. */
export function int16ToBuffer(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}
