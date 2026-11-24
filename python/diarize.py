"""Speaker diarization: FSMN-VAD segments -> CAM++ embeddings -> AHC clustering -> smoothing.

Pure numpy clustering (no sklearn) so it is safe in the worker threads.
Input audio should be 16 kHz mono (main process converts with ffmpeg); other rates are resampled linearly.
"""

from __future__ import annotations

from typing import Any, Callable

import numpy as np

SR = 16000
WIN_S = 1.5  # embedding window
HOP_S = 0.75
MAX_SEG_S = 6.0  # split long VAD segments before transcription
MIN_SEG_S = 0.5


def load_audio(path: str) -> np.ndarray:
    import soundfile as sf

    wav, sr = sf.read(path, dtype="float32", always_2d=True)
    wav = wav.mean(axis=1)
    if sr != SR and len(wav):
        n = int(round(len(wav) * SR / sr))
        wav = np.interp(np.linspace(0, len(wav) - 1, n), np.arange(len(wav)), wav).astype(np.float32)
    return wav


def vad_segments(vad_model: Any, wav: np.ndarray) -> list[tuple[float, float]]:
    res = vad_model.generate(input=wav, fs=SR)
    spans = res[0].get("value", []) if res else []
    out = [(b / 1000.0, e / 1000.0) for b, e in spans if e > b]
    return out or [(0.0, len(wav) / SR)]


