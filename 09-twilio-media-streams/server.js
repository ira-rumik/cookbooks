// server.js — answer a phone call with a Silk voice agent.
//
//   POST /voice   Twilio's incoming-call webhook. Replies with TwiML that tells
//                 Twilio to open a bidirectional Media Stream to wss://…/media.
//   WS   /media   Twilio's media stream. One connection per call. This process
//                 is the "real-time translator":
//
//     Twilio ── μ-law 8 kHz, 160 B / 20 ms ──▶ decode ──▶ ×3 resample ──▶ Silk (PCM 24 kHz, 960 B / 20 ms)
//     Twilio ◀── μ-law 8 kHz ◀── encode ◀── low-pass + ÷3 ◀────────────── Silk (output_audio.delta)
//
//   Barge-in: Silk sends `interruption` → we send Twilio `clear`, which drops
//   every audio chunk Twilio has buffered but not yet played to the caller.

import "dotenv/config";
import http from "node:http";
import express from "express";
import twilio from "twilio";
import { WebSocket, WebSocketServer } from "ws";
import { SilkRealtimeSocket, registerCall, SAMPLE_RATE as SILK_RATE } from "./lib/silk-socket.js";
import { mulawToPcm, pcmToMulaw } from "./lib/mulaw.js";
import { Resampler, bufferToInt16, int16ToBuffer } from "./lib/resampler.js";

const { RUMIK_API_KEY, RUMIK_AGENT_ID, SILK_BASE_URL, PORT = 3000, PUBLIC_HOST, TWILIO_AUTH_TOKEN } = process.env;
if (!RUMIK_API_KEY || !RUMIK_AGENT_ID) {
  console.error("Set RUMIK_API_KEY and RUMIK_AGENT_ID");
  process.exit(1);
}

const TWILIO_RATE = 8000;

// ------------------------------------------------------------------ webhook
const app = express();
app.use(express.urlencoded({ extended: false }));

// With TWILIO_AUTH_TOKEN set, requests that are not signed by Twilio get a 403.
const validateTwilio = TWILIO_AUTH_TOKEN ? twilio.webhook({ validate: true }) : (_req, _res, next) => next();

app.post("/voice", validateTwilio, (req, res) => {
  const host = PUBLIC_HOST || req.headers.host;
  const twiml = new twilio.twiml.VoiceResponse();
  const stream = twiml.connect().stream({ url: `wss://${host}/media` });
  // Custom parameters show up in the stream's `start` event → handy for CRM lookups.
  stream.parameter({ name: "from", value: req.body.From ?? "" });
  stream.parameter({ name: "to", value: req.body.To ?? "" });

  console.log(`[twilio] incoming ${req.body.CallSid} from ${req.body.From}`);
  res.type("text/xml").send(twiml.toString());
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ------------------------------------------------------------------ media stream
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://x").pathname !== "/media") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws) => new TwilioBridge(ws));

class TwilioBridge {
  constructor(ws) {
    this.ws = ws;
    this.streamSid = null;
    this.callSid = null;
    this.silk = null;
    this.ready = false;                                   // true after session.created
    this.up = new Resampler(TWILIO_RATE, SILK_RATE);      // caller → agent  (×3)
    this.down = new Resampler(SILK_RATE, TWILIO_RATE);    // agent → caller  (÷3, low-passed)
    this.dropped = 0;

    ws.on("message", (raw) => this.onTwilio(JSON.parse(raw.toString())));
    ws.on("close", () => this.silk?.close());
    ws.on("error", (e) => console.error("[twilio] ws error", e.message));
  }

  log(msg) {
    console.log(`[${this.callSid ?? "call"}] ${msg}`);
  }

  async onTwilio(msg) {
    switch (msg.event) {
      case "connected":
        break;
      case "start":
        this.streamSid = msg.start.streamSid;
        this.callSid = msg.start.callSid;
        this.log(`stream ${this.streamSid} started from ${msg.start.customParameters?.from ?? "?"} (${msg.start.mediaFormat?.encoding} ${msg.start.mediaFormat?.sampleRate} Hz)`);
        await this.startSilk();
        break;
      case "media":
        // Twilio emits inbound audio before Silk is ready; Silk must not receive audio
        // before session.created, so those first frames are dropped.
        if (!this.ready) { this.dropped++; break; }
        if (msg.media.track && msg.media.track !== "inbound") break;
        this.forwardCallerAudio(msg.media.payload);
        break;
      case "mark":
        break;
      case "stop":
        this.log("caller hung up");
        this.silk?.close();
        break;
    }
  }

  async startSilk() {
    try {
      const reg = await registerCall({ apiKey: RUMIK_API_KEY, agentId: RUMIK_AGENT_ID, baseUrl: SILK_BASE_URL });
      const silk = new SilkRealtimeSocket(reg.access_token, { baseUrl: SILK_BASE_URL });

      silk.on("audio", (pcm) => this.forwardAgentAudio(pcm));
      silk.on("interruption", () => {                    // ← barge-in
        this.send({ event: "clear", streamSid: this.streamSid });
        this.log("caller interrupted → sent clear");
      });
      silk.on("agent_start_talking", () => this.log("agent speaking"));
      silk.on("agent_stop_talking", () => this.log("agent listening"));
      silk.on("transcript", ({ role, text }) => this.log(`${role}: ${text}`));
      silk.on("silk_error", (e) => this.log(`silk error ${e.code}: ${e.message}`));
      silk.on("session.closed", ({ reason }) => this.log(`silk session closed: ${reason}`));
      silk.on("close", () => {
        // Ending the stream makes Twilio continue with the TwiML after <Connect>;
        // there is none, so Twilio hangs up.
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
      });

      const created = await silk.connect();               // resolves on session.created
      this.silk = silk;
      this.ready = true;
      this.log(`silk call ${created.call_id} live (dropped ${this.dropped} early frames)`);
    } catch (err) {
      this.log(`could not start silk call: ${err.message}`);
      this.ws.close();
    }
  }

  /** 160 μ-law bytes (20 ms @ 8 kHz) → 960 PCM bytes (20 ms @ 24 kHz): exactly one Silk frame. */
  forwardCallerAudio(b64) {
    const pcm8k = mulawToPcm(Buffer.from(b64, "base64"));
    const pcm24k = this.up.process(pcm8k);
    this.silk.sendAudio(int16ToBuffer(pcm24k));
  }

  /** 960 PCM bytes (24 kHz) → 160 μ-law bytes (8 kHz) → Twilio media event. */
  forwardAgentAudio(pcm) {
    const pcm8k = this.down.process(bufferToInt16(pcm));
    const payload = pcmToMulaw(pcm8k).toString("base64");
    this.send({ event: "media", streamSid: this.streamSid, media: { payload } });
  }

  send(obj) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }
}

server.listen(Number(PORT), () => {
  console.log(`Twilio ⇄ Silk bridge on :${PORT}`);
  console.log(`  webhook : POST https://${PUBLIC_HOST || "<public-host>"}/voice`);
  console.log(`  stream  : wss://${PUBLIC_HOST || "<public-host>"}/media`);
});
