"""webrtc_agent.py — the WebRTC alternative for the Pi, using the `livekit` Python SDK.

    pip install livekit sounddevice

Why you might prefer it over the socket: WebRTC adapts to a bad Wi-Fi link
(jitter buffer, packet-loss concealment, Opus) where a WebSocket just stalls.
Why you might not: the Python SDK does not run acoustic echo cancellation for
you, so pair it with a USB speakerphone that has hardware AEC — or gate the mic
with a push-to-talk button as ptt_agent.py does.
"""

from __future__ import annotations

import asyncio
import os
import signal

import httpx
import numpy as np
import sounddevice as sd
from dotenv import load_dotenv
from livekit import rtc

load_dotenv()
RATE, CHANNELS, FRAME = 24_000, 1, 480
API_KEY, AGENT_ID = os.environ.get("RUMIK_API_KEY"), os.environ.get("RUMIK_AGENT_ID")
BASE = os.environ.get("SILK_BASE_URL", "https://silk-api.rumik.ai")
TOKEN_URL = os.environ.get("TOKEN_URL")   # e.g. http://server:8787/api/token — returns {token, host, …}


async def start_call() -> dict:
    async with httpx.AsyncClient(timeout=30) as http:
        if TOKEN_URL:
            r = await http.post(TOKEN_URL)
        else:
            r = await http.post(f"{BASE}/v1/webcall", headers={"Authorization": f"Bearer {API_KEY}"}, json={"agentId": AGENT_ID})
        r.raise_for_status()
        return r.json()   # {token, host, roomName, callId}


async def main() -> None:
    call = await start_call()
    print(f"call {call['callId']} — joining {call['host']}")

    room = rtc.Room()
    loop = asyncio.get_running_loop()

    # ---- playback: agent track → sounddevice output
    out_q: asyncio.Queue[np.ndarray] = asyncio.Queue()

    async def play(track: rtc.Track) -> None:
        stream = rtc.AudioStream.from_track(track=track, sample_rate=RATE, num_channels=CHANNELS)
        async for ev in stream:
            await out_q.put(np.frombuffer(ev.frame.data, dtype=np.int16).copy())

    @room.on("track_subscribed")
    def on_track(track, _pub, participant):
        if track.kind == rtc.TrackKind.KIND_AUDIO:
            print(f"agent audio from {participant.identity}")
            asyncio.ensure_future(play(track))

    @room.on("active_speakers_changed")
    def on_speakers(speakers):
        names = [p.identity for p in speakers]
        print("speaking:", names or "—")

    def out_cb(outdata, frames, _t, _status):
        try:
            chunk = out_q.get_nowait()
            outdata[: len(chunk), 0] = chunk[:frames]
            if len(chunk) < frames:
                outdata[len(chunk):, 0] = 0
        except asyncio.QueueEmpty:
            outdata.fill(0)

    # ---- capture: sounddevice input → rtc.AudioSource
    source = rtc.AudioSource(RATE, CHANNELS)
    mic_q: asyncio.Queue[bytes] = asyncio.Queue()

    def in_cb(indata, _frames, _t, _status):
        loop.call_soon_threadsafe(mic_q.put_nowait, bytes(indata))

    async def pump_mic() -> None:
        while True:
            data = await mic_q.get()
            await source.capture_frame(rtc.AudioFrame(data=data, sample_rate=RATE, num_channels=CHANNELS, samples_per_channel=len(data) // 2))

    await room.connect(call["host"], call["token"])
    track = rtc.LocalAudioTrack.create_audio_track("mic", source)
    await room.local_participant.publish_track(track, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))

    with sd.InputStream(samplerate=RATE, channels=CHANNELS, dtype="int16", blocksize=FRAME, callback=in_cb), \
         sd.OutputStream(samplerate=RATE, channels=CHANNELS, dtype="int16", blocksize=FRAME, callback=out_cb):
        pump = asyncio.create_task(pump_mic())
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        print("in the room — talk. Ctrl+C to hang up")
        await stop.wait()
        pump.cancel()

    await room.disconnect()   # call ends, billing stops


if __name__ == "__main__":
    asyncio.run(main())
