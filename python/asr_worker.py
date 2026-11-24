"""Speech-to-text worker using FunASR models.

Supported models:
  - sensevoice   (iic/SenseVoiceSmall, fast, zh/en/ja/ko/yue)
  - fun-asr-nano (FunAudioLLM/Fun-ASR-Nano-2512, 31 languages, slower to load)
"""

from __future__ import annotations

import argparse
import gc
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_common import WorkerBase, activate_engine, vram_snapshot  # noqa: E402

TAG_RE = re.compile(r"<\|[^|]*\|>")
LANG_RE = re.compile(r"<\|([a-z]{2,3})\|>")


def clean_asr_text(raw: str) -> tuple[str, str | None]:
    detected = None
    match = LANG_RE.search(raw or "")
    if match:
        detected = match.group(1)
    text = TAG_RE.sub("", raw or "")
    text = re.sub(r"</?s>", "", text)
    text = text.replace("\x00", "").strip()
    text = re.sub(r"[ \t]+", " ", text)
    return text, detected


class AsrWorker(WorkerBase):
    def __init__(self, engine_root: str, data_dir: str):
        super().__init__("asr", engine_root, data_dir)
        self.model = None
        self.model_key = ""
        self.model_path = ""
        self.vad_path = ""
        self._auto_model_cls = None
        self._has_transcribed = False

    def on_start(self) -> None:
        activate_engine(self.engine_root)
        import torch  # noqa: F401
        # setuptools provides the `distutils` module; funasr's model registry imports it,
        # and without it CAMPPlus (CAM++) fails to register on this runtime.
        import setuptools  # noqa: F401
        # Preload FunASR / scipy / sklearn while the process is still
        # single-threaded; importing them with the stdin/watchdog threads
        # running deadlocks OpenBLAS on this runtime.
        from funasr import AutoModel

        self._auto_model_cls = AutoModel
        self.proto.emit({"type": "worker-ready", "pid": os.getpid()})
        self.proto.status("stopped", {})
        self.proto.log(f"runtime ready: {sys.version.split()[0]}")

    def is_loaded(self) -> bool:
        return self.model is not None

    def model_names(self) -> dict[str, str]:
        return {"asr": self.model_path, "vad": self.vad_path}

    def _release_model(self) -> None:
        if self.model is None:
            return
        self.model = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass

    def _load(self, command: dict[str, Any]) -> None:
        rid = command.get("id")
        model_key = command.get("model") or "sensevoice"
        model_path = os.path.abspath(command.get("modelPath") or "")
        vad_path = os.path.abspath(command.get("vadPath") or "")
        device = command.get("device") or "cuda"
        if not os.path.isdir(model_path):
            raise FileNotFoundError(f"ASR 模型目录不存在: {model_path}")
        if not os.path.isdir(vad_path):
            raise FileNotFoundError(f"VAD 模型目录不存在: {vad_path}")

        import torch
        # AutoModel was pre-imported in on_start before worker threads started.
        AutoModel = self._auto_model_cls

        if device != "cpu" and not torch.cuda.is_available():
            device = "cpu"
        self._release_model()
        self.proto.status("loading", {}, f"正在加载 {model_key}")
        started = time.time()
        self.proto.stage(rid, "load-model", f"加载 {model_key}", 8, "首次加载需要几十秒" if model_key == "fun-asr-nano" else "约 2 秒")
        # FunASR's progress bars go to stderr through the protocol redirect.
        self.model = AutoModel(
            model=model_path,
            vad_model=vad_path,
            device=device,
            disable_update=True,
            trust_remote_code=model_key == "fun-asr-nano",
        )
        self.device = device
        self.model_key = model_key
        self.model_path = model_path
        self.vad_path = vad_path
        self._has_transcribed = False
        self.proto.stage(rid, "load-model", "模型已就绪", 100, f"加载耗时 {time.time() - started:.1f} 秒")
        status = self.get_status()
        status["state"] = "ready"
        self.proto.status("ready", self.model_names(), None, vram_snapshot(torch))
        self.proto.result(rid, status)

    def _transcribe(self, command: dict[str, Any]) -> None:
        rid = command.get("id")
        if self.model is None:
            raise RuntimeError("ASR 模型尚未加载")
        files = [os.path.abspath(p) for p in (command.get("files") or [])]
        if not files:
            raise ValueError("没有待识别的音频")
        language = command.get("language") or "auto"
        total = len(files)
        results: list[dict[str, Any]] = []
        self.cancel_event.clear()
        for index, path in enumerate(files):
            if self.cancel_event.is_set():
                break
            started = time.time()
            name = os.path.basename(path)
            first_run = not self._has_transcribed
            self.proto.progress(rid, index, total, f"识别 {name}", "首次识别会预热模型" if first_run else "正在识别")
            self.proto.stage(
                rid,
                "transcribe",
                f"首次识别 · 预热中（{index + 1}/{total}）" if first_run else f"识别第 {index + 1}/{total} 个文件",
                (index / max(1, total)) * 100,
                name,
            )
            if not os.path.exists(path):
                results.append({
                    "path": path,
                    "name": name,
                    "text": "",
                    "language": language,
                    "ok": False,
                    "error": "文件不存在",
                    "durationMs": 0,
                })
                continue
            try:
                raw = self.model.generate(input=path)[0]
                raw_text = raw.get("text", "") if isinstance(raw, dict) else str(raw)
                text, detected = clean_asr_text(raw_text)
                results.append({
                    "path": path,
                    "name": name,
                    "text": text,
                    "language": detected or language,
                    "ok": True,
                    "durationMs": int((time.time() - started) * 1000),
                })
                self._has_transcribed = True
            except Exception as exc:
                self.proto.log(f"ASR failed for {path}: {exc}")
                results.append({
                    "path": path,
                    "name": name,
                    "text": "",
                    "language": language,
                    "ok": False,
                    "error": str(exc),
                    "durationMs": int((time.time() - started) * 1000),
                })
            self.proto.progress(rid, index + 1, total, f"已识别 {index + 1}/{total}", name)

        if self.cancel_event.is_set():
            self.proto.cancelled(rid)
            self.proto.status("ready", self.model_names(), "已停止识别")
            return
        self.proto.status("ready", self.model_names(), None, vram_snapshot())
        self.proto.result(rid, results)

    def _diarize(self, command: dict[str, Any]) -> None:
        """{audioPath (16k mono wav), spkModelPath, numSpeakers?, threshold?, transcribe?, language?}"""
        rid = command.get("id")
        import diarize as dz

        AutoModel = self._auto_model_cls
        audio_path = os.path.abspath(command.get("audioPath") or "")
        spk_path = os.path.abspath(command.get("spkModelPath") or "")
        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"音频不存在: {audio_path}")
        if not os.path.isdir(spk_path):
            raise FileNotFoundError(f"说话人模型目录不存在: {spk_path}（需要 CAM++）")
        vad_path = self.vad_path or os.path.abspath(command.get("vadPath") or "")
        if not os.path.isdir(vad_path):
            raise FileNotFoundError("VAD 模型目录不存在")
        device = getattr(self, "device", "cpu")
        self.cancel_event.clear()
        stage = lambda label, pct: self.proto.stage(rid, "diarize", label, pct)  # noqa: E731
        stage("加载说话人模型", 2)
        if getattr(self, "_spk", None) is None or self._spk_path != spk_path:
            self._spk = AutoModel(model=spk_path, device=device, disable_update=True)
            self._spk_path = spk_path
        if getattr(self, "_vad", None) is None or self._vad_only_path != vad_path:
            self._vad = AutoModel(model=vad_path, device=device, disable_update=True)
            self._vad_only_path = vad_path
        wav = dz.load_audio(audio_path)
        n = command.get("numSpeakers")
        try:
            res = dz.diarize(
                wav,
                self._vad,
                self._spk,
                int(n) if n else None,
                float(command.get("threshold") or 0.6),
                stage,
                self.cancel_event.is_set,
            )
        except KeyboardInterrupt:
            self.proto.cancelled(rid)
            self.proto.status("ready" if self.model else "stopped", self.model_names(), "已停止")
            return
        items = res["items"]
        if command.get("transcribe", True) and self.model is not None:
            import soundfile as sf

            tmp_dir = os.path.join(self.data_dir, "temp", "diarize")
            os.makedirs(tmp_dir, exist_ok=True)
            for k, it in enumerate(items):
                if self.cancel_event.is_set():
                    break
                clip = wav[int(it["start"] * dz.SR): int(it["end"] * dz.SR)]
                p = os.path.join(tmp_dir, f"line_{k}.wav")
                sf.write(p, clip, dz.SR, subtype="PCM_16")
                try:
                    raw = self.model.generate(input=p)[0]
                    text, lang = clean_asr_text(raw.get("text", "") if isinstance(raw, dict) else str(raw))
                except Exception as exc:  # keep going
                    text, lang = "", None
                    self.proto.log(f"line {k} ASR failed: {exc}")
                it["text"] = text
                it["lang"] = lang or command.get("language") or "auto"
                os.remove(p)
                if k % 5 == 0:
                    stage(f"识别台词 {k + 1}/{len(items)}", 65 + 33 * k / max(1, len(items)))
        refs = dz.reference_candidates(wav, items, res["centroids"])
        for it in items:
            it.pop("_emb", None)
        stage("完成", 100)
        self.proto.status("ready" if self.model else "stopped", self.model_names(), None, vram_snapshot())
        self.proto.result(rid, {"items": items, "numSpeakers": res["numSpeakers"], "references": refs, "duration": round(len(wav) / dz.SR, 3)})

    def _unload(self, command: dict[str, Any]) -> None:
        self._spk = None
        self._vad = None
        self._release_model()
        self.model_path = ""
        self.vad_path = ""
        self.model_key = ""
        self.proto.status("stopped", {})
        self.proto.result(command.get("id"), {"unloaded": True})

    def dispatch(self, command: dict[str, Any]) -> None:
        cmd = command.get("cmd")
        if cmd == "load":
            self._load(command)
        elif cmd == "transcribe":
            self._transcribe(command)
        elif cmd == "diarize":
            self._diarize(command)
        elif cmd == "unload":
            self._unload(command)
        else:
            raise ValueError(f"unknown command: {cmd}")

    def on_cancel(self) -> None:
        self.proto.log("cancellation requested")

    def on_shutdown(self) -> None:
        self._release_model()
        self.proto.status("stopped", {})
        try:
            self.proto._out.flush()
        finally:
            os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-root", required=True)
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    worker = AsrWorker(args.engine_root, args.data_dir)
    worker.run()


if __name__ == "__main__":
    main()
