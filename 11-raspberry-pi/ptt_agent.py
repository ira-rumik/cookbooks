"""ptt_agent.py — push-to-talk voice agent for Raspberry Pi. No GUI.

    hold the button  → your microphone streams to the agent
    release          → (optional) end-of-turn hint; the agent's VAD decides anyway
    LED on           → the agent is speaking
    LED blinks       → you interrupted it (its queued audio was dropped)

Push-to-talk is also the cheapest echo canceller there is: while the button
is up, the agent hears silence, so it can never transcribe its own voice
coming out of the speaker.

Wiring (BCM numbering, see README): button between GPIO17 and GND, LED +
330 Ω between GPIO27 and GND.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import threading

import httpx
import numpy as np
import pyaudio
from dotenv import load_dotenv
from gpiozero import LED, Button

from audio_utils import SILK_RATE, Resampler, list_devices, pick_rate
from silk_client import FRAME_BYTES, SilkCallError, SilkRealtimeSession, register_call

load_dotenv()
API_KEY = os.environ.get("RUMIK_API_KEY")
AGENT_ID = os.environ.get("RUMIK_AGENT_ID")
TOKEN_URL = os.environ.get("TOKEN_URL")
BUTTON_PIN = int(os.environ.get("BUTTON_PIN", "17"))
LED_PIN = int(os.environ.get("LED_PIN", "27"))
INPUT_DEVICE = int(os.environ["INPUT_DEVICE"]) if os.environ.get("INPUT_DEVICE") else None
OUTPUT_DEVICE = int(os.environ["OUTPUT_DEVICE"]) if os.environ.get("OUTPUT_DEVICE") else None
FRAME_MS = 20


async def mint_token() -> str:
    """Directly with the API key (device you control), or via your token server."""
    if TOKEN_URL:
        async with httpx.AsyncClient(timeout=30) as http:
            r = await http.post(TOKEN_URL)
            r.raise_for_status()
            return r.json()["access_token"]
    if not API_KEY or not AGENT_ID:
        raise SystemExit("set RUMIK_API_KEY + RUMIK_AGENT_ID, or TOKEN_URL")
    return (await register_call(API_KEY, AGENT_ID))["access_token"]


async def main() -> None:
    pa = pyaudio.PyAudio()
    if "--list" in sys.argv:
        list_devices(pa)
        return

    in_rate = pick_rate(pa, INPUT_DEVICE, is_input=True)
    out_rate = pick_rate(pa, OUTPUT_DEVICE, is_input=False)
    in_frames = in_rate * FRAME_MS // 1000
    out_frames = out_rate * FRAME_MS // 1000
    print(f"mic {in_rate} Hz → silk {SILK_RATE} Hz → speaker {out_rate} Hz")

    session = SilkRealtimeSession(await mint_token())
    created = await session.connect()
    print(f"call {created['call_id']} live — hold the button to talk, Ctrl+C to hang up")

    loop = asyncio.get_running_loop()
    button = Button(BUTTON_PIN, pull_up=True, bounce_time=0.02)
    led = LED(LED_PIN)

    # ---- microphone → queue (gated by the button)
    mic_q: asyncio.Queue[bytes] = asyncio.Queue()
    up = Resampler(in_rate, SILK_RATE)
    silence = b"\x00" * FRAME_BYTES

    def mic_cb(in_data, _frames, _time, _status):
        if button.is_pressed:
            pcm = up.process(np.frombuffer(in_data, dtype=np.int16)).tobytes()
        else:
            pcm = silence            # keep the stream continuous; the agent hears nothing
        loop.call_soon_threadsafe(mic_q.put_nowait, pcm)
        return (None, pyaudio.paContinue)

    # ---- agent audio → ring buffer → speaker (resampled to the device rate)
    down = Resampler(SILK_RATE, out_rate)
    play_buf = bytearray()
    play_lock = threading.Lock()

    def spk_cb(_in, frame_count, _time, _status):
        need = frame_count * 2
        with play_lock:
            chunk = bytes(play_buf[:need])
            del play_buf[:need]
        if len(chunk) < need:
            chunk += b"\x00" * (need - len(chunk))
        return (chunk, pyaudio.paContinue)

    mic = pa.open(format=pyaudio.paInt16, channels=1, rate=in_rate, input=True, input_device_index=INPUT_DEVICE,
                  frames_per_buffer=in_frames, stream_callback=mic_cb)
    spk = pa.open(format=pyaudio.paInt16, channels=1, rate=out_rate, output=True, output_device_index=OUTPUT_DEVICE,
                  frames_per_buffer=out_frames, stream_callback=spk_cb)

    async def on_audio(pcm: bytes) -> None:
        out = down.process(np.frombuffer(pcm, dtype=np.int16)).tobytes()
        with play_lock:
            play_buf.extend(out)

    async def on_event(ev: dict) -> None:
        t = ev["type"]
        if t == "agent_start_talking":
            led.on()
            print("● agent speaking")
        elif t == "agent_stop_talking":
            led.off()
            print("○ listening")
        elif t == "interruption":
            with play_lock:
                play_buf.clear()                       # ← barge-in: drop queued speech
            led.blink(on_time=0.1, off_time=0.1, n=3, background=True)
            print("● interrupted — playback flushed")
        elif t == "transcript":
            print(f"   {ev['role']:>9}: {ev['text']}")
        elif t == "session.closed":
            print(f"call ended: {ev['reason']}")
        elif t == "error":
            print(f"error {ev.get('code')}: {ev.get('message')}", file=sys.stderr)

    session.on_audio = on_audio
    session.on_event = on_event

    # Releasing the button is a good moment to hint "my turn is over". Optional:
    # the agent's own VAD decides turns whether or not you send it.
    button.when_released = lambda: loop.call_soon_threadsafe(lambda: asyncio.ensure_future(session.commit()))

    async def pump_mic() -> None:
        while True:
            await session.send_audio(await mic_q.get())

    mic_task = asyncio.create_task(pump_mic())
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    run_task = asyncio.create_task(session.run())
    await asyncio.wait({run_task, asyncio.create_task(stop.wait())}, return_when=asyncio.FIRST_COMPLETED)

    mic_task.cancel()
    await session.close()
    mic.close(); spk.close(); pa.terminate()
    led.off()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SilkCallError as e:
        print(f"could not start call: {e}", file=sys.stderr)
        sys.exit(1)
