// adapters/exotel.js — Exotel Voicebot applet (bidirectional stream).
//
// Configure the Voicebot applet's URL as wss://host/exotel. Exotel streams
// raw 16-bit PCM (base64) at 8 kHz mono in both directions.
//
// Inbound events: connected, start { start: { stream_sid, call_sid, from, to, media_format: { sample_rate } } },
//                 media { media: { payload } }, dtmf, stop, mark
// Outbound:       { event: "media", stream_sid, media: { payload } }
//                 { event: "clear", stream_sid }   ← barge-in
//
// Exotel wants outbound chunks that are a multiple of 320 bytes and at least
// ~3.2 kB, so the bridge batches ~200 ms before sending.
import { WebSocket } from "ws";
import { CallBridge } from "../lib/call-bridge.js";

export function attachExotel(ws) {
  let streamSid = null;
  let bridge = null;
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.event) {
      case "connected":
        break;
      case "start": {
        streamSid = msg.start?.stream_sid ?? msg.stream_sid;
        const rate = Number(msg.start?.media_format?.sample_rate ?? 8000);
        bridge = new CallBridge({
          label: `exotel:${msg.start?.call_sid ?? streamSid}`,
          outChunkBytes: rate * 2 * 0.2,   // 200 ms of s16 at the carrier rate (3 200 B @ 8 kHz)
          onAudioOut: (bytes) => send({ event: "media", stream_sid: streamSid, media: { payload: bytes.toString("base64") } }),
          onClear: () => send({ event: "clear", stream_sid: streamSid }),
          onEnd: () => ws.readyState === WebSocket.OPEN && ws.close(),
        });
        bridge.configure({ inRate: rate, inCodec: "l16" });
        try { await bridge.start(); } catch (e) { console.error("[exotel] silk start failed:", e.message); ws.close(); }
        break;
      }
      case "media":
        bridge?.pushCallerAudio(Buffer.from(msg.media.payload, "base64"));
        break;
      case "dtmf":
        bridge?.sendText(`[caller pressed ${msg.dtmf?.digit}]`);
        break;
      case "stop":
        bridge?.end();
        break;
    }
  });
  ws.on("close", () => bridge?.end());
}
