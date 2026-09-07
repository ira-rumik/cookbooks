// server.js — Express + ws bridge: browser ⇄ Node ⇄ Silk realtime socket.
//
//   WS  /ws/agent          browser sends raw PCM (binary); Node registers a call,
//                          connects to Silk, relays audio both ways and forwards
//                          control events (transcripts, interruption, …) as JSON.
//   POST /api/agent-token  mint a single-use token for clients that connect directly.
//
//   npm start   →  http://localhost:8000

import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { SilkCallError, SilkRealtimeSocket, registerCall } from "./lib/silk-socket.js";

const { RUMIK_API_KEY, RUMIK_AGENT_ID, SILK_BASE_URL = "https://silk-api.rumik.ai", PORT = 8000 } = process.env;
if (!RUMIK_API_KEY || !RUMIK_AGENT_ID) {
  console.error("Set RUMIK_API_KEY and RUMIK_AGENT_ID");
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---------------------------------------------------------------- token minting
app.post("/api/agent-token", async (_req, res) => {
  const upstream = await fetch(`${SILK_BASE_URL}/v1/register-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${RUMIK_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: RUMIK_AGENT_ID }),
  });
  res.status(upstream.status).json(await upstream.json().catch(() => ({ error: "bad upstream body", code: "upstream_error" })));
});

// ---------------------------------------------------------------- the bridge
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://x").pathname !== "/ws/agent") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", async (client) => {
  const send = (obj) => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(obj));

  // 1. register + connect (server-to-server; the browser never sees a token)
  let call;
  try {
    const reg = await registerCall({ apiKey: RUMIK_API_KEY, agentId: RUMIK_AGENT_ID, baseUrl: SILK_BASE_URL });
    call = new SilkRealtimeSocket(reg.access_token, { baseUrl: SILK_BASE_URL });
    wire(call, client, send);
    const created = await call.connect();
    send(created); // session.created → browser
    console.log(`[bridge] call ${created.call_id} started`);
  } catch (err) {
    const code = err instanceof SilkCallError ? err.code ?? "start_failed" : "start_failed";
    send({ type: "error", code, message: err.message });
    return client.close(4000, code);
  }

  // 3. browser → Silk: binary = PCM 24 kHz mono, text = control frames
  client.on("message", (data, isBinary) => {
    if (isBinary) return call.sendAudio(data);
    const msg = JSON.parse(data.toString());
    if (msg.type === "input_text.send") call.sendText(msg.text);
    else if (msg.type === "session.close") call.close();
  });
  client.on("close", () => call.close());
});

// 2. Silk → browser: audio as binary frames, everything else as JSON text
function wire(call, client, send) {
  call.on("audio", (pcm) => client.readyState === WebSocket.OPEN && client.send(pcm, { binary: true }));
  call.on("event", (ev) => send(ev));
  call.on("close", ({ code }) => {
    console.log(`[bridge] call ${call.session?.call_id ?? "?"} ended (${code})`);
    if (client.readyState === WebSocket.OPEN) client.close(1000);
  });
  call.on("socket_error", (err) => console.error("[silk]", err.message));
}

server.listen(Number(PORT), () => console.log(`Silk Node bridge → http://localhost:${PORT}`));
