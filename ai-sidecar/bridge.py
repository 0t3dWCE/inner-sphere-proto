"""Сокет страницы: ws://127.0.0.1:8770/talk

Страница шлёт hello и hear (текст или wav в base64 и снимок комнаты).
Назад приходят line с wav и затем await_player.
"""

import base64
import threading
import time
from pathlib import Path

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocketDisconnect

HOST = "127.0.0.1"
PATH = "/talk"


def serve(queue, port: int) -> None:
    app = _app(queue)

    def run() -> None:
        config = uvicorn.Config(
            app, host=HOST, port=port, log_level="warning", ws="websockets-sansio"
        )
        anyio.run(uvicorn.Server(config).serve)

    threading.Thread(target=run, name="talk", daemon=True).start()
    deadline = time.time() + 20
    while time.time() < deadline:
        if _port_open(port):
            return
        time.sleep(0.05)
    raise RuntimeError(f"сокет страницы не открыл порт {port}")


def _app(queue) -> Starlette:
    async def talk(ws):
        await ws.accept()
        await ws.send_json({"t": "ready"})
        try:
            while True:
                msg = await ws.receive_json()
                kind = msg.get("t")
                if kind == "bye":
                    break
                if kind == "hello":
                    caps = msg.get("capabilities") or {}
                    queue.follow = bool(caps.get("follow"))
                    await ws.send_json({"t": "ready"})
                    continue
                if kind != "hear":
                    await ws.send_json({"t": "rejected", "reason": "неизвестное сообщение"})
                    continue
                try:
                    heard, lines = await anyio.to_thread.run_sync(lambda m=msg: _hear(queue, m))
                except Exception as exc:
                    print(f"ход сорвался: {exc}", flush=True)
                    await ws.send_json({"t": "rejected", "reason": "не разобрал"})
                    continue
                if heard:
                    await ws.send_json({"t": "heard", "text": heard})
                if not lines:
                    await ws.send_json({
                        "t": "rejected",
                        "reason": "не разобрал" if not heard else "не ответил",
                    })
                for line in lines:
                    payload = {
                        "t": "line",
                        "actor": line["actor"],
                        "text": line["text"],
                        "target": line["target"],
                        "tick": line["tick"],
                    }
                    if line.get("wav"):
                        payload["wav"] = _b64(line["wav"])
                    if line.get("order"):
                        payload["order"] = line["order"]
                    if line.get("emote"):
                        payload["emote"] = line["emote"]
                    await ws.send_json(payload)
                await ws.send_json({"t": "await_player"})
        except WebSocketDisconnect:
            return

    return Starlette(routes=[WebSocketRoute(PATH, talk)])


def _hear(queue, msg: dict):
    room = msg.get("room")
    text = msg.get("text")
    wav = msg.get("wav")
    path = None
    if wav:
        raw = base64.b64decode(wav)
        path = Path(queue.out_dir) / f"in-{time.time_ns()}.wav"
        path.write_bytes(raw)
    return queue.hear(text=text, wav_path=str(path) if path else None, room=room)


def _b64(path: str) -> str:
    return base64.b64encode(Path(path).read_bytes()).decode("ascii")


def _port_open(port: int) -> bool:
    import socket
    try:
        with socket.create_connection((HOST, port), timeout=0.2):
            return True
    except OSError:
        return False
