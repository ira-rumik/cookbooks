// adapters/generic-pcm.js — raw audio over a WebSocket, for SIP trunks and
// anything you wrote yourself (Asterisk AudioSocket forwarders, FreeSWITCH
// mod_audio_fork, a softphone, a test harness).
//
//   ws://host/pcm?rate=16000&codec=l16        (codec: l16 | mulaw | alaw)
//
// In:  binary frames of caller audio in that codec/rate (any frame size).
// Out: binary frames of agent audio in the same codec/rate, plus JSON text
//      frames for control events: {"type":"clear"} on barge-in, and every
//      Silk event (transcript, agent_start_talking, session.closed, …).
import { WebSocket } from "ws";
import { CallBridge } from "../lib/call-bridge.js";
import { normaliseCodec } from "../lib/codecs.js";

export async function attachGenericPcm(ws, req) {
  const url = new URL(req.url, "http://x");
  const rate = Number(url.searchParams.get("rate") ?? 16000);
  const codec = normaliseCodec(url.searchParams.get("codec") ?? "l16");

  const bridge = new CallBridge({
    label: `pcm:${req.socket.remoteAddress}`,
    onAudioOut: (bytes) => ws.readyState === WebSocket.OPEN && ws.send(bytes, { binary: true }),
    onClear: () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "clear" })),
    onEvent: (ev) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(ev)),
    onEnd: () => ws.readyState === WebSocket.OPEN && ws.close(),
  });
  bridge.configure({ inRate: rate, inCodec: codec });

  ws.on("message", (data, isBinary) => {
    if (isBinary) return bridge.pushCallerAudio(data);
    const msg = JSON.parse(data.toString());
    if (msg.type === "input_text.send") bridge.sendText(msg.text);
    if (msg.type === "session.close") bridge.end();
  });
  ws.on("close", () => bridge.end());

  try { await bridge.start(); } catch (e) { console.error("[pcm] silk start failed:", e.message); ws.close(); }
}
