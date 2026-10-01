"""MCP-сервер инструментов. Мозг ходит сюда как клиент, не держит схемы у себя."""

import asyncio
import json
import re
import socket
import threading
import time
from typing import Any, Literal

import anyio
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import MCPServer

MCP_HOST = "127.0.0.1"
MCP_PATH = "/mcp"


class Slot:
    """Состояние текущего хода. Очередь заполняет его до вызова мозга."""

    def __init__(self):
        self.voice = None
        self.profiles = None
        self.queue = None
        self.alloc_wav = None
        self.allowed: set[str] = set()
        self.room: list | None = None
        self.said: dict | None = None
        self.emote: str | None = None
        self.order: str | None = None
        self._said = False

    def prepare(self, allowed: set[str], room: list) -> None:
        self.allowed = set(allowed)
        self.room = room
        self.said = None
        self.emote = None
        self.order = None
        self._said = False


slot = Slot()
server = MCPServer("inner-sphere", log_level="WARNING")


@server.tool()
def say(text: str, target: str = "player") -> str:
    """Короткая реплика текущего персонажа по-русски. Каждую реплику произноси этим инструментом, не обычным текстом. target: player, all или id актёра в комнате."""
    if "say" not in slot.allowed:
        return "rejected: инструменту say этот персонаж не обучен"
    if slot._said:
        return "rejected: вторая реплика в том же ходе отброшена"
    line = _spoken(text)
    if not line:
        return "rejected: пустая реплика"
    if slot.voice is None or slot.alloc_wav is None:
        return "rejected: голос ещё не поднят"
    slot._said = True
    path = slot.alloc_wav()
    slot.voice.speak(line, path)
    who = str(target or "player").strip() or "player"
    slot.said = {"text": line, "target": who, "wav": str(path)}
    return json.dumps({"ok": True, "text": line, "target": who}, ensure_ascii=False)


_LEAD = re.compile(
    r"^(?:[:.\s]*(?:text|текст|реплика|фраза)\s*[:.]\s*)+",
    re.IGNORECASE,
)
_TAIL = re.compile(
    r"[,:]?\s*:?\s*(?:target|цель|кому)\s*:.*$",
    re.IGNORECASE,
)


def _spoken(text: str) -> str:
    """Модель иногда кладёт в реплику ярлык схемы: text, текст, target."""
    line = " ".join(str(text or "").split())
    line = _LEAD.sub("", line)
    line = _TAIL.sub("", line)
    line = re.split(r"[\u4e00-\u9fff]", line, maxsplit=1)[0]
    return line.strip(" ,:")[:200]


_GO = {"follow", "home", "out", "stop", "here", "door", "town", "oasis", "forest", "lake"}


@server.tool()
def go(where: Literal["here", "follow", "home", "door", "town", "oasis", "forest", "lake", "out", "stop"]) -> str:
    """Куда идти и где стоять. Вызывай только если просят идти или стоять, иначе не вызывай. here — стой где стоишь (постой, стой тут, останься, подожди). door — стой у своей двери. town — центр города. oasis — оазис. forest — опушка леса. lake — берег озера. follow — за игроком. home — домой или к каравану. out — то же, что door. stop — только если отпускают к своим делам, не когда просят стоять. Дойдя, стоит, пока не будет нового приказа."""
    if "go" not in slot.allowed:
        return "rejected: инструменту go этот персонаж не обучен"
    place = str(where or "").strip()
    if place not in _GO:
        return "rejected: куда идти можно только follow, home, here, door, town, oasis, forest, lake, out или stop"
    slot.order = place
    return json.dumps({"ok": True, "where": place}, ensure_ascii=False)


@server.tool()
def emote(name: str) -> str:
    """Жест персонажа. Сейчас известен только roar, и только медведракону."""
    if "emote" not in slot.allowed:
        return "rejected: инструменту emote этот персонаж не обучен"
    if name != "roar":
        return "rejected: неизвестный жест"
    slot.emote = name
    return json.dumps({"ok": True, "name": name}, ensure_ascii=False)


@server.tool()
def list_profiles() -> str:
    """Профили актёров и их разрешённые инструменты. Для редактора, не для реплики."""
    return json.dumps(slot.profiles or {}, ensure_ascii=False)


@server.tool()
def world_snapshot() -> str:
    """Последняя комната, которую видела очередь. Пусто, если хода ещё не было."""
    return json.dumps(slot.room or [], ensure_ascii=False)


@server.tool()
def simulate_turn(text: str, room_json: str = "") -> str:
    """Ход без микрофона: текст игрока и необязательный JSON комнаты. В страницу ничего не шлётся."""
    if slot.queue is None:
        return "rejected: очередь ещё не готова"
    room = json.loads(room_json) if room_json.strip() else None
    lines = slot.queue.from_text(text, room)
    return json.dumps(lines, ensure_ascii=False)


def serve(port: int) -> str:
    url = f"http://{MCP_HOST}:{port}{MCP_PATH}"

    def run() -> None:
        anyio.run(lambda: server.run_streamable_http_async(host=MCP_HOST, port=port))

    threading.Thread(target=run, name="mcp", daemon=True).start()
    deadline = time.time() + 20
    while time.time() < deadline:
        if _port_open(port):
            return url
        time.sleep(0.05)
    raise RuntimeError(f"MCP не открыл порт {port}")


def list_tools(url: str) -> list[dict]:
    tools = asyncio.run(_list(url))
    out = []
    for tool in tools:
        schema = tool.input_schema
        if hasattr(schema, "model_dump"):
            schema = schema.model_dump(by_alias=True, exclude_none=True)
        out.append({
            "name": tool.name,
            "description": tool.description or "",
            "parameters": _plain_schema(schema),
        })
    return out


def call_tool(url: str, name: str, arguments: dict) -> str:
    return asyncio.run(_call(url, name, arguments))


def _plain_schema(raw: dict) -> dict:
    """Ollama лучше зовёт инструмент, когда в схеме нет title и default от pydantic."""
    props = {}
    for key, spec in (raw.get("properties") or {}).items():
        prop = {"type": spec.get("type", "string")}
        if spec.get("description"):
            prop["description"] = spec["description"]
        if spec.get("enum"):
            prop["enum"] = list(spec["enum"])
        props[key] = prop
    return {
        "type": "object",
        "properties": props,
        "required": list(raw.get("required") or list(props)),
    }


def ollama_tools(catalog: list[dict], allowed: set[str]) -> list[dict]:
    return [
        {
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool["description"],
                "parameters": tool["parameters"],
            },
        }
        for tool in catalog
        if tool["name"] in allowed
    ]


async def _list(url: str):
    async with streamable_http_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listed = await session.list_tools()
            return listed.tools


async def _call(url: str, name: str, arguments: dict[str, Any]) -> str:
    async with streamable_http_client(url) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool(name, arguments)
    if getattr(result, "isError", False):
        raise RuntimeError(_blocks(result) or f"ошибка инструмента {name}")
    return _blocks(result)


def _blocks(result) -> str:
    parts = []
    for block in getattr(result, "content", None) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts).strip()


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection((MCP_HOST, port), timeout=0.2):
            return True
    except OSError:
        return False
