"""One-shot vocal / accompaniment separation with a UVR MDX-Net ONNX model.

Run as a short-lived process (not a resident worker): VRAM is released when it exits.
Input must be 44.1 kHz stereo wav (main process converts with ffmpeg).
stdout JSON lines: {"type":"progress","current","total"} / {"type":"log"} / {"type":"result","vocals","instrumental"} / {"type":"error"}
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

import numpy as np


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def make_session(model: str, device: str):
    import onnxruntime as ort

    avail = ort.get_available_providers()
    providers: list = []
    if device != "cpu":
        if "CUDAExecutionProvider" in avail:
            providers.append("CUDAExecutionProvider")
        elif "DmlExecutionProvider" in avail:
            providers.append("DmlExecutionProvider")
    providers.append("CPUExecutionProvider")
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    try:
        sess = ort.InferenceSession(model, sess_options=opts, providers=providers)
    except Exception as e:  # CUDA libs missing etc. -> CPU fallback
        emit({"type": "log", "line": f"GPU provider failed ({e}); falling back to CPU"})
        sess = ort.InferenceSession(model, sess_options=opts, providers=["CPUExecutionProvider"])
    emit({"type": "log", "line": f"providers={sess.get_providers()}"})
    return sess


def run(args) -> None:
    import soundfile as sf
    import torch

    mix, sr = sf.read(args.input, dtype="float32", always_2d=True)
    mix = mix.T  # (ch, n)
    if mix.shape[0] == 1:
        mix = np.repeat(mix, 2, axis=0)
    mix = np.ascontiguousarray(mix[:2])

    sess = make_session(args.model, args.device)
    in_name = sess.get_inputs()[0].name
    # Derive the STFT shape from the model itself, so CLI values only act as a fallback.
    shape = sess.get_inputs()[0].shape  # [1, 4, dim_f, dim_t]
    dim_f = int(shape[2]) if isinstance(shape[2], int) and shape[2] > 0 else args.dim_f
    dim_t = int(shape[3]) if isinstance(shape[3], int) and shape[3] > 0 else args.dim_t
    n_fft = (dim_f - 1) * 2
    emit({"type": "log", "line": f"shape dim_f={dim_f} dim_t={dim_t} n_fft={n_fft}"})

    n_bins = n_fft // 2 + 1
    hop = 1024
    chunk = hop * (dim_t - 1)
    trim = n_fft // 2
    gen = chunk - 2 * trim
    n = mix.shape[1]
    pad = gen - n % gen
    mix_p = np.concatenate([np.zeros((2, trim), np.float32), mix, np.zeros((2, pad + trim), np.float32)], axis=1)

    window = torch.hann_window(n_fft, periodic=True)

    def stft(x: torch.Tensor) -> np.ndarray:
        s = torch.stft(x, n_fft=n_fft, hop_length=hop, window=window, center=True, return_complex=True)  # (2, F, T)
        s = torch.view_as_real(s).permute(0, 3, 1, 2)  # (2ch, re/im, F, T)
        s = s.reshape(1, 4, n_bins, dim_t)[:, :, :dim_f]
        return s.contiguous().numpy()

    def istft(p: np.ndarray) -> np.ndarray:
        s = torch.from_numpy(p).reshape(2, 2, dim_f, dim_t)
        s = torch.cat([s, torch.zeros(2, 2, n_bins - dim_f, dim_t)], dim=2)
        c = torch.view_as_complex(s.permute(0, 2, 3, 1).contiguous())
        return torch.istft(c, n_fft=n_fft, hop_length=hop, window=window, center=True, length=chunk).numpy()

    starts = list(range(0, n + pad, gen))
    out = []
    for i, st in enumerate(starts):
        wave = torch.from_numpy(mix_p[:, st : st + chunk].copy())
        pred = sess.run(None, {in_name: stft(wave)})[0]
        out.append(istft(pred)[:, trim:-trim])
        emit({"type": "progress", "current": i + 1, "total": len(starts)})
    primary = np.concatenate(out, axis=1)[:, :n] * args.compensate
    secondary = mix - primary
    vocals, inst = (primary, secondary) if args.primary == "vocals" else (secondary, primary)

    os.makedirs(args.out, exist_ok=True)
    vp = os.path.join(args.out, "vocals.wav")
    ip = os.path.join(args.out, "instrumental.wav")
    sf.write(vp, np.clip(vocals, -1, 1).T, sr, subtype="PCM_16")
    sf.write(ip, np.clip(inst, -1, 1).T, sr, subtype="PCM_16")
    emit({"type": "result", "vocals": vp, "instrumental": ip, "duration": n / sr})


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--n-fft", type=int, default=7680)
    p.add_argument("--dim-f", type=int, default=3072)
    p.add_argument("--dim-t", type=int, default=256)
    p.add_argument("--compensate", type=float, default=1.0)
    p.add_argument("--primary", choices=["vocals", "instrumental"], default="vocals")
    p.add_argument("--device", default="cuda")
    args = p.parse_args()
    try:
        run(args)
    except Exception as e:  # noqa: BLE001
        emit({"type": "error", "message": str(e), "traceback": traceback.format_exc()})
        sys.exit(1)


if __name__ == "__main__":
    main()
