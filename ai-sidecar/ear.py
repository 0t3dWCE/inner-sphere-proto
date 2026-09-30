"""Whisper large-v3-turbo, один процесс whisper-server на Metal."""

import json
import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request


class Ear:
    def __init__(self, model: str, port: int, log_path: str):
        self.port = port
        self.log_path = log_path
        if _port_open(port):
            raise RuntimeError(f"порт {port} уже занят. Останови прошлый whisper-server и запусти снова.")
        self._log = open(log_path, "w", encoding="utf-8")
        self.proc = subprocess.Popen(
            [
                "whisper-server",
                "-m", model,
                "-l", "ru",
                "--host", "127.0.0.1",
                "--port", str(port),
                "-nt",
            ],
            stdout=self._log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    def wait_ready(self, timeout: float = 120) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                self._log.flush()
                tail = _tail(self.log_path)
                raise RuntimeError(f"whisper-server завершился\n{tail}")
            if _port_open(self.port):
                return
            time.sleep(0.2)
        raise RuntimeError(f"whisper-server не открыл порт {self.port} за {timeout:.0f} с")

    def transcribe(self, wav_path: str) -> str:
        if os.path.getsize(wav_path) < 1000:
            print("слух: запись слишком короткая", flush=True)
            return ""
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/inference",
            data=_multipart({"file": wav_path, "response_format": "json", "language": "ru", "temperature": "0"}),
            headers={"Content-Type": _multipart.content_type},
        )
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace").strip().splitlines()
            tail = detail[-1] if detail else err.reason
            print(f"слух: не разобрал ({err.code}: {tail})", flush=True)
            return ""
        data = json.loads(body)
        text = (data.get("text") or "").strip()
        if not text and data.get("segments"):
            text = " ".join((s.get("text") or "").strip() for s in data["segments"]).strip()
        return text

    def close(self) -> None:
        if self.proc.poll() is None:
            try:
                os.killpg(self.proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self._log.close()


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def _tail(path: str, n: int = 30) -> str:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except OSError:
        return ""
    return "".join(lines[-n:])


def _multipart(fields: dict):
    boundary = "----sidecar-ear"
    chunks = []
    for key, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        if key == "file":
            name = os.path.basename(value)
            chunks.append(
                f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f"Content-Type: audio/wav\r\n\r\n".encode()
            )
            with open(value, "rb") as f:
                chunks.append(f.read())
            chunks.append(b"\r\n")
        else:
            chunks.append(
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
            )
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    _multipart.content_type = f"multipart/form-data; boundary={boundary}"
    return body
