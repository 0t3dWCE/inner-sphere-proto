"""Русский Kokoro. Словари ударений и веса Светы живут до конца процесса."""

import sys
from pathlib import Path

import soundfile as sf
import torch

SAMPLE_RATE = 24000


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
        ipa, oov = self.g2p(text)
        if not ipa:
            raise RuntimeError(f"пустая фонетика для {text!r}")
        if oov:
            print(f"голос: вне словаря {''.join(sorted(oov))}", flush=True)
        idx = min(max(len(ipa) - 1, 0), self.pack.shape[0] - 1)
        with torch.no_grad():
            audio = self.model(ipa, self.pack[idx], 1.0, return_output=True).audio
        wav_path.parent.mkdir(parents=True, exist_ok=True)
        sf.write(wav_path, audio.cpu().numpy(), SAMPLE_RATE)
        return ipa
