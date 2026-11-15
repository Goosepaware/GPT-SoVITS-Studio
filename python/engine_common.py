"""Shared plumbing for the GPT-SoVITS Studio Python workers.

The worker protocol is newline-delimited JSON on stdout.  Heavy libraries in
GPT-SoVITS print a lot to stdout, so the original stdout pipe is duplicated for
the protocol and fd 1 is redirected to stderr.  Node reads stdout as protocol
events and stderr as human-readable logs.
"""

from __future__ import annotations

import ctypes
import io
import json
import os
import queue
import sys
import threading
import time
import traceback
from typing import Any

# -I ignores PYTHONIOENCODING; make the log streams UTF-8 before any library
# writes Chinese text.  This keeps the stderr log readable in the UI.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass


class Protocol:
    def __init__(self, engine: str):
        self.engine = engine
        # Keep private handles to the original stdio pipes, then replace the
        # Python-level text streams with explicit UTF-8 wrappers.  Some bundled
        # libraries reset/ignore the console encoding; this makes Chinese logs
        # deterministic regardless of the Windows ANSI code page.
        self._out = os.fdopen(os.dup(1), "w", encoding="utf-8", newline="\n", buffering=1)
        self._old_stdout = sys.stdout
        self._old_stderr = sys.stderr
        try:
            err_fd = os.dup(2)
            err = io.TextIOWrapper(
                os.fdopen(err_fd, "wb", 0),
                encoding="utf-8",
                errors="replace",
                newline="\n",
                line_buffering=True,
            )
            sys.stderr = err
            sys.stdout = err
        except Exception:
            pass
        os.dup2(2, 1)
        try:
            sys.stdin.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    def emit(self, payload: dict[str, Any]) -> None:
        payload.setdefault("engine", self.engine)
        self._out.write(json.dumps(payload, ensure_ascii=False) + "\n")
        self._out.flush()

    def log(self, message: str) -> None:
        print(f"[{self.engine}] {message}", flush=True)

    def result(self, request_id: str | None, data: Any) -> None:
        self.emit({"type": "result", "id": request_id, "data": data})

    def error(self, request_id: str | None, message: str, exc: BaseException | None = None) -> None:
        tb = traceback.format_exc() if exc is not None else None
        self.emit({"type": "error", "id": request_id, "message": message, "traceback": tb})

    def status(
        self,
        state: str,
        models: dict[str, str] | None = None,
        message: str | None = None,
        vram: dict[str, int] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "type": "status",
            "status": {
                "engine": self.engine,
                "state": state,
                "pid": os.getpid(),
                "models": models or {},
                "startedAt": STARTED_AT,
            },
        }
        if message is not None:
            payload["status"]["message"] = message
        if vram is not None:
            payload["status"]["vram"] = vram
        self.emit(payload)

    def stage(self, request_id: str | None, stage: str, label: str, progress: float | None = None, detail: str | None = None) -> None:
        payload: dict[str, Any] = {
            "type": "stage",
            "id": request_id,
            "stage": stage,
            "label": label,
        }
        if progress is not None:
            payload["progress"] = max(0.0, min(100.0, float(progress)))
        if detail:
            payload["detail"] = detail
        self.emit(payload)

    def progress(self, request_id: str | None, current: int, total: int, label: str | None = None, detail: str | None = None) -> None:
        payload: dict[str, Any] = {
            "type": "progress",
            "id": request_id,
            "current": int(current),
            "total": int(total),
        }
        if label:
            payload["label"] = label
        if detail:
            payload["detail"] = detail
        self.emit(payload)

    def cancelled(self, request_id: str | None) -> None:
        self.emit({"type": "cancelled", "id": request_id})


STARTED_AT = int(time.time() * 1000)


def vram_snapshot(torch_module=None) -> dict[str, int] | None:
    try:
        if torch_module is None:
            import torch as torch_module  # type: ignore
        if not torch_module.cuda.is_available():
            return None
        free, total = torch_module.cuda.mem_get_info()
        return {
            "allocatedMB": int(torch_module.cuda.memory_allocated() / 1024 / 1024),
            "reservedMB": int(torch_module.cuda.memory_reserved() / 1024 / 1024),
            "freeMB": int(free / 1024 / 1024),
            "totalMB": int(total / 1024 / 1024),
        }
    except Exception:
        return None


