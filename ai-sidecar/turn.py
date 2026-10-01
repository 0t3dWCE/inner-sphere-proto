"""Одна очередь: слух, затем мозг, затем голос. Второй ход ждёт первый."""

import json
import threading
from pathlib import Path

from mcp_hub import slot

MAX_AUTOTICKS = 3
HISTORY = 12

DEFAULT_ROOM = [
    {
        "id": 4,
        "kind": "resident",
        "name": "житель дома 4",
        "hp": 5,
        "st": "out",
        "arcM": 6.2,
        "place": "улица у своей двери",
    }
]


class Queue:
    def __init__(self, ear, voice, brain, profiles: dict, out_dir: Path, people: dict | None = None):
        self.ear = ear
        self.voice = voice
        self.brain = brain
        self.profiles = profiles
        self.people = people or {}
        self.out_dir = out_dir
        self.history = []
        self.follow = True
        self._n = 0
        self._lock = threading.Lock()

    def from_wav(self, wav_path: str, room: list | None = None) -> list[dict]:
        return self.hear(wav_path=wav_path, room=room)[1]

    def from_text(self, text: str, room: list | None = None) -> list[dict]:
        return self.hear(text=text, room=room)[1]

    def hear(self, text: str | None = None, wav_path: str | None = None, room: list | None = None):
        """Пустая комната (список) — некому отвечать. None — комната по умолчанию для терминала."""
        with self._lock:
            if wav_path:
                text = self.ear.transcribe(wav_path)
                print(f"услышал: {text}", flush=True)
            text = (text or "").strip()
            if not text:
                return "", []
            room = _with_people(DEFAULT_ROOM if room is None else room, self.people)
            return text, self._speak_chain(text, room)

    def _speak_chain(self, player_text: str, room: list) -> list[dict]:
        self.history.append({"sender": "player", "text": player_text})
        self.history = self.history[-HISTORY:]
        lines = []
        actor = _closest(room, self.profiles)
        if actor is None:
            print("в комнате некому отвечать", flush=True)
            return lines
        pending = player_text
        addressed = "player"
        for tick in range(MAX_AUTOTICKS + 1):
            profile = self.profiles[actor["kind"]]
            allowed = [name for name in profile["allowed_tools"] if self.follow or name != "go"]
            slot.prepare(set(allowed), room)
            said = self.brain.turn(
                _system(actor, profile, allowed),
                _user(actor, room, self.history, pending, addressed),
                slot.allowed,
            )
            if said is None and not slot.order:
                print("модель не вызвала say", flush=True)
                break
            line = {
                "actor": actor["id"],
                "text": said["text"] if said else "",
                "target": said["target"] if said else "player",
                "wav": said["wav"] if said else "",
                "emote": slot.emote,
                "order": slot.order,
                "tick": tick,
            }
            lines.append(line)
            if said:
                print(f"{actor['name']}: {said['text']}", flush=True)
                print(f"wav: {said['wav']}", flush=True)
            if slot.order:
                print(f"приказ: {slot.order}", flush=True)
            if said is None:
                break
            self.history.append({"sender": actor["name"], "text": said["text"]})
            self.history = self.history[-HISTORY:]
            nxt = _target_actor(said["target"], room, actor, self.profiles)
            if nxt is None or tick == MAX_AUTOTICKS:
                break
            pending = said["text"]
            addressed = actor["name"]
            actor = nxt
        return lines

    def _wav_path(self) -> Path:
        self._n += 1
        return self.out_dir / f"{self._n:04d}.wav"


def load_profiles(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_people(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _with_people(room: list, people: dict) -> list:
    named = []
    for actor in room:
        card = people.get(str(actor.get("id")))
        if not card:
            named.append(actor)
            continue
        copy = dict(actor)
        copy["name"] = card["name"]
        copy["manner"] = card.get("manner", "")
        copy["story"] = card.get("story", "")
        named.append(copy)
    return named


def _closest(room: list, profiles: dict) -> dict | None:
    alive = [
        a for a in room
        if a.get("kind") in profiles and a.get("hp", 1) > 0 and a.get("st") != "dead"
    ]
    if not alive:
        return None
    return min(alive, key=lambda a: a.get("arcM", 0))


def _target_actor(target: str, room: list, current: dict, profiles: dict) -> dict | None:
    if target in ("player", "all", "", str(current.get("id"))):
        return None
    for actor in room:
        if str(actor.get("id")) == target and actor.get("kind") in profiles and actor.get("hp", 1) > 0:
            return actor
    return None


def _system(actor: dict, profile: dict, allowed: list) -> str:
    return (
        "Ты говоришь за персонажа в игре на внутренней поверхности сферы. "
        "Одна реплика, по-русски, до 200 символов. "
        "Не описывай действия и не объясняй правила мира.\n"
        + (
            "Речь произноси инструментом say. Если просят идти или стоять, обязательно вызови go: "
            "слова реплики сами по себе персонажа не двигают и не останавливают.\n"
            if "go" in allowed else "Речь произноси инструментом say.\n"
        )
        + (
            "Рык произноси инструментом emote.\n"
            if "emote" in allowed else ""
        )
        + f"Имя: {actor.get('name')}. Если спрашивают, как зовут, назови это имя и никакое другое.\n"
        f"Роль: {profile['personality']}\n"
        + (
            f"Манера: {actor['manner']}\n"
            "Твоя история. Расскажи её только если спросят, кто ты, откуда ты, или просят историю либо песню. "
            "Коротко и своей манерой. Чужую жизнь не присваивай.\n"
            f"{actor['story']}\n"
            if actor.get("story") else ""
        )
        + f"Сейчас: {actor.get('place', '')}, hp {actor.get('hp', '?')}."
    )


def _user(actor: dict, room: list, history: list, pending: str, addressed: str) -> str:
    others = [
        f"- {a.get('name')} ({a.get('place')}, {a.get('arcM')} м)"
        for a in room
        if a.get("id") != actor.get("id")
    ]
    near = "\n".join(others) if others else "никого"
    past = "\n".join(f"{h['sender']}: {h['text']}" for h in history[-HISTORY:]) or "пусто"
    return (
        f"Кто ещё в комнате:\n{near}\n\n"
        f"Недавние реплики:\n{past}\n\n"
        f"Тебе сказал {addressed}: {pending}"
    )
