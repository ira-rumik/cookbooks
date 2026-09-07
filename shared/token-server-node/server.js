// Silk token server (Node / Express)
//
// Three endpoints, all of which keep RUMIK_API_KEY on the server:
//   POST /api/token        -> POST /v1/webcall        (WebRTC join credentials)
//   POST /api/agent-token  -> POST /v1/register-call  (single-use WebSocket token)
//   GET  /api/limits       -> GET  /v1/agent/limits   (capacity snapshot)
//
// Every upstream response is forwarded verbatim, including its status code,
// so the client sees the real Silk error envelope ({ error, code }).

import "dotenv/config";
import express from "express";
import cors from "cors";

const {
  RUMIK_API_KEY,
  RUMIK_AGENT_ID,
  SILK_BASE_URL = "https://silk-api.rumik.ai",
  PORT = 8787,
  CORS_ORIGIN = "*",
} = process.env;

if (!RUMIK_API_KEY || !RUMIK_AGENT_ID) {
  console.error("Set RUMIK_API_KEY and RUMIK_AGENT_ID (see ../../.env.example)");
  process.exit(1);
}

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

/** Call Silk with the server-side key and forward status + body unchanged. */
async function silk(path, init = {}) {
  const res = await fetch(`${SILK_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${RUMIK_API_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  let body;
  try {
    body = await res.json();
  } catch {
    body = { error: "upstream returned a non-JSON body", code: "upstream_error" };
  }
  return { status: res.status, body };
}

/**
 * Optionally let the client pick an agent, but only from an allowlist.
 * By default only RUMIK_AGENT_ID is allowed; extend ALLOWED_AGENTS to offer more.
 */
const ALLOWED_AGENTS = new Set(
  (process.env.ALLOWED_AGENTS ?? RUMIK_AGENT_ID).split(",").map((s) => s.trim()).filter(Boolean),
);
function resolveAgent(req) {
  const requested = req.body?.agentId ?? req.body?.agent_id;
  if (!requested) return RUMIK_AGENT_ID;
  return ALLOWED_AGENTS.has(requested) ? requested : null;
}

// WebRTC: start the call now, hand the browser the LiveKit join credentials.
app.post("/api/token", async (req, res) => {
  const agentId = resolveAgent(req);
  if (!agentId) return res.status(403).json({ error: "agent not allowed", code: "forbidden_agent" });

  const { status, body } = await silk("/v1/webcall", {
    method: "POST",
    body: JSON.stringify({ agentId }),
  });
  if (status === 200) console.log(`[webcall] started call ${body.callId} in ${body.roomName}`);
  res.status(status).json(body); // { token, host, roomName, callId }
});

// WebSocket: mint a single-use wct_ token. Nothing is billed until the socket connects.
app.post("/api/agent-token", async (req, res) => {
  const agentId = resolveAgent(req);
  if (!agentId) return res.status(403).json({ error: "agent not allowed", code: "forbidden_agent" });

  const { status, body } = await silk("/v1/register-call", {
    method: "POST",
    body: JSON.stringify({ agent_id: agentId }),
  });
  res.status(status).json(body); // { access_token, expires_in, sample_rate }
});

// Capacity snapshot — use it to queue callers instead of discovering a 429 mid-flow.
app.get("/api/limits", async (_req, res) => {
  const { status, body } = await silk("/v1/agent/limits");
  res.status(status).json(body); // { concurrency_limit, active_requests, plan }
});

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(Number(PORT), () => {
  console.log(`Silk token server listening on http://localhost:${PORT}`);
  console.log(`  POST /api/token        (WebRTC)     agent=${RUMIK_AGENT_ID}`);
  console.log(`  POST /api/agent-token  (WebSocket)`);
  console.log(`  GET  /api/limits`);
});
