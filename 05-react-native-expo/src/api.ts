// src/api.ts — the only network call the app makes to *your* backend.
//
// POST EXPO_PUBLIC_TOKEN_URL -> { token, host, roomName, callId }
// The backend (see ../shared/token-server-node) holds the rk_live_ key and
// calls Silk's /v1/webcall. The app never sees the key.

export type CallCredentials = { token: string; host: string; roomName: string; callId: string };

const TOKEN_URL = process.env.EXPO_PUBLIC_TOKEN_URL ?? "http://localhost:8787/api/token";

const FRIENDLY: Record<string, string> = {
  agent_not_deployed: "The agent has not been deployed yet — press Deploy in the dashboard.",
  insufficient_balance: "The account cannot fund a call right now.",
  concurrency_limit_exceeded: "All call slots are busy. Try again in a moment.",
};

export async function startCall(): Promise<CallCredentials> {
  const res = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(FRIENDLY[body.code] ?? `${res.status} ${body.code ?? ""}: ${body.error ?? "token request failed"}`);
  if (!body.token || !body.host) throw new Error("token endpoint did not return { token, host }");
  return body as CallCredentials;
}
