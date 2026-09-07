// lib/call-bridge.js — the provider-agnostic core.
//
// One CallBridge per phone call. The adapter tells it what the carrier speaks
// (codec + sample rate, usually only known once the carrier's `start` event
// arrives — hence `configure()` is separate from construction), then pushes
// caller audio in and receives agent audio out, already converted.
//
//   const bridge = new CallBridge({
//     label: "plivo:…",
//     onAudioOut: (bytes) => …,   // encoded in the carrier's codec, at the carrier's rate
//     onClear:    () => …,        // barge-in: tell the carrier to drop its playout buffer
//     onEvent:    (ev) => …,      // transcripts etc., optional
//     onEnd:      () => …,        // Silk session over
//   });
//   bridge.configure({ inRate: 8000, inCodec: "mulaw" });   // out* default to in*
//   await bridge.start();                                    // register + connect + session.created
//   bridge.pushCallerAudio(buffer);                          // repeatedly
//   bridge.end();

import { SilkRealtimeSocket, registerCall, SAMPLE_RATE as SILK_RATE } from "./silk-socket.js";
import { Resampler, bufferToInt16, int16ToBuffer } from "./resampler.js";
import { decode, encode } from "./codecs.js";

const { RUMIK_API_KEY, RUMIK_AGENT_ID, SILK_BASE_URL } = process.env;

export class CallBridge {
  constructor({ label = "call", onAudioOut, onClear, onEvent, onEnd, outChunkBytes = 0 } = {}) {
    this.label = label;
    this.onAudioOut = onAudioOut ?? (() => {});
    this.onClear = onClear ?? (() => {});
    this.onEvent = onEvent ?? (() => {});
    this.onEnd = onEnd ?? (() => {});
    this.outChunkBytes = outChunkBytes;   // >0: batch outbound audio to this many bytes (some carriers require minimum chunks)
    this.outBatch = [];
    this.outBatchLen = 0;
    this.silk = null;
    this.ready = false;
    this.dropped = 0;
    this.configured = false;
  }

  log(msg) { console.log(`[${this.label}] ${msg}`); }

  /** Build the converters for the carrier's format. Call once the format is known. */
  configure({ inRate, inCodec = "l16", outRate = inRate, outCodec = inCodec }) {
    this.inCodec = inCodec;
    this.outCodec = outCodec;
    this.up = new Resampler(inRate, SILK_RATE);      // carrier → Silk
    this.down = new Resampler(SILK_RATE, outRate);   // Silk → carrier
    this.configured = true;
    this.log(`format in=${inCodec}@${inRate} out=${outCodec}@${outRate} ⇄ silk=l16@${SILK_RATE}`);
  }

  async start() {
    if (!this.configured) throw new Error("configure() before start()");
    const reg = await registerCall({ apiKey: RUMIK_API_KEY, agentId: RUMIK_AGENT_ID, baseUrl: SILK_BASE_URL });
    const silk = new SilkRealtimeSocket(reg.access_token, { baseUrl: SILK_BASE_URL });

    silk.on("audio", (pcm) => this.#agentAudio(pcm));
    silk.on("interruption", () => {                 // ← barge-in
      this.outBatch = []; this.outBatchLen = 0;     // drop what we have not sent yet…
      this.onClear();                               // …and tell the carrier to drop what it has
      this.log("caller interrupted → clear");
    });
    silk.on("agent_start_talking", () => this.log("agent speaking"));
    silk.on("agent_stop_talking", () => this.log("agent listening"));
    silk.on("transcript", ({ role, text }) => this.log(`${role}: ${text}`));
    silk.on("event", (ev) => this.onEvent(ev));
    silk.on("silk_error", (e) => this.log(`silk error ${e.code}: ${e.message}`));
    silk.on("session.closed", ({ reason }) => this.log(`silk session closed: ${reason}`));
    silk.on("close", () => { this.ready = false; this.onEnd(); });

    const created = await silk.connect();           // session.created
    this.silk = silk;
    this.ready = true;
    this.log(`silk call ${created.call_id} live (dropped ${this.dropped} early frames)`);
    return created;
  }

  /** Caller audio in the carrier's codec/rate → Silk. Frames before session.created are dropped. */
  pushCallerAudio(buf) {
    if (!this.ready) { this.dropped++; return; }
    const pcm = decode(this.inCodec, buf);
    const pcm24k = this.up.process(pcm);
    this.silk.sendAudio(int16ToBuffer(pcm24k));
  }

  sendText(text) { this.silk?.sendText(text); }

  end() { this.silk?.close(); }

  #agentAudio(pcm) {
    const out = encode(this.outCodec, this.down.process(bufferToInt16(pcm)));
    if (!this.outChunkBytes) return this.onAudioOut(out);
    this.outBatch.push(out);
    this.outBatchLen += out.length;
    if (this.outBatchLen >= this.outChunkBytes) {
      const chunk = Buffer.concat(this.outBatch);
      this.outBatch = []; this.outBatchLen = 0;
      this.onAudioOut(chunk);
    }
  }
}
