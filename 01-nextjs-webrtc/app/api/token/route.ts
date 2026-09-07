// app/api/token/route.ts
//
// The only place the rk_live_ key is used. The browser calls this route, this
// route calls Silk, and only the LiveKit join credentials go back down.
//
// POST /api/token  ->  { token, host, roomName, callId }

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache: every call needs fresh credentials

const BASE = process.env.SILK_BASE_URL ?? "https://silk-api.rumik.ai";

export async function POST() {
  const apiKey = process.env.RUMIK_API_KEY;
  const agentId = process.env.RUMIK_AGENT_ID;

  if (!apiKey || !agentId) {
    return NextResponse.json(
      { error: "RUMIK_API_KEY / RUMIK_AGENT_ID are not set on the server", code: "not_configured" },
      { status: 500 },
    );
  }

  const upstream = await fetch(`${BASE}/v1/webcall`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agentId }),
    cache: "no-store",
  });

  // Forward Silk's status and { error, code } envelope untouched so the UI can
  // show "agent not deployed" / "out of capacity" instead of a generic failure.
  const body = await upstream
    .json()
    .catch(() => ({ error: "upstream returned a non-JSON body", code: "upstream_error" }));

  return NextResponse.json(body, { status: upstream.status });
}
