"""GPT-SoVITS v5turbo inference worker.

Run with the bundled runtime:
  runtime\\python.exe -I -u python\\tts_worker.py --engine-root <root> --data-dir <data>
"""

from __future__ import annotations

import argparse
import gc
import os
import random
import sys
import time
import traceback
from pathlib import Path
from typing import Any

# Make sibling modules importable even with -I.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine_common import WorkerBase, activate_engine, vram_snapshot  # noqa: E402


class TtsWorker(WorkerBase):
    def __init__(self, engine_root: str, data_dir: str):
        super().__init__("tts", engine_root, data_dir)
        self.tts = None
        self.gpt_path = ""
        self.sovits_path = ""
        self.warmed_up = False
        self._stage_rid: str | None = None

    def on_start(self) -> None:
        # Import after activate_engine() has prepared DLL directories and PATH.
        self.proto.log("activating bundled runtime")
        activate_engine(self.engine_root)
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
        used_seed = requested_seed if requested_seed >= 0 else random.randint(0, 2**32 - 1)
        split_method = command.get("splitMethod") or "cut5"
        self.cancel_event.clear()
        self.tts.stop_flag = False
        segments = self.tts.text_preprocessor.pre_seg_text(text, text_lang, split_method)
        total = max(1, len(segments))
        self._stage(rid, "prepare", "分析参考音频", 2)
        self.tts.set_ref_audio(ref_path)
        self._stage(rid, "split", f"文本已切分：{total} 段", 6, "；".join(s[:24] for s in segments[:4]))
        if self.cancel_event.is_set():
            self.proto.cancelled(rid)
            self.proto.status("ready", self.model_names())
            return

        inputs = {
            "text": text,
            "text_lang": text_lang,
            "ref_audio_path": ref_path,
            "prompt_text": prompt_text,
            "prompt_lang": prompt_lang,
            "top_k": int(command.get("topK", 15)),
            "top_p": float(command.get("topP", 1.0)),
            "temperature": float(command.get("temperature", 1.0)),
            "text_split_method": split_method,
            "batch_size": max(1, int(command.get("batchSize", 1))),
            "batch_threshold": 0.75,
            "split_bucket": False,
            "speed_factor": float(command.get("speed", 1.0)),
            "fragment_interval": float(command.get("fragmentInterval", 0.3)),
            "seed": used_seed,
            "parallel_infer": bool(command.get("parallelInfer", True)),
            "repetition_penalty": float(command.get("repetitionPenalty", 1.35)),
            "sample_steps": int(command.get("sampleSteps", 4)),
            "return_fragment": True,
            "streaming_mode": False,
            "use_cuda_graph": True,
            "use_flash_attention": True,
        }
        if not self.warmed_up:
            self._stage(rid, "warmup", "首次生成：编译加速后端", 8, "首次约 15–50 秒，之后会明显加快")
        else:
            self._stage(rid, "warmup", "初始化推理", 8)

        chunks: list[np.ndarray] = []
        sample_rate = 48000
        batch_size = int(inputs["batch_size"])
        started = time.time()

        def generate() -> tuple[list[np.ndarray], int]:
            local_chunks: list[np.ndarray] = []
            local_done = 0
            nonlocal sample_rate
            for sr, audio in self.tts.run(inputs):
                sample_rate = sr
                if self.cancel_event.is_set():
                    self.tts.stop_flag = True
                if audio is not None and len(audio) > 0:
                    local_chunks.append(audio)
                    local_done = min(total, local_done + batch_size)
                    detail = segments[local_done - 1][:42] if local_done - 1 < len(segments) else None
                    self.proto.progress(rid, local_done, total, f"第 {local_done}/{total} 段", detail)
                    self.proto.stage(
                        rid,
                        "synthesize",
                        f"合成中 · {local_done}/{total} 段",
                        8 + (local_done / total) * 86,
                        f"已生成 {sum(len(c) for c in local_chunks) / float(sr):.1f} 秒音频",
                    )
                if self.cancel_event.is_set():
                    break
            return local_chunks, local_done

        try:
            chunks, done = generate()
        except Exception as exc:
            # The first generation may fail on an unsupported acceleration
            # backend.  Retry once with CUDA Graph / FlashAttention disabled.
            message = str(exc).lower()
            acceleration_error = any(k in message for k in ("flash", "cuda graph", "cudagraph", "accel", "backend"))
            oom = "out of memory" in message
            if acceleration_error and not oom:
                self.proto.log(f"加速后端初始化失败，回退到兼容模式：{exc}")
                inputs["use_cuda_graph"] = False
                inputs["use_flash_attention"] = False
                self.tts.stop_flag = False
                self.cancel_event.clear()
                self._stage(rid, "compat", "加速后端不兼容，切换兼容模式", 8)
                chunks, done = generate()
            else:
                raise

        if self.cancel_event.is_set():
            self.tts.stop_flag = False
            self.proto.cancelled(rid)
            self.proto.status("ready", self.model_names(), "已停止生成")
            return
        if not chunks:
            raise RuntimeError("没有生成任何音频，请检查参考音频和文本。")

        audio = np.concatenate(chunks, axis=0)
        # Some versions return float; normalize safely to 16-bit PCM.
        if audio.dtype != np.int16:
            audio = np.clip(audio, -1.0, 1.0)
            audio = (audio * 32767.0).astype(np.int16)
        sf.write(output_path, audio, sample_rate, subtype="PCM_16")
        duration = len(audio) / float(sample_rate)
        self.warmed_up = True
        self._stage(rid, "done", "生成完成", 100, f"{duration:.2f} 秒")
        result = {
            "filePath": output_path,
            "duration": round(duration, 3),
            "sampleRate": sample_rate,
            "segments": total,
            "elapsed": round(time.time() - started, 2),
            "seed": used_seed,
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
