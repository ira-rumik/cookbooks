"""audio_utils.py — resampling and device helpers for headless Linux audio.

Silk speaks 24 kHz only. USB microphones and HATs on a Pi usually speak
44.1 or 48 kHz, and some refuse anything else. So: open the device at a rate
it likes, and convert here.
"""

from __future__ import annotations

import numpy as np

SILK_RATE = 24_000


class Resampler:
    """Streaming Int16 resampler: FIR low-pass (when downsampling) + linear interpolation.

    Keeps filter history and the fractional read position between calls, so
    20 ms frames join without clicks.
    """

    def __init__(self, in_rate: int, out_rate: int, taps: int = 47):
        self.in_rate, self.out_rate = in_rate, out_rate
        self.step = in_rate / out_rate
        self.pos = 0.0
        self.prev = 0.0
        self.h: np.ndarray | None = None
        self.hist: np.ndarray | None = None
        if in_rate > out_rate:
            cutoff = 0.45 * out_rate / in_rate          # normalised (cycles/sample)
            n = np.arange(taps) - (taps - 1) / 2
            sinc = np.where(n == 0, 2 * cutoff, np.sin(2 * np.pi * cutoff * n) / (np.pi * np.where(n == 0, 1, n)))
            window = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(taps) / (taps - 1))
            h = sinc * window
            self.h = (h / h.sum()).astype(np.float32)
            self.hist = np.zeros(taps - 1, dtype=np.float32)

    def process(self, pcm: np.ndarray) -> np.ndarray:
        if self.in_rate == self.out_rate:
            return pcm
        x = pcm.astype(np.float32)
        if self.h is not None:
            buf = np.concatenate([self.hist, x])
            x = np.convolve(buf, self.h, mode="valid")
            self.hist = buf[-(len(self.h) - 1):]

        src = np.concatenate([[self.prev], x])
        n_out = int(np.ceil((len(src) - 1 - self.pos) / self.step))
        if n_out <= 0:
            self.pos -= len(src) - 1
            self.prev = src[-1]
            return np.zeros(0, dtype=np.int16)
        positions = self.pos + np.arange(n_out) * self.step
        positions = positions[positions < len(src) - 1]
        y = np.interp(positions, np.arange(len(src)), src)
        self.pos = (positions[-1] + self.step) - (len(src) - 1) if len(positions) else self.pos - (len(src) - 1)
        self.prev = src[-1]
        return np.clip(y, -32768, 32767).astype(np.int16)


def list_devices(pa) -> None:
    """Print every audio device pyaudio can see — pick indexes for .env from here."""
    for i in range(pa.get_device_count()):
        d = pa.get_device_info_by_index(i)
        kind = []
        if d["maxInputChannels"]:
            kind.append(f"in×{d['maxInputChannels']}")
        if d["maxOutputChannels"]:
            kind.append(f"out×{d['maxOutputChannels']}")
        print(f"  [{i}] {d['name']}  ({', '.join(kind)}; default {int(d['defaultSampleRate'])} Hz)")


def pick_rate(pa, device_index: int | None, is_input: bool, preferred: int = SILK_RATE) -> int:
    """Return `preferred` if the device accepts it, else the device's native rate."""
    import pyaudio

    info = pa.get_device_info_by_index(device_index) if device_index is not None else (
        pa.get_default_input_device_info() if is_input else pa.get_default_output_device_info()
    )
    kwargs = dict(rate=preferred, channels=1, format=pyaudio.paInt16)
    try:
        ok = pa.is_format_supported(input_device=info["index"], **kwargs) if is_input else pa.is_format_supported(output_device=info["index"], **kwargs)
        if ok:
            return preferred
    except ValueError:
        pass
    return int(info["defaultSampleRate"])
