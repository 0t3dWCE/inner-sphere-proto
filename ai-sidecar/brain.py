"""Qwen через локальную Ollama. Схемы инструментов приходят из MCP и уходят в поле tools.

Ответ модели — message.tool_calls. Sidecar вызывает эти инструменты через MCP.
Обычную фразу без вызова тоже произносим: Qwen иногда говорит текстом, а не say.
"""

import json
import re
import urllib.request

from mcp_hub import call_tool, ollama_tools, slot


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
            "think": False,
            "keep_alive": -1,
            "options": {"num_predict": 1, "num_ctx": 4096},
        })

    def turn(self, system: str, user: str, allowed: set[str]) -> dict | None:
        messages = [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ]
        tools = ollama_tools(self.catalog, allowed)
        for step in range(2):
            payload = {
                "model": self.model,
                "messages": messages,
                "stream": False,
                "think": False,
                "keep_alive": -1,
                "options": {"num_ctx": 4096, "temperature": 0.2, "num_predict": 800},
            }
            if tools:
                payload["tools"] = tools
            data = self._post("/api/chat", payload)
            message = data.get("message") or {}
            content = (message.get("content") or "").strip()
            calls = _calls(message.get("tool_calls") or [])
            if not content and not calls:
                thought = " ".join((message.get("thinking") or "").split())
                if thought:
                    print(f"мозг думал вместо реплики: {thought[:160]}", flush=True)
            if calls:
                messages.append(message)
                for name, args in calls:
                    if name not in allowed:
                        answer = f"rejected: {name} персонажу не выдан"
                        print(f"mcp: {answer}", flush=True)
                    else:
                        answer = call_tool(self.mcp_url, name, args)
                        if answer.startswith("rejected"):
                            print(f"mcp: {answer}", flush=True)
                    messages.append({"role": "tool", "tool_name": name, "content": answer})
                if slot.said is None and _plain_line(content) and "say" in allowed:
                    call_tool(self.mcp_url, "say", {"text": content, "target": "player"})
                if slot.said is not None or "say" not in allowed:
                    return slot.said
                messages.append({
                    "role": "user",
                    "content": "Скажи реплику инструментом say. Другие инструменты в этом ходе больше не вызывай.",
                })
                continue
            if _plain_line(content) and "say" in allowed:
                call_tool(self.mcp_url, "say", {"text": content, "target": "player"})
                if slot.said is not None:
                    return slot.said
            if content:
                print(f"мозг без инструмента: {content}", flush=True)
            messages.append(message)
            if step == 0:
                messages.append({"role": "user", "content": "Ответь инструментом say."})
        return slot.said

    def _post(self, path: str, payload: dict) -> dict:
        req = urllib.request.Request(
            self.host + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.load(resp)


def _plain_line(text: str) -> bool:
    """Qwen 3.5 иногда отвечает самой фразой, без вызова say."""
    if not text or len(" ".join(text.split())) > 1000:
        return False
    return re.match(r"^(say|go|emote)\b", text, re.IGNORECASE) is None


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