def _split_long(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for b, e in spans:
        n = max(1, int(np.ceil((e - b) / MAX_SEG_S)))
        step = (e - b) / n
        out.extend((b + i * step, b + (i + 1) * step) for i in range(n))
    return out


def embed(spk_model: Any, wav: np.ndarray) -> np.ndarray:
    res = spk_model.generate(input=wav)
    emb = res[0]["spk_embedding"]
    emb = emb.detach().cpu().numpy() if hasattr(emb, "detach") else np.asarray(emb)
    v = emb.reshape(-1).astype(np.float32)
    return v / (np.linalg.norm(v) + 1e-8)


def ahc(embs: np.ndarray, num_speakers: int | None, threshold: float) -> np.ndarray:
    """Average-linkage agglomerative clustering on cosine distance (centroid approximation)."""
    n = len(embs)
    if n <= 1:
        return np.zeros(n, dtype=int)
    clusters: dict[int, list[int]] = {i: [i] for i in range(n)}
    cent = {i: embs[i].copy() for i in range(n)}
    target = max(1, num_speakers) if num_speakers else 1
    while len(clusters) > target:
        keys = list(clusters)
        m = np.stack([cent[k] / (np.linalg.norm(cent[k]) + 1e-8) for k in keys])
        d = 1.0 - m @ m.T
        np.fill_diagonal(d, np.inf)
        i, j = np.unravel_index(np.argmin(d), d.shape)
        if not num_speakers and d[i, j] > threshold:
            break
        a, b = keys[i], keys[j]
        na, nb = len(clusters[a]), len(clusters[b])
        cent[a] = (cent[a] * na + cent[b] * nb) / (na + nb)
        clusters[a].extend(clusters.pop(b))
        cent.pop(b)
    labels = np.zeros(n, dtype=int)
    for lab, idx in enumerate(sorted(clusters.values(), key=min)):
        labels[idx] = lab
    return labels


def diarize(
    wav: np.ndarray,
    vad_model: Any,
    spk_model: Any,
    num_speakers: int | None = None,
    threshold: float = 0.6,
    progress: Callable[[str, float], None] | None = None,
    cancelled: Callable[[], bool] = lambda: False,
) -> dict[str, Any]:
    p = progress or (lambda *_: None)
    p("语音活动检测", 5)
    spans = _split_long(vad_segments(vad_model, wav))

    windows: list[tuple[int, float, float]] = []
    for si, (b, e) in enumerate(spans):
        if e - b <= WIN_S:
            windows.append((si, b, e))
            continue
        t = b
        while t + WIN_S <= e + 1e-6:
            windows.append((si, t, t + WIN_S))
            t += HOP_S
        if windows[-1][2] < e - 0.3:
            windows.append((si, e - WIN_S, e))
    embs: list[np.ndarray] = []
    for k, (_, b, e) in enumerate(windows):
        if cancelled():
            raise KeyboardInterrupt
        clip = wav[int(b * SR): int(e * SR)]
        if len(clip) < int(0.4 * SR):
            clip = np.pad(clip, (0, int(0.4 * SR) - len(clip)))
        embs.append(embed(spk_model, clip))
        if k % 10 == 0:
            p(f"提取说话人特征 {k + 1}/{len(windows)}", 10 + 50 * k / max(1, len(windows)))
    E = np.stack(embs)
    p("聚类", 62)
    wl = ahc(E, num_speakers, threshold)

    labels: list[int] = []
    span_emb: list[np.ndarray] = []
    for si in range(len(spans)):
        idx = [k for k, w in enumerate(windows) if w[0] == si]
        votes = np.bincount(wl[idx]) if idx else np.array([0])
        labels.append(int(np.argmax(votes)))
        v = E[idx].mean(axis=0) if idx else E[0]
        span_emb.append(v / (np.linalg.norm(v) + 1e-8))

    # Short spans take a neighbour's label (smooths A-B-A flicker)
    for i, (b, e) in enumerate(spans):
        if e - b < MIN_SEG_S and len(spans) > 1:
            labels[i] = labels[i - 1] if i > 0 else labels[i + 1]

    merged: list[dict[str, Any]] = []
    for (b, e), lab, emb_v in zip(spans, labels, span_emb):
        last = merged[-1] if merged else None
        if last and last["label"] == lab and b - last["end"] < 0.35 and e - last["start"] <= 12:
            last["end"] = e
            last["embs"].append(emb_v)
        else:
            merged.append({"start": b, "end": e, "label": lab, "embs": [emb_v]})

    # Re-index speakers densely by first appearance
    remap: dict[int, int] = {}
    for m in merged:
        remap.setdefault(m["label"], len(remap))
        m["label"] = remap[m["label"]]
    n_spk = len(remap)
    centroids = []
    for s in range(n_spk):
        vs = [v for m in merged if m["label"] == s for v in m["embs"]]
        c = np.mean(vs, axis=0)
        centroids.append(c / (np.linalg.norm(c) + 1e-8))

    items = []
    for m in merged:
        v = np.mean(m["embs"], axis=0)
        v = v / (np.linalg.norm(v) + 1e-8)
        items.append(
            {
                "start": round(m["start"], 3),
                "end": round(m["end"], 3),
                "speaker": f"S{m['label'] + 1}",
                "confidence": round(float(v @ centroids[m["label"]]), 3),
                "_emb": v,
            }
        )
    return {"items": items, "numSpeakers": n_spk, "centroids": centroids}


def reference_candidates(wav: np.ndarray, items: list[dict[str, Any]], centroids: list[np.ndarray], per_speaker: int = 3) -> dict[str, list[dict[str, Any]]]:
    """Pick 3-10 s lines closest to each speaker centroid, with a small SNR bonus."""
    out: dict[str, list[dict[str, Any]]] = {}
    for s, c in enumerate(centroids):
        name = f"S{s + 1}"
        scored = []
        for it in items:
            if it["speaker"] != name:
                continue
            dur = it["end"] - it["start"]
            if dur < 3 or dur > 10:
                continue
            clip = wav[int(it["start"] * SR): int(it["end"] * SR)]
            if not len(clip):
                continue
            rms = float(np.sqrt(np.mean(clip**2)))
            floor = float(np.percentile(np.abs(clip), 10)) + 1e-5
            snr = 20 * np.log10(rms / floor + 1e-8)
            scored.append((float(it["_emb"] @ c) + 0.01 * min(snr, 40), it))
        if not scored:
            scored = [(it["end"] - it["start"], it) for it in items if it["speaker"] == name]
        scored.sort(key=lambda x: -x[0])
        out[name] = [{"start": it["start"], "end": it["end"], "text": it.get("text", ""), "score": round(sc, 3)} for sc, it in scored[:per_speaker]]
    return out
