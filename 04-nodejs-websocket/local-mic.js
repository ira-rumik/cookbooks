// local-mic.js — talk to the agent from your terminal (server-to-server).
//
//   npm run mic
//
// Records the microphone with node-record-lpcm16 (which shells out to sox /
// rec / arecord), resamples to 24 kHz if needed, streams to Silk, and plays
// the reply through the `speaker` package. Shows barge-in: on `interruption`
// the playback queue is dropped immediately.
//
// Install the recorder binary first: macOS `brew install sox`, Debian
// `apt install sox alsa-utils`.

import "dotenv/config";
import recorder from "node-record-lpcm16";
import Speaker from "speaker";
import { FRAME_BYTES, SAMPLE_RATE, SilkRealtimeSocket, registerCall } from "./lib/silk-socket.js";
import { Resampler, bufferToInt16, int16ToBuffer } from "./lib/resampler.js";

const { RUMIK_API_KEY, RUMIK_AGENT_ID } = process.env;
const MIC_RATE = Number(process.env.MIC_RATE ?? SAMPLE_RATE);

const red = (s) => `\x1b[91m${s}\x1b[0m`, green = (s) => `\x1b[92m${s}\x1b[0m`, grey = (s) => `\x1b[90m${s}\x1b[0m`;

/**
 * Paced playback: we keep our own queue and feed the speaker exactly one 20 ms
 * frame every 20 ms. That keeps the device's internal buffer shallow, so a
 * flush() on interruption is heard almost immediately.
 */
class PacedPlayer {
  constructor() {
    this.speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate: SAMPLE_RATE, signed: true });
    this.queue = Buffer.alloc(0);
    this.silence = Buffer.alloc(FRAME_BYTES);
    this.timer = setInterval(() => this.tick(), 20);
  }
  push(pcm) { this.queue = Buffer.concat([this.queue, pcm]); }
  flush() { const dropped = this.queue.length; this.queue = Buffer.alloc(0); return dropped; }
  tick() {
    if (this.queue.length >= FRAME_BYTES) {
      this.speaker.write(this.queue.subarray(0, FRAME_BYTES));
      this.queue = this.queue.subarray(FRAME_BYTES);
    } else {
      this.speaker.write(this.silence); // keep the stream continuous
    }
  }
  stop() { clearInterval(this.timer); this.speaker.end(); }
}

async function main() {
  const reg = await registerCall({ apiKey: RUMIK_API_KEY, agentId: RUMIK_AGENT_ID });
  const call = new SilkRealtimeSocket(reg.access_token);
  const player = new PacedPlayer();
  const resampler = MIC_RATE === SAMPLE_RATE ? null : new Resampler(MIC_RATE, SAMPLE_RATE);

  call.on("audio", (pcm) => player.push(pcm));
  call.on("agent_start_talking", () => console.log(red("● agent speaking")));
  call.on("agent_stop_talking", () => console.log(grey("○ listening")));
  call.on("interruption", () => {
    const dropped = player.flush(); // ← barge-in: drop everything queued
    console.log(green(`● you interrupted — dropped ${Math.round(dropped / 48)} ms of queued audio`));
  });
  call.on("transcript", ({ role, text }) => console.log(`   ${role.padStart(9)}: ${text}`));
  call.on("silk_error", (e) => console.error(`error ${e.code}: ${e.message}`));
  call.on("session.closed", ({ reason }) => console.log(`\ncall ended: ${reason}`));
  call.on("close", () => { player.stop(); rec.stop(); process.exit(0); });

  const created = await call.connect(); // waits for session.created
  console.log(`call ${created.call_id} · ${created.sample_rate} Hz · mic at ${MIC_RATE} Hz · Ctrl+C to hang up\n`);

  // microphone → (resample) → Silk
  const rec = recorder.record({ sampleRate: MIC_RATE, channels: 1, audioType: "raw", threshold: 0 });
  rec.stream().on("data", (chunk) => {
    const pcm = resampler ? int16ToBuffer(resampler.process(bufferToInt16(chunk))) : chunk;
    call.sendAudio(pcm);
  });

  process.on("SIGINT", () => { console.log("\nhanging up…"); call.close(); });
}

main().catch((err) => { console.error("could not start call:", err.message); process.exit(1); });
