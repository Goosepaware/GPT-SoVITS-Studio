"""Per-sentence timing analysis for subtitle alignment.

All functions take mono float32 audio in [-1, 1].
"""

from __future__ import annotations

import re
from typing import Any

import numpy as np

_CJK = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]")
_WORD = re.compile(r"[A-Za-z0-9]+")


def count_units(text: str) -> int:
    """Rough spoken-unit count: one per CJK char, two per latin word."""
    return len(_CJK.findall(text)) + 2 * len(_WORD.findall(text))


def to_float_mono(audio: Any) -> np.ndarray:
    a = np.asarray(audio)
    if a.ndim > 1:
        a = a.mean(axis=1) if a.shape[1] <= 2 else a.reshape(-1)
    if a.dtype == np.int16:
        return a.astype(np.float32) / 32768.0
    return a.astype(np.float32)


def analyze_segment(wav: np.ndarray, sr: int, frame_ms: int = 20, pad_s: float = 0.05) -> dict[str, Any]:
    n = len(wav)
    hop = max(1, int(sr * frame_ms / 1000))
    silent = {
        "silent": True,
        "peak_rms": 0.0,
        "trim_start": 0,
        "trim_end": n,
        "voiced_start": 0.0,
        "voiced_end": n / float(sr) if sr else 0.0,
        "voiced_dur": 0.0,
        "pauses": [],
    }
    if n < hop:
        return silent
    frames = n // hop
    rms = np.sqrt(np.mean(np.square(wav[: frames * hop].reshape(frames, hop)), axis=1) + 1e-12)
    peak_rms = float(rms.max())
    thr = max(0.004, peak_rms * 0.05)
    voiced = np.flatnonzero(rms > thr)
    if peak_rms < 0.006 or voiced.size == 0:
        silent["peak_rms"] = peak_rms
        return silent

    f0, f1 = int(voiced[0]), int(voiced[-1]) + 1
    pad = int(pad_s * sr)
    ts = max(0, f0 * hop - pad)
    te = min(n, f1 * hop + pad)

    # Inner pauses (>= 80 ms below threshold) = natural breath points for splitting.
    pauses: list[float] = []
    run = 0
    for k in range(f0, f1):
        if rms[k] <= thr:
            run += 1
            continue
        if run >= 4:
            center = (k - run / 2.0) * hop
            pauses.append(round((center - ts) / sr, 3))
        run = 0

    return {
        "silent": False,
        "peak_rms": peak_rms,
        "trim_start": ts,
        "trim_end": te,
        "voiced_start": (f0 * hop - ts) / float(sr),
        "voiced_end": (f1 * hop - ts) / float(sr),
        "voiced_dur": (f1 - f0) * hop / float(sr),
        "pauses": pauses,
    }


def detect_flags(info: dict[str, Any], text: str, speed: float = 1.0) -> list[str]:
    if info["silent"]:
        return ["silent"]
    units = max(1, count_units(text))
    # Normalize to speed 1.0 so thresholds stay meaningful.
    d = info["voiced_dur"] * max(0.25, speed)
    flags: list[str] = []
    if d > max(2.5, units * 0.55):
        flags.append("too_long")
    if units >= 4 and d < units * 0.06:
        flags.append("too_short")
    return flags
