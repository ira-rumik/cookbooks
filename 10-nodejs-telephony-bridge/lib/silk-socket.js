// lib/silk-socket.js — a small Node client for Silk's realtime agent socket.
//
//   wss://silk-api.rumik.ai/v1/agent/connect?token=<wct_…>
//
// Both directions carry base64 PCM: signed 16-bit little-endian, mono, 24 kHz.
// Send 20 ms frames (480 samples = 960 bytes); never more than one second per
// frame. Do not send audio before `session.created` — connect() resolves only
// once it has arrived.
//
//   const reg = await registerCall({ apiKey, agentId });      // POST /v1/register-call
//   const call = new SilkRealtimeSocket(reg.access_token);
//   call.on("audio", (pcm) => play(pcm));                     // Buffer, decoded from output_audio.delta
//   call.on("interruption", () => flush());
//   call.on("transcript", ({ role, text }) => …);
//   call.on("session.closed", ({ reason }) => …);
//   await call.connect();                                     // resolves with the session.created event
//   call.sendAudio(pcmBuffer);                                // repeatedly
//   call.close();                                             // polite hang-up

import { EventEmitter } from "node:events";
import WebSocket from "ws";

export const SAMPLE_RATE = 24_000;
export const CHANNELS = 1;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 480
export const FRAME_BYTES = FRAME_SAMPLES * 2;                 // 960
export const MAX_APPEND_BYTES = SAMPLE_RATE * 2;              // 1 s per append frame

const BASE_URL = process.env.SILK_BASE_URL ?? "https://silk-api.rumik.ai";

export class SilkCallError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = "SilkCallError";
    this.code = code;
    this.status = status;
  }
}

/** Mint a single-use wct_ token. Free until the socket connects. */
export async function registerCall({ apiKey, agentId, baseUrl = BASE_URL }) {
  const res = await fetch(`${baseUrl}/v1/register-call`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ agent_id: agentId }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    throw new SilkCallError(`${res.status} ${body.code ?? "error"}: ${body.error ?? "register-call failed"}`, {
      code: body.code,
      status: res.status,
    });
  }
  return body; // { access_token, expires_in, sample_rate }
}

export class SilkRealtimeSocket extends EventEmitter {
  constructor(accessToken, { baseUrl = BASE_URL } = {}) {
    super();
    const wsBase = baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    this.url = `${wsBase}/v1/agent/connect?token=${encodeURIComponent(accessToken)}`;
    this.ws = null;
    this.session = null; // the session.created payload
  }

  get isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Open the socket and resolve with `session.created` (billing starts here). */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;

      ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        const ev = JSON.parse(data.toString());
        if (!settled) {
          settled = true;
          if (ev.type === "session.created") {
            this.session = ev;
            this.emit("session.created", ev);
            return resolve(ev);
          }
          // accepted, one error frame, then a 4000 close
          return reject(new SilkCallError(`${ev.code}: ${ev.message}`, { code: ev.code }));
        }
        this.#dispatch(ev);
      });

      ws.on("close", (code, reason) => {
        this.emit("close", { code, reason: reason?.toString() ?? "" });
        if (!settled) {
          settled = true;
          reject(
            new SilkCallError(
              code === 4401
                ? "token unknown, already spent or expired (4401) — mint a new one"
                : `socket closed with ${code} before session.created`,
              { code: String(code) },
            ),
          );
        }
      });

      ws.on("error", (err) => {
        this.emit("socket_error", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  #dispatch(ev) {
    if (ev.type === "output_audio.delta") {
      this.emit("audio", Buffer.from(ev.audio, "base64"));
      return;
    }
    // "error" is special on EventEmitter (throws without a listener), so Silk's
    // error frames are re-emitted as "silk_error".
    this.emit(ev.type === "error" ? "silk_error" : ev.type, ev);
    this.emit("event", ev);
  }

  #send(obj) {
    if (this.isOpen) this.ws.send(JSON.stringify(obj));
  }

  /** Append microphone audio (Buffer of PCM s16le 24 kHz mono). Splits >1 s buffers. */
  sendAudio(pcm) {
    for (let i = 0; i < pcm.length; i += MAX_APPEND_BYTES) {
      this.#send({ type: "input_audio_buffer.append", audio: pcm.subarray(i, i + MAX_APPEND_BYTES).toString("base64") });
    }
  }

  /** Type instead of talk. */
  sendText(text) {
    this.#send({ type: "input_text.send", text });
  }

  /** Optional end-of-turn marker; the server's VAD decides turns anyway. */
  commit() {
    this.#send({ type: "input_audio_buffer.commit" });
  }

  /** Polite hang-up: session.close, then wait for the server to close. */
  close() {
    if (!this.isOpen) return;
    this.#send({ type: "session.close" });
    // the server answers with session.closed and then closes; be defensive
    setTimeout(() => this.ws?.readyState === WebSocket.OPEN && this.ws.close(), 2000).unref?.();
  }
}
