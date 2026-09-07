// adapters/plivo.js — Plivo Audio Streams (bidirectional).
//
// Answer XML (served by bridge.js at POST /plivo/answer):
//   <Response>
//     <Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">wss://host/plivo</Stream>
//   </Response>
//
// Inbound events: start { start: { callId, streamId, mediaFormat: { encoding, sampleRate } } },
//                 media { media: { payload (base64) } }, dtmf, stop
// Outbound:       { event: "playAudio", media: { contentType, sampleRate, payload } }
//                 { event: "clearAudio" }   ← barge-in
import { WebSocket } from "ws";
import { CallBridge } from "../lib/call-bridge.js";
import { normaliseCodec } from "../lib/codecs.js";

const CONTENT_TYPE = process.env.PLIVO_CONTENT_TYPE ?? "audio/x-l16;rate=16000";

export function plivoAnswerXml(publicHost) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" keepCallAlive="true" contentType="${CONTENT_TYPE}">wss://${publicHost}/plivo</Stream>
</Response>`;
}

export function attachPlivo(ws) {
  let streamId = null;
  let bridge = null;
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));

  // Plivo's outbound format is whatever we asked for in the XML.
  const [ctype, rateStr] = CONTENT_TYPE.split(";rate=");
  const outCodec = normaliseCodec(ctype), outRate = Number(rateStr ?? 8000);

  ws.on("message", async (raw) => {
    const msg = JSON.parse(raw.toString());
    switch (msg.event) {
      case "start": {
        streamId = msg.start?.streamId ?? msg.streamId;
        const fmt = msg.start?.mediaFormat ?? {};
        bridge = new CallBridge({
          label: `plivo:${msg.start?.callId ?? streamId}`,
          onAudioOut: (bytes) => send({ event: "playAudio", media: { contentType: ctype, sampleRate: outRate, payload: bytes.toString("base64") } }),
          onClear: () => send({ event: "clearAudio", streamId }),
          onEnd: () => ws.readyState === WebSocket.OPEN && ws.close(),
        });
        // dynamic: the rate/codec come from Plivo's start event, not from our config
        bridge.configure({ inRate: Number(fmt.sampleRate ?? outRate), inCodec: normaliseCodec(fmt.encoding ?? ctype), outRate, outCodec });
        try { await bridge.start(); } catch (e) { console.error("[plivo] silk start failed:", e.message); ws.close(); }
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
