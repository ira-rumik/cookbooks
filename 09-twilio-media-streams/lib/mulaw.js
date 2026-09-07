// lib/mulaw.js — G.711 μ-law (PCMU) ⇄ 16-bit linear PCM, table driven.
//
// Twilio Media Streams carry μ-law at 8 kHz: 160 bytes per 20 ms frame.

const BIAS = 0x84;
const CLIP = 32635;

function encodeSample(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeSample(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}

// 256-entry decode table and a 14-bit (16 384-entry) encode table: no maths per sample at runtime.
const MULAW_TO_PCM = new Int16Array(256);
for (let u = 0; u < 256; u++) MULAW_TO_PCM[u] = decodeSample(u);

const PCM_TO_MULAW = new Uint8Array(16384);
for (let i = 0; i < 16384; i++) PCM_TO_MULAW[i] = encodeSample((i - 8192) << 2);

/** @param {Uint8Array|Buffer} bytes  @returns {Int16Array} */
export function mulawToPcm(bytes) {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TO_PCM[bytes[i]];
  return out;
}

/** @param {Int16Array} pcm  @returns {Buffer} */
export function pcmToMulaw(pcm) {
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = PCM_TO_MULAW[(pcm[i] >> 2) + 8192];
  return out;
}
