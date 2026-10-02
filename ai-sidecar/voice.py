"""Русский Kokoro. Словари ударений и веса Светы живут до конца процесса.

Окно модели — 512 фонемы вместе с двумя служебными токенами. Длинная реплика
режется на куски по предложениям и склеивается в один wav.
"""

import re
import sys
from pathlib import Path

import soundfile as sf
import torch

SAMPLE_RATE = 24000
_PAUSE = int(SAMPLE_RATE * 0.12)
_SENT = re.compile(r"(?<=[.!?…])\s+")
_CLAUSE = re.compile(r"(?<=[,;:—–])\s+")


class Voice:
    def __init__(self, root: Path):
        root = root.resolve()
        sys.path.insert(0, str(root))
        from kokoro import KModel
        from ru_g2p import RuG2P

        self.g2p = RuG2P()
        self.model = KModel(
            repo_id="zaakirio/kokoro-ru",
            model=str(root / "kokoro-ru-v2-base.pth"),
        ).eval()
        pack = torch.load(root / "voices" / "sveta.pt", map_location="cpu", weights_only=False)
        if pack.ndim != 3 or pack.shape[-1] != 256:
            raise RuntimeError(f"не тот голос Светы: shape={tuple(pack.shape)}")
        self.pack = pack

    def speak(self, text: str, wav_path: Path) -> str:
        pieces = self._pack(text)
        audios = []
        ipas = []
        pause = torch.zeros(_PAUSE)
        with torch.no_grad():
            for piece in pieces:
                ipa, oov = self.g2p(piece)
                if not ipa:
                    continue
                if oov:
                    print(f"голос: вне словаря {''.join(sorted(oov))}", flush=True)
                if self._n_ids(ipa) + 2 > self.model.context_length:
                    raise RuntimeError(f"кусок не влез в окно Kokoro: {piece!r}")
                idx = min(max(len(ipa) - 1, 0), self.pack.shape[0] - 1)
                audio = self.model(ipa, self.pack[idx], 1.0, return_output=True).audio
                if audios:
                    audios.append(pause)
                audios.append(audio.cpu())
                ipas.append(ipa)
        if not audios:
            raise RuntimeError(f"пустая фонетика для {text!r}")
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(wav_path, torch.cat(audios).numpy(), SAMPLE_RATE)
        return " ".join(ipas)

    def _fits(self, text: str) -> bool:
        ipa, _ = self.g2p(text)
        if not ipa:
            return True
        return self._n_ids(ipa) + 2 <= self.model.context_length

    def _n_ids(self, ipa: str) -> int:
        vocab = self.model.vocab
        return sum(1 for ch in ipa if vocab.get(ch) is not None)

    def _pack(self, text: str) -> list[str]:
        out: list[str] = []
        buf = ""
        for sent in _SENT.split(text):
            sent = sent.strip()
            if not sent:
                continue
            if not self._fits(sent):
                if buf:
                    out.append(buf)
                    buf = ""
                out.extend(self._split_until_fits(sent))
                continue
            trial = f"{buf} {sent}".strip() if buf else sent
            if self._fits(trial):
                buf = trial
            else:
                if buf:
                    out.append(buf)
                buf = sent
        if buf:
            out.append(buf)
        return out or [text.strip()]

    def _split_until_fits(self, text: str) -> list[str]:
        clauses = [c.strip() for c in _CLAUSE.split(text) if c.strip()]
        if len(clauses) <= 1:
            return self._split_words(text)
        out: list[str] = []
        buf = ""
        for clause in clauses:
            if not self._fits(clause):
                if buf:
                    out.append(buf)
                    buf = ""
                out.extend(self._split_words(clause))
                continue
            trial = f"{buf} {clause}".strip() if buf else clause
            if self._fits(trial):
                buf = trial
            else:
                if buf:
                    out.append(buf)
                buf = clause
        if buf:
            out.append(buf)
        return out

    def _split_words(self, text: str) -> list[str]:
        out: list[str] = []
        buf = ""
        for word in text.split():
            trial = f"{buf} {word}".strip() if buf else word
            if self._fits(trial):
                buf = trial
                continue
            if buf:
                out.append(buf)
            if self._fits(word):
                buf = word
            else:
                buf = ""
                print(f"голос: слово не влезло в окно, пропущено {word!r}", flush=True)
        if buf:
            out.append(buf)
        return out
