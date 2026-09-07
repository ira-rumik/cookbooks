# 11 · Raspberry Pi / embedded Linux — push-to-talk, no GUI

A physical button, a microphone, a speaker and a Pi. Hold the button, talk to the agent, let go. Runs headless as a systemd service. The realtime WebSocket is the primary transport (no WebRTC stack to build on ARM); a WebRTC variant is included for flaky Wi-Fi.

```
   ┌──────────────┐  GPIO17  ┌─────────────────────────────┐   register-call + wss    ┌──────────┐
   │ push button  │ ───────▶ │  ptt_agent.py               │ ◀══════════════════════▶ │ Silk API │
   └──────────────┘          │  pyaudio in (native rate)   │   PCM 24 kHz, 20 ms       │  agent   │
   ┌──────────────┐  GPIO27  │  → resample → gate on button│                           └──────────┘
   │ LED          │ ◀─────── │  ← resample ← flush on      │
   └──────────────┘          │    interruption             │
   USB mic / speaker ──ALSA──┘─────────────────────────────┘
```

## What you get

| file | role |
| --- | --- |
| `ptt_agent.py` | **the main recipe**: GPIO button gates the mic, LED shows agent state, playback flushed on `interruption` |
| `always_on_agent.py` | hands-free variant for a USB speakerphone with hardware echo cancellation |
| `webrtc_agent.py` | the same call over WebRTC with the `livekit` Python SDK + `sounddevice` |
| `audio_utils.py` | numpy `Resampler` (device native rate ⇄ 24 kHz), device listing, rate probing |
| `silk_client.py` | the realtime socket client (same as cookbook 03) |
| `systemd/silk-agent.service` | run it at boot |

## Hardware

- Raspberry Pi 3/4/5 or Zero 2 W (anything with GPIO and a network).
- A USB microphone or a mic HAT, and a speaker (USB, HAT, or the 3.5 mm jack). A USB *conference speakerphone* puck gives you both, plus hardware echo cancellation.
- A momentary push button and an LED with a 330 Ω resistor.

Wiring, BCM numbering:

```
  GPIO17 ──┤ button ├── GND          (internal pull-up is enabled in software)
  GPIO27 ──[330 Ω]──▶|── GND          (LED, anode to the resistor)
```

## Run it

```bash
sudo apt install -y python3-pyaudio python3-numpy portaudio19-dev libatlas-base-dev
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env               # RUMIK_API_KEY + RUMIK_AGENT_ID  (or TOKEN_URL)

python ptt_agent.py --list         # find your mic / speaker indexes → INPUT_DEVICE / OUTPUT_DEVICE in .env
python ptt_agent.py                # hold the button and talk
```

Run at boot:

```bash
sudo cp systemd/silk-agent.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now silk-agent
journalctl -u silk-agent -f
```

## The token backend, or not

A Pi you own is a server as far as trust goes: `ptt_agent.py` calls `POST /v1/register-call` with `RUMIK_API_KEY` directly, one token per call, exactly like the Python backend cookbook. For a **kiosk in a public place** where the SD card can walk away, leave `RUMIK_API_KEY` empty and set `TOKEN_URL` to one of the [shared token servers](../shared) — the device then holds nothing but single-use `wct_` tokens:

```python
async def mint_token() -> str:
    if TOKEN_URL:                                    # kiosk mode: your server holds the key
        return (await http.post(TOKEN_URL)).json()["access_token"]
    return (await register_call(API_KEY, AGENT_ID))["access_token"]   # trusted device
```

## Streaming a microphone without a GUI

`pyaudio` opens the devices in callback mode, so capture and playback run on PortAudio's threads and the asyncio loop only moves bytes:

```python
in_rate = pick_rate(pa, INPUT_DEVICE, is_input=True)     # 24 000 if the device accepts it, else its native rate
up = Resampler(in_rate, 24_000)

def mic_cb(in_data, *_):
    pcm = up.process(np.frombuffer(in_data, dtype=np.int16)).tobytes() if button.is_pressed else SILENCE
    loop.call_soon_threadsafe(mic_q.put_nowait, pcm)      # → session.send_audio() on the loop
    return (None, pyaudio.paContinue)
```

Most USB mics are 44.1/48 kHz-only; `audio_utils.Resampler` converts to 24 kHz on the way up and from 24 kHz on the way down, statefully, so 20 ms frames join without clicks.

## Push-to-talk = triggering the agent from GPIO

```python
button = Button(BUTTON_PIN, pull_up=True, bounce_time=0.02)
# while held: real audio; while up: 960 bytes of silence per 20 ms — the stream never stops
button.when_released = lambda: loop.call_soon_threadsafe(lambda: asyncio.ensure_future(session.commit()))
```

Two things fall out of gating the mic instead of pausing the stream:

1. **timing stays continuous** — the agent sees an unbroken 24 kHz stream, so its VAD and turn-taking behave exactly as with a live mic;
2. **echo is impossible** — while the button is up the agent hears silence, so its own voice from the speaker can never be transcribed back. That is why this recipe works with a bare mic and speaker where `always_on_agent.py` needs a speakerphone with hardware AEC.

Releasing the button sends `input_audio_buffer.commit` as a hint; the agent's VAD decides turns either way.

## Barge-in on hardware

Hold the button while the agent is talking and speak. Silk sends `interruption`; the script drops everything queued for the speaker and blinks the LED:

```python
elif t == "interruption":
    with play_lock:
        play_buf.clear()          # the agent has abandoned that sentence — do not finish playing it
    led.blink(on_time=0.1, off_time=0.1, n=3, background=True)
```

LED semantics: **on** = agent speaking, **blink** = you interrupted it, **off** = listening.

## WebRTC on the Pi (`webrtc_agent.py`)

```bash
pip install livekit sounddevice
python webrtc_agent.py            # uses /v1/webcall directly, or TOKEN_URL if set
```

The `livekit` Python SDK publishes a 24 kHz mono track from `sounddevice` and plays the agent's track back. WebRTC's jitter buffer and Opus loss concealment make it noticeably more robust on marginal Wi-Fi than the socket. The trade-off: the SDK does not run software echo cancellation for you, so use a speakerphone with hardware AEC or a headset.

## Troubleshooting

| symptom | fix |
| --- | --- |
| `Invalid sample rate` on open | the device refuses 24 kHz; `pick_rate()` falls back to native — check `--list` output and set `INPUT_DEVICE` explicitly |
| `ALSA lib … underrun` spam | harmless in most cases; add `2>/dev/null` or set `frames_per_buffer` larger |
| button triggers twice | mechanical bounce; `bounce_time=0.02` is set — raise it for a cheap switch |
| agent answers itself (`always_on_agent.py`) | no AEC in the path — use a speakerphone puck, a headset, or `ptt_agent.py` |
| `gpiozero` cannot find a pin factory | on Pi 5 install `python3-lgpio`; on other boards set `GPIOZERO_PIN_FACTORY` |
| service restarts every few seconds | check `journalctl -u silk-agent`; usually the network is not up yet or the token failed (`409 agent_not_deployed`) |
