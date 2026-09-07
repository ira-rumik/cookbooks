# Audio resampling and telephony codecs

The realtime socket speaks exactly one format: **PCM s16le, mono, 24 kHz**. Everything else you meet in the wild has to be converted on the way in and on the way out.

| source | what it gives you | conversion to Silk | conversion from Silk |
| --- | --- | --- | --- |
| Twilio Media Streams | μ-law, 8 kHz, 20 ms frames (160 bytes) | μ-law → s16 → ×3 upsample | ÷3 downsample (low-pass first) → μ-law |
| Plivo Audio Streams | μ-law 8 kHz **or** L16 8/16 kHz (you choose in the XML) | decode → resample | resample → encode |
| Exotel Voicebot | L16 (raw s16le), 8 kHz | ×3 upsample | ÷3 downsample |
| SIP trunk / Asterisk / FreeSWITCH | usually μ-law or A-law 8 kHz, sometimes L16 16 kHz | decode → resample | resample → encode |
| USB / laptop microphones | s16 or f32, 44.1 / 48 kHz | ÷1.8375 / ÷2 downsample | ×1.8375 / ×2 upsample |
| browser `AudioContext` | f32, whatever you asked for | ask for `{ sampleRate: 24000 }` and convert f32 → s16 | s16 → f32 |

## Rules of thumb

1. **Low-pass before you downsample.** Going 24 → 8 kHz without a filter folds everything above 4 kHz back into the audible band and the agent sounds "crunchy". A short windowed-sinc FIR (31–63 taps) is plenty for speech.
2. **Linear interpolation is fine for upsampling speech.** 8 → 24 kHz by linear interpolation is what most telephony bridges do; the missing high band was never there to begin with.
3. **Keep the resampler stateful.** Telephony frames are 20 ms; a resampler that forgets the last sample between frames clicks 50 times a second.
4. **Match the frame size on the way out.** 160 μ-law bytes in (8 kHz, 20 ms) become exactly 960 PCM bytes (24 kHz, 20 ms) — the frame size Silk recommends. Coincidence you should exploit.
5. **Flush on `interruption`.** Any converted audio you have queued for the carrier is stale the moment the caller talks over the agent. Twilio, Plivo and Exotel all have a "clear" message for exactly this.

## G.711 μ-law (PCMU)

μ-law compresses a 14-bit sample into 8 bits logarithmically. Encode and decode via a 256-entry table; it is far cheaper than doing the maths per sample.

```js
// reference: 8-bit μ-law ⇄ 16-bit linear
const BIAS = 0x84, CLIP = 32635;

function linearToMulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80, exponent = (u >> 4) & 0x07, mantissa = u & 0x0f;
  let sample = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -sample : sample;
}
```

Python has the same in `audioop.ulaw2lin` / `lin2ulaw` (removed in 3.13 — use the `audioop-lts` package there).

## G.711 A-law (PCMA)

The European sibling; same idea, different curve. See `10-nodejs-telephony-bridge/lib/codecs.js` for a table-driven implementation of both.

## Streaming linear resampler with a low-pass stage

This is the shape used by every bridge in the repository (`lib/resampler.js` in the Node cookbooks):

```
in (rate A) ──▶ [FIR low-pass, only if A > B] ──▶ [fractional-position linear interpolation] ──▶ out (rate B)
```

The FIR keeps `taps − 1` samples of history between calls; the interpolator keeps the last input sample and the fractional read position. Both are cheap enough to run per-call on a single Node.js thread for dozens of concurrent phone calls.

## Frame-size arithmetic

| rate | 20 ms | bytes (s16) |
| --- | --- | --- |
| 8 000 Hz | 160 samples | 320 |
| 16 000 Hz | 320 samples | 640 |
| 24 000 Hz | **480 samples** | **960** |
| 44 100 Hz | 882 samples | 1 764 |
| 48 000 Hz | 960 samples | 1 920 |

Silk's `append` limit is one second (48 000 bytes at 24 kHz); it does not care if your frames are 10, 20 or 100 ms, but 20 ms keeps latency low and matches what it sends back.
