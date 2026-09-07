"""local_mic.py — talk to the agent from your terminal (server-to-server).

    python local_mic.py

Captures the default microphone with pyaudio at 24 kHz, streams it to Silk,
and plays the agent's reply on the default output. Shows barge-in: when Silk
sends `interruption`, the playback queue is dropped immediately.

macOS, Windows and ALSA's `default` device all resample transparently, so
opening the device at 24 kHz works almost everywhere. If your device refuses,
resample to 24 kHz before sending (see docs/audio-resampling.md).
"""

from __future__ import annotations

import asyncio
import os
import sys
import threading

import pyaudio
from dotenv import load_dotenv

from silk_client import FRAME_SAMPLES, SAMPLE_RATE, SilkCallError, SilkRealtimeSession, register_call

load_dotenv()
API_KEY = os.environ["RUMIK_API_KEY"]
AGENT_ID = os.environ["RUMIK_AGENT_ID"]


async def main() -> None:
    reg = await register_call(API_KEY, AGENT_ID)           # {access_token, expires_in, sample_rate}
    session = SilkRealtimeSession(reg["access_token"])
    created = await session.connect()                        # waits for session.created
    print(f"call {created['call_id']} · {created['sample_rate']} Hz · Ctrl+C to hang up\n")

    loop = asyncio.get_running_loop()
    pa = pyaudio.PyAudio()

    # ---- microphone → asyncio queue (pyaudio callbacks run on their own thread)
    mic_q: asyncio.Queue[bytes] = asyncio.Queue()

    def mic_cb(in_data, _frames, _time, _status):
        loop.call_soon_threadsafe(mic_q.put_nowait, in_data)
        return (None, pyaudio.paContinue)

    # ---- agent audio → playback ring buffer, drained by the output callback
    play_buf = bytearray()
    play_lock = threading.Lock()

    def spk_cb(_in, frame_count, _time, _status):
        need = frame_count * 2
        with play_lock:
            chunk = bytes(play_buf[:need])
            del play_buf[:need]
        if len(chunk) < need:                                # underrun → pad with silence
            chunk += b"\x00" * (need - len(chunk))
        return (chunk, pyaudio.paContinue)

    mic = pa.open(format=pyaudio.paInt16, channels=1, rate=SAMPLE_RATE, input=True,
                  frames_per_buffer=FRAME_SAMPLES, stream_callback=mic_cb)
    spk = pa.open(format=pyaudio.paInt16, channels=1, rate=SAMPLE_RATE, output=True,
                  frames_per_buffer=FRAME_SAMPLES, stream_callback=spk_cb)

    state = {"agent_speaking": False}

    async def on_audio(pcm: bytes) -> None:
        with play_lock:
            play_buf.extend(pcm)

    async def on_event(ev: dict) -> None:
        t = ev["type"]
        if t == "agent_start_talking":
            state["agent_speaking"] = True
            print("\033[91m● agent speaking\033[0m")                    # red
        elif t == "agent_stop_talking":
            state["agent_speaking"] = False
            print("\033[90m○ listening\033[0m")                         # grey
        elif t == "interruption":
            with play_lock:
                dropped = len(play_buf)
                play_buf.clear()                                        # ← barge-in: flush
            print(f"\033[92m● you interrupted — dropped {dropped / 48:.0f} ms of queued audio\033[0m")  # green
        elif t == "transcript":
            print(f"   {ev['role']:>9}: {ev['text']}")
        elif t == "session.closed":
            print(f"\ncall ended: {ev['reason']}")
        elif t == "error":
            print(f"\nerror {ev.get('code')}: {ev.get('message')}", file=sys.stderr)

    session.on_audio = on_audio
    session.on_event = on_event

    async def pump_mic() -> None:
        while True:
            await session.send_audio(await mic_q.get())

    mic_task = asyncio.create_task(pump_mic())
    try:
        await session.run()                                             # until session.closed
    except asyncio.CancelledError:
        pass
    finally:
        mic_task.cancel()
        await session.close()
        mic.close(); spk.close(); pa.terminate()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nhung up")
    except SilkCallError as e:
        print(f"could not start call: {e}", file=sys.stderr)
        sys.exit(1)
