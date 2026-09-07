// local-mic.js — exercise the bridge end-to-end from your laptop, no carrier needed.
//
//   npm start            (terminal 1)
//   npm run mic          (terminal 2)
//
// Records the mic with node-record-lpcm16 at MIC_RATE, sends raw s16le frames
// to ws://localhost:PORT/pcm?rate=MIC_RATE&codec=l16, and plays what comes back
// through `speaker`. The bridge does the resampling to/from 24 kHz — the same
// path a carrier would take. `{"type":"clear"}` from the bridge flushes playback.
//
// Needs sox: brew install sox / apt install sox

import "dotenv/config";
import recorder from "node-record-lpcm16";
import Speaker from "speaker";
import WebSocket from "ws";

const PORT = process.env.PORT ?? 3000;
const RATE = Number(process.env.MIC_RATE ?? 16000);
const FRAME_BYTES = (RATE / 50) * 2; // 20 ms of s16

const speaker = new Speaker({ channels: 1, bitDepth: 16, sampleRate: RATE, signed: true });
let queue = Buffer.alloc(0);
const silence = Buffer.alloc(FRAME_BYTES);
setInterval(() => {                       // paced playout so a flush is heard quickly
  if (queue.length >= FRAME_BYTES) { speaker.write(queue.subarray(0, FRAME_BYTES)); queue = queue.subarray(FRAME_BYTES); }
  else speaker.write(silence);
}, 20);

const ws = new WebSocket(`ws://localhost:${PORT}/pcm?rate=${RATE}&codec=l16`);
ws.on("open", () => {
  console.log(`connected to bridge at ${RATE} Hz — talk, then talk over the agent`);
  const rec = recorder.record({ sampleRate: RATE, channels: 1, audioType: "raw", threshold: 0 });
  rec.stream().on("data", (chunk) => ws.readyState === WebSocket.OPEN && ws.send(chunk));
  process.on("SIGINT", () => { rec.stop(); ws.send(JSON.stringify({ type: "session.close" })); });
});
ws.on("message", (data, isBinary) => {
  if (isBinary) { queue = Buffer.concat([queue, data]); return; }
  const ev = JSON.parse(data.toString());
  if (ev.type === "clear") { console.log(`\x1b[92m● interrupted — dropped ${Math.round(queue.length / (RATE * 2 / 1000))} ms\x1b[0m`); queue = Buffer.alloc(0); }
  else if (ev.type === "agent_start_talking") console.log("\x1b[91m● agent speaking\x1b[0m");
  else if (ev.type === "agent_stop_talking") console.log("\x1b[90m○ listening\x1b[0m");
  else if (ev.type === "transcript") console.log(`   ${ev.role.padStart(9)}: ${ev.text}`);
  else if (ev.type === "session.closed") { console.log(`call ended: ${ev.reason}`); process.exit(0); }
});
ws.on("close", () => process.exit(0));
