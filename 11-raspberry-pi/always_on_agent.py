"""always_on_agent.py — hands-free variant: the microphone streams all the time.

Use this with a USB speakerphone that has hardware echo cancellation (most
conference pucks do), or with a headset. With a bare mic + speaker the agent
will hear itself; that is what ptt_agent.py is for.
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import threading

import numpy as np
import pyaudio
from dotenv import load_dotenv

from audio_utils import SILK_RATE, Resampler, pick_rate
from silk_client import SilkCallError, SilkRealtimeSession, register_call

load_dotenv()
API_KEY, AGENT_ID = os.environ["RUMIK_API_KEY"], os.environ["RUMIK_AGENT_ID"]
INPUT_DEVICE = int(os.environ["INPUT_DEVICE"]) if os.environ.get("INPUT_DEVICE") else None
OUTPUT_DEVICE = int(os.environ["OUTPUT_DEVICE"]) if os.environ.get("OUTPUT_DEVICE") else None


async def main() -> None:
    pa = pyaudio.PyAudio()
    in_rate, out_rate = pick_rate(pa, INPUT_DEVICE, True), pick_rate(pa, OUTPUT_DEVICE, False)
    print(f"mic {in_rate} Hz → silk {SILK_RATE} Hz → speaker {out_rate} Hz")

    reg = await register_call(API_KEY, AGENT_ID)
    session = SilkRealtimeSession(reg["access_token"])
    created = await session.connect()
    print(f"call {created['call_id']} live — just talk. Ctrl+C to hang up")

    loop = asyncio.get_running_loop()
    mic_q: asyncio.Queue[bytes] = asyncio.Queue()
    up, down = Resampler(in_rate, SILK_RATE), Resampler(SILK_RATE, out_rate)
    play_buf, play_lock = bytearray(), threading.Lock()

    def mic_cb(data, *_):
        loop.call_soon_threadsafe(mic_q.put_nowait, up.process(np.frombuffer(data, dtype=np.int16)).tobytes())
        return (None, pyaudio.paContinue)

    def spk_cb(_in, n, *_):
        need = n * 2
        with play_lock:
            chunk = bytes(play_buf[:need]); del play_buf[:need]
        return (chunk + b"\x00" * (need - len(chunk)), pyaudio.paContinue)

    mic = pa.open(format=pyaudio.paInt16, channels=1, rate=in_rate, input=True, input_device_index=INPUT_DEVICE,
                  frames_per_buffer=in_rate // 50, stream_callback=mic_cb)
    spk = pa.open(format=pyaudio.paInt16, channels=1, rate=out_rate, output=True, output_device_index=OUTPUT_DEVICE,
                  frames_per_buffer=out_rate // 50, stream_callback=spk_cb)

    async def on_audio(pcm: bytes) -> None:
        with play_lock:
            play_buf.extend(down.process(np.frombuffer(pcm, dtype=np.int16)).tobytes())

    async def on_event(ev: dict) -> None:
        if ev["type"] == "interruption":
            with play_lock:
                play_buf.clear()                      # ← barge-in
            print("● interrupted — playback flushed")
        elif ev["type"] == "transcript":
            print(f"   {ev['role']:>9}: {ev['text']}")
        elif ev["type"] == "session.closed":
            print(f"call ended: {ev['reason']}")

    session.on_audio, session.on_event = on_audio, on_event

    async def pump() -> None:
        while True:
            await session.send_audio(await mic_q.get())

    pump_task = asyncio.create_task(pump())
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    await asyncio.wait({asyncio.create_task(session.run()), asyncio.create_task(stop.wait())}, return_when=asyncio.FIRST_COMPLETED)
    pump_task.cancel()
    await session.close()
    mic.close(); spk.close(); pa.terminate()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except SilkCallError as e:
        print(f"could not start call: {e}", file=sys.stderr)
        sys.exit(1)
