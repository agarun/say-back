# /// script
# requires-python = ">=3.10"
# dependencies = ["kokoro-onnx>=0.6.1,<0.7", "sounddevice>=0.5"]
# ///
"""Play replies on-device

stdin:  {"text", "voice", "speed", "volume", "max_chars", "start"}
stdout: {"ctl": path} once, then {"pos", "dur", "paused", "done"} lines, four a second.
The mod steers playback by writing {"paused", "volume", "speed", "seek", "seq"} to `ctl`.
`--setup` only downloads the model.
"""

import json, os, re, sys, threading, time, urllib.request
from pathlib import Path

DATA = Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache") / "say-back"
BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
FILES = ("kokoro-v1.0.int8.onnx", "voices-v1.0.bin")
LANGS = {
    "a": "en-us",
    "b": "en-gb",
    "e": "es",
    "f": "fr-fr",
    "h": "hi",
    "i": "it",
    "p": "pt-br",
}
SR = 24000
GAP = 0.2  # seconds of silence between sentences


def models() -> list[str]:
    DATA.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        if not (DATA / name).exists():
            part = DATA / f"{name}.{os.getpid()}.part"
            urllib.request.urlretrieve(BASE + name, part)
            os.replace(
                part, DATA / name
            )  # atomic: an interrupted download never looks complete
    return [str(DATA / name) for name in FILES]


def clean(text: str, limit: int) -> str:
    text = re.sub(r"```.*?```", " Code block omitted. ", text, flags=re.S)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+", "link", text)
    text = re.sub(r"^\s*(#+|>|[-*+]|\|)\s*", "", text, flags=re.M)
    text = re.sub(r"[`*_|~]+|<[^>]+>", "", text)
    text = re.sub(
        r"(\w)[ \t]*\n+", r"\1. ", text
    )  # pause after headings and list items
    text = re.sub(r"\s+", " ", text).strip()
    if 0 < limit < len(text):
        cut = text[:limit]
        text = cut[: cut.rfind(". ") + 1 or limit]
    return text


class Player:
    def __init__(self, req: dict):
        import numpy as np
        from kokoro_onnx import Kokoro

        self.np = np
        self.kokoro = Kokoro(*models())
        self.voice = req.get("voice") or "af_heart"
        self.speed = float(req.get("speed") or 1.1)
        self.volume = float(req.get("volume") or 1.0)
        self.paused = False
        text = clean(req.get("text", ""), int(req.get("max_chars") or 0))
        self.parts = [s for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
        self.audio: list = [None] * len(self.parts)
        self.cur, self.off = 0, 0  # sentence being played, sample offset into it
        self.cv = threading.Condition()
        self.seek(float(req.get("start") or 0))
        threading.Thread(target=self.synth, daemon=True).start()

    def length(self, i: int) -> float:
        a = self.audio[i]
        if a is not None:
            return len(a) / SR
        done = [j for j, x in enumerate(self.audio) if x is not None]
        chars = sum(len(self.parts[j]) for j in done)
        rate = (
            sum(len(self.audio[j]) / SR for j in done) / chars
            if chars
            else 0.07 / self.speed
        )
        return len(self.parts[i]) * rate + GAP

    def synth(self) -> None:
        """Synthesize the first missing sentence from the playhead on, forever."""
        while True:
            with self.cv:
                todo = [
                    j for j in range(self.cur, len(self.parts)) if self.audio[j] is None
                ]
                if not todo:
                    self.cv.wait()
                    continue
                j, speed = todo[0], self.speed
            samples, _ = self.kokoro.create(
                self.parts[j],
                voice=self.voice,
                speed=speed,
                lang=LANGS.get(self.voice[0], "en-us"),
            )
            audio = self.np.concatenate(
                [samples, self.np.zeros(int(SR * GAP), "float32")]
            )
            with self.cv:
                if (
                    speed == self.speed
                ):  # a speed change while synthesizing discards this one
                    self.audio[j] = audio
                self.cv.notify_all()

    def seek(self, t: float) -> None:
        with self.cv:
            i = 0
            while i < len(self.parts) and t >= self.length(i):
                t -= self.length(i)
                i += 1
            self.cur, self.off = i, int(max(t, 0) * SR)
            self.cv.notify_all()

    def steer(self, ctl: dict, last_seq: int) -> int:
        self.paused = bool(ctl.get("paused"))
        self.volume = float(ctl.get("volume", self.volume))
        speed = float(ctl.get("speed", self.speed))
        if speed != self.speed:
            with self.cv:  # resynthesize everything but the sentence now playing
                self.speed = speed
                self.audio = [
                    a if i == self.cur else None for i, a in enumerate(self.audio)
                ]
                self.cv.notify_all()
        if ctl.get("seq", 0) != last_seq and ctl.get("seek") is not None:
            self.seek(float(ctl["seek"]))
        return ctl.get("seq", 0)

    def status(self, done: bool = False) -> None:
        pos = (
            sum(self.length(i) for i in range(min(self.cur, len(self.parts))))
            + self.off / SR
        )
        dur = sum(self.length(i) for i in range(len(self.parts)))
        print(
            json.dumps(
                {
                    "pos": round(pos, 2),
                    "dur": round(dur, 2),
                    "paused": self.paused,
                    "done": done,
                }
            ),
            flush=True,
        )

    def run(self, ctl_path: Path) -> None:
        import sounddevice as sd

        step, raw, seq, shown = SR // 10, "", 0, 0.0
        with sd.OutputStream(samplerate=SR, channels=1, dtype="float32") as out:
            while self.cur < len(self.parts):
                try:  # the mod rewrites this file; a half-written read is retried next pass
                    text = ctl_path.read_text()
                    if text != raw:
                        seq, raw = self.steer(json.loads(text), seq), text
                except (OSError, ValueError):
                    pass
                if time.monotonic() - shown > 0.25:
                    self.status()
                    shown = time.monotonic()
                with self.cv:
                    audio = self.audio[self.cur]
                if self.paused or audio is None:
                    time.sleep(0.05)
                    continue
                block = audio[self.off : self.off + step]
                if len(block) == 0:
                    self.cur, self.off = self.cur + 1, 0
                    continue
                self.off += len(block)
                out.write(block * self.volume)
        self.status(done=True)


def main() -> None:
    if "--setup" in sys.argv:
        models()
        return
    ctl = DATA / f"ctl-{os.getpid()}.json"
    try:
        player = Player(json.load(sys.stdin))
        print(json.dumps({"ctl": str(ctl)}), flush=True)
        player.run(ctl)
    finally:
        ctl.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
