// lib/codecs.js — telephony codecs ⇄ 16-bit linear PCM.
//
//   decode(codec, Buffer)      -> Int16Array
//   encode(codec, Int16Array)  -> Buffer
//
// codec: "l16" (raw s16le), "mulaw" (G.711 PCMU), "alaw" (G.711 PCMA)

const BIAS = 0x84;
const CLIP = 32635;

// ---- μ-law -------------------------------------------------------------
function mulawEncodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}
function mulawDecodeSample(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

// ---- A-law -------------------------------------------------------------
function alawEncodeSample(sample) {
  let sign = (~sample >> 8) & 0x80;
  if (!sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = exponent === 0 ? (sample >> 4) & 0x0f : (sample >> (exponent + 3)) & 0x0f;
  return (sign | (exponent << 4) | mantissa) ^ 0x55;
}
function alawDecodeSample(a) {
  a ^= 0x55;
  const sign = a & 0x80, exponent = (a >> 4) & 0x07;
  let sample = (a & 0x0f) << 4;
  sample = exponent === 0 ? sample + 8 : (sample + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}

// ---- tables -------------------------------------------------------------
const MULAW_DEC = new Int16Array(256), ALAW_DEC = new Int16Array(256);
for (let i = 0; i < 256; i++) { MULAW_DEC[i] = mulawDecodeSample(i); ALAW_DEC[i] = alawDecodeSample(i); }
const MULAW_ENC = new Uint8Array(16384), ALAW_ENC = new Uint8Array(16384);
for (let i = 0; i < 16384; i++) { const s = (i - 8192) << 2; MULAW_ENC[i] = mulawEncodeSample(s); ALAW_ENC[i] = alawEncodeSample(s); }

// ---- public API ---------------------------------------------------------
export const CODECS = ["l16", "mulaw", "alaw"];

/** Normalise the many spellings carriers use: "audio/x-mulaw", "PCMU", "audio/x-l16", "raw", … */
export function normaliseCodec(name = "") {
  const n = String(name).toLowerCase();
  if (n.includes("mulaw") || n.includes("pcmu") || n.includes("ulaw")) return "mulaw";
  if (n.includes("alaw") || n.includes("pcma")) return "alaw";
  return "l16";
}

/** @returns {Int16Array} */
export function decode(codec, buf) {
  switch (codec) {
    case "l16": return new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength >> 1);
    case "mulaw": { const out = new Int16Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = MULAW_DEC[buf[i]]; return out; }
    case "alaw": { const out = new Int16Array(buf.length); for (let i = 0; i < buf.length; i++) out[i] = ALAW_DEC[buf[i]]; return out; }
    default: throw new Error(`unknown codec ${codec}`);
  }
}

/** @returns {Buffer} */
export function encode(codec, pcm) {
  switch (codec) {
    case "l16": return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    case "mulaw": { const out = Buffer.allocUnsafe(pcm.length); for (let i = 0; i < pcm.length; i++) out[i] = MULAW_ENC[(pcm[i] >> 2) + 8192]; return out; }
    case "alaw": { const out = Buffer.allocUnsafe(pcm.length); for (let i = 0; i < pcm.length; i++) out[i] = ALAW_ENC[(pcm[i] >> 2) + 8192]; return out; }
    default: throw new Error(`unknown codec ${codec}`);
  }
}
