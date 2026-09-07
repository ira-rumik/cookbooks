// bridge.js — one server, three adapters.
//
//   POST /plivo/answer   Plivo answer URL → XML that opens a bidirectional stream to /plivo
//   WS   /plivo          Plivo Audio Streams
//   WS   /exotel         Exotel Voicebot applet
//   WS   /pcm?rate=&codec=   raw PCM/μ-law/A-law frames (SIP bridges, custom clients, local-mic.js)
//
// Every adapter normalises its carrier into lib/call-bridge.js, which owns the
// Silk socket, the codec conversion and the dynamic resampling.

import "dotenv/config";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { attachPlivo, plivoAnswerXml } from "./adapters/plivo.js";
import { attachExotel } from "./adapters/exotel.js";
import { attachGenericPcm } from "./adapters/generic-pcm.js";

const { RUMIK_API_KEY, RUMIK_AGENT_ID, PORT = 3000, PUBLIC_HOST } = process.env;
if (!RUMIK_API_KEY || !RUMIK_AGENT_ID) {
  console.error("Set RUMIK_API_KEY and RUMIK_AGENT_ID");
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.post("/plivo/answer", (req, res) => {
  console.log(`[plivo] incoming ${req.body.CallUUID ?? ""} from ${req.body.From ?? ""}`);
  res.type("text/xml").send(plivoAnswerXml(PUBLIC_HOST || req.headers.host));
});
app.get("/healthz", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const ROUTES = {
  "/plivo": attachPlivo,
  "/exotel": attachExotel,
  "/pcm": attachGenericPcm,
};

server.on("upgrade", (req, socket, head) => {
  const handler = ROUTES[new URL(req.url, "http://x").pathname];
  if (!handler) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => handler(ws, req));
});

server.listen(Number(PORT), () => {
  const host = PUBLIC_HOST || `localhost:${PORT}`;
  console.log(`Silk telephony bridge on :${PORT}`);
  console.log(`  Plivo answer URL : https://${host}/plivo/answer   → wss://${host}/plivo`);
  console.log(`  Exotel voicebot  : wss://${host}/exotel`);
  console.log(`  raw PCM          : ws://${host}/pcm?rate=16000&codec=l16`);
});
