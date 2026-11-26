"""GPT-SoVITS v5turbo inference worker.

Run with the bundled runtime:
  runtime\\python.exe -I -u python\\tts_worker.py --engine-root <root> --data-dir <data>
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import shutil
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

# Make sibling modules importable even with -I.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_common import WorkerBase, activate_engine, vram_snapshot  # noqa: E402
from korean_compat import prepare_korean_compat  # noqa: E402
from timing import analyze_segment, detect_flags, to_float_mono  # noqa: E402

FLAG_LABELS = {
    "silent": "疑似静音",
    "too_long": "时长偏长（可能重复/拖音）",
    "too_short": "时长偏短（可能漏字）",
}


PARAM_KEYS = ("speed", "topK", "topP", "temperature", "sampleSteps", "repetitionPenalty")
PARAM_DEFAULTS = {"speed": 1.0, "topK": 15, "topP": 1.0, "temperature": 1.0, "sampleSteps": 4, "repetitionPenalty": 1.35}


def _params_from(command: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k in PARAM_KEYS:
        v = command.get(k, PARAM_DEFAULTS[k])
        out[k] = int(v) if k in ("topK", "sampleSteps") else float(v)
    return out


def _flag_score(flags: list[str]) -> int:
    return (10 if "silent" in flags else 0) + len(flags)


class TtsWorker(WorkerBase):
    def __init__(self, engine_root: str, data_dir: str):
        super().__init__("tts", engine_root, data_dir)
        self.tts = None
        self.gpt_path = ""
        self.sovits_path = ""
        self.warmed_up = False
        self.accel_ok = True
        self._stage_rid: str | None = None

    def on_start(self) -> None:
        # Import after activate_engine() has prepared DLL directories and PATH.
        self.proto.log("activating bundled runtime")
        activate_engine(self.engine_root)
        self.proto.log(f"korean text frontend: {prepare_korean_compat()}")
        self.proto.log("runtime activated; importing torch")
        import torch  # noqa: F401
        self.proto.log("torch imported; importing GPT-SoVITS")
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config  # noqa: F401
        self.proto.log("GPT-SoVITS imported")

        self.proto.emit({"type": "worker-ready", "pid": os.getpid()})
        self.proto.status("stopped", {})
        self.proto.log(f"runtime ready: {sys.version.split()[0]}")

    def is_loaded(self) -> bool:
        return self.tts is not None

    def model_names(self) -> dict[str, str]:
        return {
            "gpt": self.gpt_path,
            "sovits": self.sovits_path,
            "vocoder": "v5turbo",
            "bert": "chinese-roberta-wwm-ext-large",
            "hubert": "chinese-hubert-base",
        }

    def _stage(self, rid: str | None, stage: str, label: str, progress: float | None = None, detail: str | None = None) -> None:
        self.proto.stage(rid, stage, label, progress, detail)

    def _load(self, command: dict[str, Any]) -> None:
        rid = command.get("id")
        gpt_path = os.path.abspath(command["gptPath"])
        sovits_path = os.path.abspath(command["sovitsPath"])
        device = command.get("device", "cuda:0")
        half = bool(command.get("half", True))
        if not os.path.exists(gpt_path):
            raise FileNotFoundError(f"GPT 模型不存在: {gpt_path}")
        if not os.path.exists(sovits_path):
            raise FileNotFoundError(f"SoVITS 模型不存在: {sovits_path}")

        self._release_models()
        self._stage_rid = rid
        self._stage(rid, "load", "准备推理环境", 2)
        self.proto.status("loading", {}, "正在加载 v5turbo 模型")
        import torch
        from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config

        def emit_stage(stage: str, label: str, progress: float) -> None:
            self._stage(rid, stage, label, progress)

        class InstrumentedTTS(TTS):
            def __init__(self, configs, emit):
                self._emit_stage = emit
                super().__init__(configs)

            def _init_models(self):
                self._emit_stage("load-gpt", "加载 GPT 语义模型", 12)
                self.init_t2s_weights(self.configs.t2s_weights_path)
                self._emit_stage("load-sovits", "加载 SoVITS 与声码器", 42)
                self.init_vits_weights(self.configs.vits_weights_path)
                self._emit_stage("load-bert", "加载 BERT 文本模型", 74)
                self.init_bert_weights(self.configs.bert_base_path)
                self._emit_stage("load-hubert", "加载 HuBERT 特征模型", 88)
                self.init_cnhuhbert_weights(self.configs.cnhuhbert_base_path)

        config_path = os.path.join(self.data_dir, "tts_infer.yaml")
        custom = {
            "device": device,
            "is_half": half,
            "version": "v5turbo",
            "t2s_weights_path": gpt_path,
            "vits_weights_path": sovits_path,
            "bert_base_path": os.path.join(self.engine_root, "GPT_SoVITS", "pretrained_models", "chinese-roberta-wwm-ext-large"),
            "cnhuhbert_base_path": os.path.join(self.engine_root, "GPT_SoVITS", "pretrained_models", "chinese-hubert-base"),
        }
        cfg = TTS_Config({"custom": custom})
        cfg.configs_path = config_path
        tts = InstrumentedTTS(cfg, emit_stage)
        self.tts = tts
        self.gpt_path = gpt_path
        self.sovits_path = sovits_path
        self.warmed_up = False
        self.accel_ok = True
        self._stage(rid, "load", "模型已就绪", 100)
        status = self.get_status()
        status["state"] = "ready"
        self.proto.status("ready", self.model_names(), None, vram_snapshot(torch))
        self.proto.result(rid, status)

    def _release_models(self) -> None:
        if self.tts is None:
            return
        self.tts = None
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception:
            pass

    # ------------------------------------------------------------ synthesis

    def _run_one(self, base_inputs: dict[str, Any], text: str, seed: int) -> tuple[Any, int]:
        """Synthesize exactly one sentence (no further splitting). Returns (float mono, sr)."""
        import numpy as np

        inputs = dict(base_inputs)
        inputs.update(
            {
                "text": text,
                "text_split_method": "cut0",
                "batch_size": 1,
                "seed": seed,
                "use_cuda_graph": self.accel_ok,
                "use_flash_attention": self.accel_ok,
            }
        )
        parts: list[Any] = []
        sr = 48000

        def go() -> None:
            nonlocal sr
            parts.clear()
            for out_sr, audio in self.tts.run(inputs):
                sr = out_sr
                if audio is not None and len(audio) > 0:
                    parts.append(to_float_mono(audio))
                if self.cancel_event.is_set():
                    self.tts.stop_flag = True
                    break

        try:
            go()
        except Exception as exc:
            msg = str(exc).lower()
            accel = any(k in msg for k in ("flash", "cuda graph", "cudagraph", "accel", "backend"))
            if not self.accel_ok or not accel or "out of memory" in msg:
                raise
            # Fall back once; following sentences stay in compat mode, nothing restarts.
            self.proto.log(f"加速后端初始化失败，回退到兼容模式：{exc}")
            self.accel_ok = False
            inputs["use_cuda_graph"] = False
            inputs["use_flash_attention"] = False
            self.tts.stop_flag = False
            go()
        wav = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
        return wav, sr

    def _persist_ref(self, ref_path: str) -> str:
        """Copy temp reference audio into data/refs so segment re-generation still works later."""
        try:
            temp_dir = os.path.abspath(os.path.join(self.data_dir, "temp"))
            if not os.path.abspath(ref_path).lower().startswith(temp_dir.lower()):
                return ref_path
            h = hashlib.sha1()
            with open(ref_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b""):
                    h.update(chunk)
            refs = os.path.join(self.data_dir, "refs")
            os.makedirs(refs, exist_ok=True)
            dst = os.path.join(refs, h.hexdigest()[:16] + (os.path.splitext(ref_path)[1] or ".wav"))
            if not os.path.exists(dst):
                shutil.copyfile(ref_path, dst)
            return dst
        except Exception as exc:
            self.proto.log(f"参考音频备份失败：{exc}")
            return ref_path

    def _preview_segments(self, command: dict[str, Any]) -> None:
        """Re-generate selected sentences as candidate clips (no replacement here; main process commits)."""
        rid = command.get("id")
        if self.tts is None:
            raise RuntimeError("TTS 模型尚未加载")
        import numpy as np
        import soundfile as sf
        import torch

        with open(command["timingPath"], "r", encoding="utf-8") as fh:
            timing = json.load(fh)
        src = dict(timing.get("source") or {})
        src.update({k: v for k, v in (command.get("source") or {}).items() if v not in (None, "")})
        ref_path = os.path.abspath(src.get("refAudioPath") or "")
        if not os.path.exists(ref_path):
            raise FileNotFoundError(f"参考音频不存在: {ref_path}")
        if not (src.get("promptText") or "").strip():
            raise ValueError("参考文本为空")
        segs = timing.get("segments") or []
        indices = [int(i) for i in command.get("indices") or []]
        if not indices or any(i < 0 or i >= len(segs) for i in indices):
            raise ValueError("分段序号无效")
        overrides = command.get("overrides") or {}
        texts = overrides.get("texts") or {}
        count = max(1, min(8, int(command.get("count", 1))))
        out_dir = os.path.abspath(command["outDir"])
        os.makedirs(out_dir, exist_ok=True)
        gain = float(timing.get("gain") or 1.0)
        self.cancel_event.clear()
        self.tts.stop_flag = False
        self.tts.set_ref_audio(ref_path)

        results: list[dict[str, Any]] = []
        total = len(indices) * count
        done = 0
        for idx in indices:
            seg = segs[idx]
            params = dict(PARAM_DEFAULTS)
            params.update((src.get("params") or {}))
            params.update(seg.get("params") or {})
            params.update({k: v for k, v in (overrides.get("params") or {}).items() if k in PARAM_KEYS and v is not None})
            text = str(texts.get(str(idx)) or seg.get("text") or "").strip()
            if not text:
                raise ValueError(f"第 {idx + 1} 句文本为空")
            base_inputs = {
                "text_lang": src.get("textLang") or "auto",
                "ref_audio_path": ref_path,
                "prompt_text": src.get("promptText"),
                "prompt_lang": src.get("promptLang") or "auto",
                "top_k": int(params["topK"]),
                "top_p": float(params["topP"]),
                "temperature": float(params["temperature"]),
                "batch_threshold": 0.75,
                "split_bucket": False,
                "speed_factor": float(params["speed"]),
                "fragment_interval": 0.0,  # gaps are inserted by us when re-assembling (timing.gap)
                "parallel_infer": True,
                "repetition_penalty": float(params["repetitionPenalty"]),
                "sample_steps": int(params["sampleSteps"]),
                "return_fragment": False,
                "streaming_mode": False,
            }
            base_seed = overrides.get("seed")
            cands: list[dict[str, Any]] = []
            for n in range(count):
                if self.cancel_event.is_set():
                    self.tts.stop_flag = False
                    self.proto.cancelled(rid)
                    self.proto.status("ready", self.model_names(), "已停止生成")
                    return
                if base_seed is not None and int(base_seed) >= 0:
                    seed = (int(base_seed) + n) % (2**31)
                else:
                    seed = random.randint(0, 2**31 - 1)
                self._stage(rid, "synthesize", f"试听 · 第 {idx + 1} 句 · 候选 {n + 1}/{count}", 5 + done / total * 90, text[:42])
                wav, sr = self._run_one(base_inputs, text, seed)
                if self.cancel_event.is_set():
                    continue
                self.warmed_up = True
                info = analyze_segment(wav, sr)
                flags = detect_flags(info, text, float(params["speed"]))
                if info["silent"]:
                    clip = np.zeros(int(0.2 * sr), dtype=np.float32)
                    v0, v1 = 0.0, len(clip) / sr
                else:
                    clip = wav[info["trim_start"]: info["trim_end"]]
                    v0, v1 = info["voiced_start"], info["voiced_end"]
                clip = clip * gain
                pcm = (np.clip(clip, -1.0, 1.0) * 32767.0).astype(np.int16)
                path = os.path.join(out_dir, f"seg{idx}_cand{n}.wav")
                sf.write(path, pcm, sr, subtype="PCM_16")
                cands.append(
                    {
                        "candidate": n,
                        "path": path,
                        "duration": round(len(pcm) / sr, 3),
                        "sampleRate": sr,
                        "voicedStart": round(v0, 3),
                        "voicedEnd": round(v1, 3),
                        "pauses": [round(p, 3) for p in info["pauses"]],
                        "seed": seed,
                        "flags": flags,
                    }
                )
                done += 1
            results.append({"index": idx, "text": text, "params": params, "candidates": cands})

        self._stage(rid, "done", "试听生成完成", 100)
        self.proto.status("ready", self.model_names(), None, vram_snapshot(torch))
        self.proto.result(rid, {"outDir": out_dir, "segments": results})

    def _synthesize(self, command: dict[str, Any]) -> None:
        rid = command.get("id")
        if self.tts is None:
            raise RuntimeError("TTS 模型尚未加载")
        import numpy as np
        import soundfile as sf
        import torch

        text = (command.get("text") or "").strip()
        prompt_text = (command.get("promptText") or "").strip()
        text_lang = command.get("textLang") or "auto"
        prompt_lang = command.get("promptLang") or "auto"
        ref_path = os.path.abspath(command.get("refAudioPath") or "")
        output_path = os.path.abspath(command.get("outputPath") or "")
        if not text:
            raise ValueError("合成文本为空")
        if not prompt_text:
            raise ValueError("参考文本为空。v5turbo 不支持无参考文本模式。")
        if not os.path.exists(ref_path):
            raise FileNotFoundError(f"参考音频不存在: {ref_path}")
        if not output_path:
            raise ValueError("输出路径为空")
        os.makedirs(os.path.dirname(output_path), exist_ok=True)

        requested_seed = int(command.get("seed", -1))
        used_seed = requested_seed if requested_seed >= 0 else random.randint(0, 2**31 - 1)
        split_method = command.get("splitMethod") or "cut5"
        speed = float(command.get("speed", 1.0))
        gap_s = max(0.0, float(command.get("fragmentInterval", 0.3)))
        max_retries = max(0, int(command.get("maxRetries", 2)))
        self.cancel_event.clear()
        self.tts.stop_flag = False

        segments = [s for s in self.tts.text_preprocessor.pre_seg_text(text, text_lang, split_method) if s.strip()]
        if not segments:
            segments = [text]
        total = len(segments)
        self._stage(rid, "prepare", "分析参考音频", 2)
        self.tts.set_ref_audio(ref_path)
        self._stage(rid, "split", f"文本已切分：{total} 句", 6, "；".join(s[:24] for s in segments[:4]))

        base_inputs = {
            "text_lang": text_lang,
            "ref_audio_path": ref_path,
            "prompt_text": prompt_text,
            "prompt_lang": prompt_lang,
            "top_k": int(command.get("topK", 15)),
            "top_p": float(command.get("topP", 1.0)),
            "temperature": float(command.get("temperature", 1.0)),
            "batch_threshold": 0.75,
            "split_bucket": False,
            "speed_factor": speed,
            "fragment_interval": 0.0,
            "parallel_infer": bool(command.get("parallelInfer", True)),
            "repetition_penalty": float(command.get("repetitionPenalty", 1.35)),
            "sample_steps": int(command.get("sampleSteps", 4)),
            "return_fragment": False,
            "streaming_mode": False,
        }
        if not self.warmed_up:
            self._stage(rid, "warmup", "首次生成：编译加速后端", 8, "首次约 15–50 秒，之后会明显加快")
        else:
            self._stage(rid, "warmup", "初始化推理", 8)

        started = time.time()
        sample_rate = 48000
        pieces: list[Any] = []
        timeline: list[dict[str, Any]] = []
        warnings: list[str] = []
        cursor = 0  # in samples

        def handle_cancel() -> bool:
            if not self.cancel_event.is_set():
                return False
            self.tts.stop_flag = False
            self.proto.cancelled(rid)
            self.proto.status("ready", self.model_names(), "已停止生成")
            return True

        for i, seg in enumerate(segments):
            if handle_cancel():
                return
            seed = (used_seed + i) % (2**31)
            attempt = 0
            best: tuple[Any, dict[str, Any], list[str], int, int] | None = None
            while True:
                self.proto.progress(rid, i, total, f"第 {i + 1}/{total} 句", seg[:42])
                label = f"合成中 · {i + 1}/{total} 句" + (f"（重试 {attempt}）" if attempt else "")
                self._stage(rid, "synthesize", label, 8 + (i / total) * 86, seg[:42])
                wav, sr = self._run_one(base_inputs, seg, seed)
                if self.cancel_event.is_set():
                    break
                sample_rate = sr
                info = analyze_segment(wav, sr)
                flags = detect_flags(info, seg, speed)
                if best is None or _flag_score(flags) < _flag_score(best[2]):
                    best = (wav, info, flags, seed, attempt)
                if not flags or attempt >= max_retries:
                    break
                attempt += 1
                seed = random.randint(0, 2**31 - 1)
            if handle_cancel():
                return
            assert best is not None
            wav, info, flags, seed, _ = best
            self.warmed_up = True

            if info["silent"]:
                clip = np.zeros(int(0.2 * sample_rate), dtype=np.float32)
                v0, v1 = 0.0, len(clip) / sample_rate
            else:
                clip = wav[info["trim_start"]: info["trim_end"]]
                v0, v1 = info["voiced_start"], info["voiced_end"]

            if pieces and gap_s > 0:
                gap = np.zeros(int(gap_s * sample_rate), dtype=np.float32)
                pieces.append(gap)
                cursor += len(gap)
            start = cursor / sample_rate
            pieces.append(clip)
            cursor += len(clip)
            timeline.append(
                {
                    "index": i,
                    "text": seg.strip(),
                    "start": round(start, 3),
                    "end": round(cursor / sample_rate, 3),
                    "voicedStart": round(start + v0, 3),
                    "voicedEnd": round(start + v1, 3),
                    "pauses": [round(start + p, 3) for p in info["pauses"]],
                    "seed": seed,
                    "retries": attempt,
                    "flags": flags,
                }
            )
            if flags:
                reason = "、".join(FLAG_LABELS.get(f, f) for f in flags)
                warnings.append(f"第 {i + 1} 句{reason}" + (f"，已重试 {attempt} 次" if attempt else ""))
            self.proto.progress(rid, i + 1, total, f"第 {i + 1}/{total} 句", seg[:42])

        if all("silent" in t["flags"] for t in timeline):
            raise RuntimeError("没有生成任何有效音频（全部静音），请检查参考音频、文本或参数。")

        audio = np.concatenate(pieces)
        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        gain = 1.0
        if peak > 0.99:
            # Scale down instead of hard clipping to avoid distortion.
            gain = 0.98 / peak
            audio = audio * gain
        pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16)
        sf.write(output_path, pcm, sample_rate, subtype="PCM_16")
        duration = len(pcm) / float(sample_rate)

        for t in timeline:
            t["params"] = None
            t["edited"] = False
        timing_path = os.path.splitext(output_path)[0] + ".timing.json"
        with open(timing_path, "w", encoding="utf-8") as fh:
            json.dump(
                {
                    "version": 2,
                    "sampleRate": sample_rate,
                    "duration": round(duration, 3),
                    "seed": used_seed,
                    "gain": round(gain, 6),
                    "gap": gap_s,
                    "source": {
                        "voiceId": command.get("voiceId") or "",
                        "refAudioPath": self._persist_ref(ref_path),
                        "promptText": prompt_text,
                        "promptLang": prompt_lang,
                        "textLang": text_lang,
                        "gptPath": self.gpt_path,
                        "sovitsPath": self.sovits_path,
                        "params": _params_from(command),
                    },
                    "edited": False,
                    "editCount": 0,
                    "segments": timeline,
                },
                fh,
                ensure_ascii=False,
                indent=1,
            )

        self._stage(rid, "done", "生成完成", 100, f"{duration:.2f} 秒")
        result = {
            "filePath": output_path,
            "timingPath": timing_path,
            "duration": round(duration, 3),
            "sampleRate": sample_rate,
            "segments": total,
            "elapsed": round(time.time() - started, 2),
            "seed": used_seed,
            "warnings": warnings,
        }
        self.proto.status("ready", self.model_names(), None, vram_snapshot(torch))
        self.proto.result(rid, result)

    def _unload(self, command: dict[str, Any]) -> None:
        self._release_models()
        self.gpt_path = ""
        self.sovits_path = ""
        self.proto.status("stopped", {})
        self.proto.result(command.get("id"), {"unloaded": True})

    def dispatch(self, command: dict[str, Any]) -> None:
        cmd = command.get("cmd")
        if cmd == "load":
            self._load(command)
        elif cmd == "synthesize":
            self._synthesize(command)
        elif cmd == "preview_segments":
            self._preview_segments(command)
        elif cmd == "unload":
            self._unload(command)
        else:
            raise ValueError(f"unknown command: {cmd}")

    def on_cancel(self) -> None:
        if self.tts is not None:
            self.tts.stop_flag = True
        self.proto.log("cancellation requested")

    def on_shutdown(self) -> None:
        self._release_models()
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
    worker = TtsWorker(args.engine_root, args.data_dir)
    worker.run()


if __name__ == "__main__":
    main()
