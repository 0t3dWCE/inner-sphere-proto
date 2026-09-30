"""Qwen через локальную Ollama. Инструменты он берёт у MCP.

Схему в поле tools не отдаём: парсер Ollama 0.35 съедает готовый <tool_call>
и возвращает пустой ответ. Модель пишет вызов текстом, мы разбираем его сами
и зовём MCP.
"""

import json
import re
import urllib.request

from mcp_hub import call_tool, slot

_CALL = re.compile(r"<tool_call>\s*", re.IGNORECASE)
_BARE = re.compile(r"\b([A-Za-z_][\w]*)\s*(?:\(\s*)?\{")
_PLACES = "follow|home|out|stop|here|door|town|oasis|forest|lake"
_DOT_GO = re.compile(rf"\bgo\.({_PLACES})\b", re.IGNORECASE)
_WHERE = re.compile(rf"\bgo(?:\.where)?\s*:\s*({_PLACES})\b", re.IGNORECASE)
_SAY_LINE = re.compile(
    r"\bsay(?:\s*[,.]?\s*(?:text|текст))?\s*[:.]\s*(.+)",
    re.IGNORECASE,
)


class Brain:
    def __init__(self, host: str, model: str, mcp_url: str, catalog: list[dict]):
        self.host = host.rstrip("/")
        self.model = model
        self.mcp_url = mcp_url
        self.catalog = catalog

    def warm(self) -> None:
        self._post("/api/generate", {
            "model": self.model,
            "prompt": " ",
            "stream": False,
            "keep_alive": -1,
            "options": {"num_predict": 1, "num_ctx": 4096},
        })

    def turn(self, system: str, user: str, allowed: set[str]) -> dict | None:
        messages = [
            {"role": "system", "content": system + _tool_block(allowed)},
            {"role": "user", "content": user},
        ]
        for _ in range(2):
            data = self._post("/api/chat", {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "keep_alive": -1,
                "options": {"num_ctx": 4096, "temperature": 0.2, "num_predict": 120},
            })
            message = data.get("message") or {}
            content = message.get("content") or ""
            calls = _calls(message.get("tool_calls") or []) or _parse_calls(content)
            if calls:
                for name, args in calls:
                    if name not in allowed:
                        print(f"mcp: {name} персонажу не выдан", flush=True)
                        continue
                    answer = call_tool(self.mcp_url, name, args)
                    if answer.startswith("rejected"):
                        print(f"mcp: {answer}", flush=True)
                if slot.said is not None or "say" not in allowed:
                    return slot.said
            else:
                visible = re.sub(r"<tool_call>.*", "", content, flags=re.DOTALL | re.IGNORECASE).strip()
                if visible:
                    print(f"мозг без инструмента: {visible}", flush=True)
            messages.append(message)
            again = "say: реплика по-русски\n"
            if "go" in allowed and not slot.order:
                again += "go: here\n"
            messages.append({
                "role": "user",
                "content": "Формат нарушен, вслух это не пойдёт. Ответь только этими строками, без пояснений:\n" + again,
            })
        return slot.said

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.host + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.load(resp)


def _tool_block(allowed: set[str]) -> str:
    go = ""
    if "go" in allowed:
        go = (
            "Если просят идти или стоять, добавь вторую строку. Иначе её нет.\n"
            "go: here\n"
            "Вместо here только: door, town, oasis, forest, lake, follow, home, stop.\n"
        )
    if "emote" in allowed:
        go += "Если нужно рыкнуть, добавь строку emote: roar\n"
    return (
        "\n\nОтвет — только строки ниже, без пояснений, пометок и черновика. "
        "Запрещены слова text, target, текст, аргументы и запятая сразу после say.\n"
        "say: реплика по-русски\n"
        + go
    )


def _parse_calls(content: str) -> list[tuple[str, dict]]:
    found = []
    decoder = json.JSONDecoder()
    for match in _CALL.finditer(content):
        rest = content[match.end():]
        start = rest.find("{")
        if start < 0:
            continue
        try:
            obj, _ = decoder.raw_decode(rest[start:])
        except json.JSONDecodeError:
            continue
        call = _call_obj(obj)
        if call:
            found.append(call)
    if found:
        return found
    for match in _BARE.finditer(content):
        try:
            obj, _ = decoder.raw_decode(content[match.end() - 1:])
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict) and (
            (isinstance(obj.get("text", ""), str) and obj.get("text")) or obj.get("where")
        ):
            found.append((match.group(1), obj))
    if found:
        return found
    start = content.find("{")
    if start >= 0:
        try:
            obj, _ = decoder.raw_decode(content[start:])
        except json.JSONDecodeError:
            obj = None
        call = _call_obj(obj)
        if call:
            found.append(call)
    return found or _loose(content)


def _call_obj(obj) -> tuple[str, dict] | None:
    if not isinstance(obj, dict):
        return None
    name = obj.get("name")
    args = obj.get("arguments")
    if not name and isinstance(obj.get("function"), dict):
        fn = obj["function"]
        name = fn.get("name")
        args = fn.get("arguments")
        if args is None and isinstance(fn.get("parameters"), dict) and isinstance(fn["parameters"].get("text"), str):
            args = fn["parameters"]
    if isinstance(args, str):
        try:
            args = json.loads(args) if args else {}
        except json.JSONDecodeError:
            return None
    if name and isinstance(args, dict) and isinstance(args.get("text", ""), str):
        return name, args
    return None


def _loose(content: str) -> list[tuple[str, dict]]:
    """Qwen часто пишет go.follow и say: текст вместо JSON."""
    found = []
    places = [m.group(1).lower() for m in _DOT_GO.finditer(content)]
    places += [m.group(1).lower() for m in _WHERE.finditer(content)]
    if places:
        found.append(("go", {"where": places[0]}))
    for match in _SAY_LINE.finditer(content):
        raw = match.group(1)
        text = re.split(r"[\u4e00-\u9fff]", raw, maxsplit=1)[0]
        if text != raw:
            text = re.sub(r",?\s*\S*$", "", text)
        text = " ".join(text.strip().strip("，。").split())
        if text:
            found.append(("say", {"text": text, "target": "player"}))
            break
    return found


def _calls(calls: list) -> list[tuple[str, dict]]:
    found = []
    for call in calls:
        fn = call.get("function") or {}
        name = fn.get("name")
        if not name:
            continue
        args = fn.get("arguments") or {}
        if isinstance(args, str):
            args = json.loads(args) if args else {}
        found.append((name, args))
    return found
