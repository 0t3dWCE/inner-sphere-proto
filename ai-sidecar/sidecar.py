#!/usr/bin/env python3
"""Очередь помощника: слух, мозг и голос в одном процессе.

Запуск только из окружения Kokoro:

    ~/venvs/kokoro/bin/python sidecar.py
    ~/venvs/kokoro/bin/python sidecar.py --text "Выйди на улицу"
    ~/venvs/kokoro/bin/python sidecar.py --wav ~/models/kokoro-ru/ru-test.wav
"""

import argparse
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

KOKORO = Path(os.environ.get("SIDECAR_KOKORO", Path.home() / "models" / "kokoro-ru"))
WHISPER = Path(os.environ.get(
    "SIDECAR_WHISPER_MODEL",
    Path.home() / "models" / "whisper" / "ggml-large-v3-turbo.bin",
))
WHISPER_PORT = int(os.environ.get("SIDECAR_WHISPER_PORT", "8771"))
MCP_PORT = int(os.environ.get("SIDECAR_MCP_PORT", "8772"))
TALK_PORT = int(os.environ.get("SIDECAR_TALK_PORT", "8770"))
OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("SIDECAR_LLM", "qwen2.5:7b")


def main() -> int:
    args = _args()
    missing = [p for p in (KOKORO / "ru_g2p.py", KOKORO / "kokoro-ru-v2-base.pth", WHISPER) if not p.exists()]
    if missing:
        for path in missing:
            print(f"нет файла: {path}", file=sys.stderr)
        return 1

    from brain import Brain
    from bridge import serve as serve_talk
    from ear import Ear
    from mcp_hub import list_tools, serve, slot
    from turn import Queue, load_people, load_profiles
    from voice import Voice

    out = HERE / "out"
    out.mkdir(exist_ok=True)
    ear = Ear(str(WHISPER), WHISPER_PORT, str(out / "whisper.log"))
    try:
        print("слух: гружу large-v3-turbo…", flush=True)
        ear.wait_ready()
        print(f"слух: whisper-server на 127.0.0.1:{WHISPER_PORT}", flush=True)

        print("голос: гружу Свету и ударения…", flush=True)
        voice = Voice(KOKORO)
        print("голос: Света в памяти", flush=True)

        print("mcp: поднимаю инструменты…", flush=True)
        mcp_url = serve(MCP_PORT)
        catalog = list_tools(mcp_url)
        names = ", ".join(tool["name"] for tool in catalog)
        print(f"mcp: {mcp_url} — {names}", flush=True)

        print(f"мозг: прогреваю {OLLAMA_MODEL}…", flush=True)
        brain = Brain(OLLAMA, OLLAMA_MODEL, mcp_url, catalog)
        brain.warm()
        print("мозг: модель в памяти, инструменты взяты у MCP", flush=True)

        profiles = load_profiles(HERE / "profiles.json")
        people = load_people(HERE / "people.json")
        queue = Queue(ear, voice, brain, profiles, out, people)
        slot.voice = voice
        slot.profiles = profiles
        slot.queue = queue
        slot.alloc_wav = queue._wav_path
        serve_talk(queue, TALK_PORT)
        print(f"сокет: ws://127.0.0.1:{TALK_PORT}/talk", flush=True)
        print("готов", flush=True)
        if args.text:
            queue.from_text(args.text)
        elif args.wav:
            queue.from_wav(args.wav)
        else:
            _repl(queue)
    finally:
        ear.close()
    return 0


def _repl(queue) -> None:
    print("text <фраза>   — мозг и голос", flush=True)
    print("wav <файл>     — слух, затем мозг и голос", flush=True)
    print("quit           — выйти", flush=True)
    while True:
        try:
            line = input("> ").strip()
        except (EOFError, KeyboardInterrupt):
            print(flush=True)
            return
        if not line:
            continue
        if line in ("quit", "exit"):
            return
        cmd, _, rest = line.partition(" ")
        try:
            if cmd == "text" and rest:
                queue.from_text(rest)
            elif cmd == "wav" and rest:
                queue.from_wav(rest)
            else:
                print("жду: text <фраза>  или  wav <файл>", flush=True)
        except Exception as exc:
            print(f"ошибка: {exc}", flush=True)


def _args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Очередь слуха, мозга и голоса")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--text", help="одна фраза игрока, затем выход")
    g.add_argument("--wav", help="один wav, затем выход")
    return p.parse_args()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