def activate_engine(engine_root: str) -> None:
    """Prepare the bundled runtime exactly like the upstream launchers do."""
    engine_root = os.path.abspath(engine_root)
    os.chdir(engine_root)
    if engine_root not in sys.path:
        sys.path.insert(0, engine_root)
    from tools.portable_runtime import activate

    activate(change_cwd=True)


class WorkerBase:
    def __init__(self, engine: str, engine_root: str, data_dir: str):
        self.proto = Protocol(engine)
        self.engine_root = os.path.abspath(engine_root)
        self.data_dir = os.path.abspath(data_dir)
        os.makedirs(self.data_dir, exist_ok=True)
        self.cancel_event = threading.Event()
        self._queue: queue.Queue[dict[str, Any]] = queue.Queue()
        self._shutdown = threading.Event()
        self._reader = threading.Thread(target=self._read_stdin, name="stdin-reader", daemon=True)
        self._watchdog = threading.Thread(target=self._watch_parent, name="parent-watchdog", daemon=True)

    def _start_threads(self) -> None:
        # Important: keep the process single-threaded while importing scipy /
        # OpenBLAS. Starting threads before that import deadlocks on some
        # Windows builds of this runtime.
        self._reader.start()
        if os.environ.get("GSV_NO_WATCHDOG") != "1":
            self._watchdog.start()

    def _watch_parent(self) -> None:
        """Exit hard when the Electron parent disappears (releases VRAM)."""
        parent = os.getppid()
        if os.name == "nt":
            synchronize = 0x00100000
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(synchronize, False, parent)
            if not handle:
                return
            try:
                while True:
                    if kernel32.WaitForSingleObject(handle, 2000) == 0:
                        os._exit(1)
            finally:
                kernel32.CloseHandle(handle)
        else:
            while True:
                time.sleep(2)
                if os.getppid() != parent:
                    os._exit(1)

    def _read_stdin(self) -> None:
        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    command = json.loads(line)
                except Exception as exc:
                    self.proto.emit({"type": "error", "message": f"invalid command: {exc}"})
                    continue
                if command.get("cmd") == "cancel":
                    self.cancel_event.set()
                    self.on_cancel()
                    continue
                if command.get("cmd") == "shutdown":
                    self.cancel_event.set()
                    self.on_cancel()
                    self._shutdown.set()
                    self._queue.put(command)
                    continue
                self._queue.put(command)
        except Exception:
            pass
        self.cancel_event.set()
        self.on_cancel()
        self._shutdown.set()
        self._queue.put({"cmd": "shutdown"})

    def on_cancel(self) -> None:
        pass

    def run(self) -> None:
        self.proto.status("starting", {"process": "initializing"})
        try:
            self.on_start()
        except Exception as exc:
            self.proto.error(None, f"engine initialization failed: {exc}", exc)
            self.proto.status("error", {}, str(exc))
            raise SystemExit(1)
        self._start_threads()
        while not self._shutdown.is_set():
            try:
                command = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            cmd = command.get("cmd")
            if cmd == "shutdown":
                break
            request_id = command.get("id")
            try:
                if cmd == "ping":
                    self.proto.result(request_id, {"pong": True, "pid": os.getpid()})
                elif cmd == "status":
                    self.proto.result(request_id, self.get_status())
                else:
                    self.dispatch(command)
            except Exception as exc:
                self.proto.error(request_id, str(exc), exc)
                self.proto.status("ready" if self.is_loaded() else "stopped", self.model_names(), str(exc))
        self.on_shutdown()

    def on_start(self) -> None:
        pass

    def on_shutdown(self) -> None:
        pass

    def dispatch(self, command: dict[str, Any]) -> None:
        raise NotImplementedError

    def get_status(self) -> dict[str, Any]:
        return {
            "engine": self.proto.engine,
            "state": "ready" if self.is_loaded() else "stopped",
            "pid": os.getpid(),
            "models": self.model_names(),
            "startedAt": STARTED_AT,
            "vram": vram_snapshot(),
        }

    def is_loaded(self) -> bool:
        return False

    def model_names(self) -> dict[str, str]:
        return {}
