import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Playback } from "../types";

const playback = atom({ plugin: "say-back", key: "playback" } as const, null);
const replies = atom({ plugin: "say-back", key: "replies" } as const, []);
const index = atom({ plugin: "say-back", key: "index" } as const, -1);
const volume = atom({ plugin: "say-back", key: "volume" } as const, 1);
const speed = atom({ plugin: "say-back", key: "speed" } as const, 1.1);

const HISTORY = 20;
const MIN_SEEK_CELLS = 10;
const MAX_SEEK_CELLS = 40;

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const clamp = (n: number, lo: number, hi: number) =>
  Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;

// The running player, outside $.state: nothing draws from it, and a reload kills the child anyway.
let config = { voice: "af_heart", maxChars: 1500 };
let stop = () => {};
let ctl = ""; // the player's control file
let steering = {
  paused: false,
  volume: 1,
  speed: 1.1,
  seek: null as number | null,
  seq: 0,
};

async function steer($: EngineInterface, change: Partial<typeof steering>) {
  steering = { ...steering, ...change, seq: steering.seq + 1 };
  if (ctl) await $.fs.write(ctl, JSON.stringify(steering));
}

async function play($: EngineInterface, i: number, start = 0) {
  stop();
  const text = (await read($, replies))[i];
  if (text === undefined) return;
  await update($, index, () => i);
  await update($, playback, () => ({
    pos: start,
    dur: 0,
    paused: false,
    done: false,
  }));
  steering = {
    paused: false,
    volume: await read($, volume),
    speed: await read($, speed),
    seek: null,
    seq: 0,
  };
  ctl = "";

  const child = $.process.spawn({
    argv: ["uv", "run", "--quiet", "--script", `${$.plugin.root}/scripts/player.py`],
    input: JSON.stringify({
      ...steering,
      text,
      voice: config.voice,
      max_chars: config.maxChars,
      start,
    }),
  });
  let isStopped = false;
  stop = () => {
    isStopped = true;
    void child.return({ code: null, signal: "SIGTERM" });
  };
  void (async () => {
    let buffered = "";
    let errors = "";
    try {
      for await (const { stream, text: piece } of child) {
        if (isStopped) return;
        if (stream === "stderr") {
          errors = (errors + piece).slice(-300);
          continue;
        }
        const lines = (buffered + piece).split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          const msg = JSON.parse(line) as { ctl?: string } & Playback;
          if (msg.ctl) ctl = msg.ctl;
          else await update($, playback, () => msg);
        }
      }
      if ((await child.result).code) throw new Error(errors.trim().split("\n").pop());
    } catch (err) {
      $.ui.toast(
        `say-back couldn't play: ${err instanceof Error ? err.message : err}. Is uv installed?`,
      );
      return update($, playback, () => null);
    }
    if (!isStopped) await update($, playback, (now) => now && { ...now, done: true });
  })();
}

async function toggle($: EngineInterface) {
  const now = await read($, playback);
  if (!now) return;
  if (now.done) return play($, await read($, index));
  await update($, playback, () => ({ ...now, paused: !now.paused }));
  await steer($, { paused: !now.paused });
}

async function seek($: EngineInterface, t: number) {
  const now = await read($, playback);
  if (!now) return;
  const to = Math.max(0, Math.min(t, now.dur));
  if (now.done) return play($, await read($, index), to);
  await update($, playback, () => ({ ...now, pos: to }));
  await steer($, { seek: to });
}

async function skip($: EngineInterface, by: number) {
  const now = await read($, playback);
  if (by < 0 && now && now.pos > 3) return seek($, 0); // like a music player: restart first
  const i = (await read($, index)) + by;
  if (i >= 0 && i < (await read($, replies)).length) await play($, i);
}

async function setLevel($: EngineInterface, which: "volume" | "speed", by: number) {
  const value =
    which === "volume"
      ? await update($, volume, (v) => clamp(v + by, 0, 1.5))
      : await update($, speed, (v) => clamp(v + by, 0.5, 2));
  await $.store.set(which, value);
  await steer($, { [which]: value });
}

export const register: Register = (on, options) => {
  config = {
    voice: String(options.voice ?? "af_heart"),
    maxChars: Number(options.max_chars ?? 1500),
  };
  let isOn = false; // false under `-p`, the SDK and cloud sessions

  on("session.start", async ($, e, next) => {
    isOn = e.isInteractive && (await $.env.get("CLAUDE_CODE_REMOTE")) !== "true";
    if (isOn) {
      const [savedVolume, savedSpeed] = [await $.store.get("volume"), await $.store.get("speed")];
      if (typeof savedVolume === "number") await update($, volume, () => savedVolume);
      if (typeof savedSpeed === "number") await update($, speed, () => savedSpeed);
      // Fetch the model now so the first reply isn't silent while it downloads.
      void $.process
        .run(
          ["uv", "run", "--quiet", "--script", `${$.plugin.root}/scripts/player.py`, "--setup"],
          { timeoutMs: 600_000 },
        )
        .catch(() => {});
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (
      isOn &&
      options.enabled !== false &&
      !e.agentId &&
      e.reason === "answer" &&
      e.answer.trim()
    ) {
      const list = await update($, replies, (list) => [...list, e.answer].slice(-HISTORY));
      await play($, list.length - 1);
    }
    return done;
  });

  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const now = await read($, playback);
    if (!now || e.props.hasSurvey) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    const [i, count, vol, rate] = [
      await read($, index),
      (await read($, replies)).length,
      await read($, volume),
      await read($, speed),
    ];
    // The seekbar takes what the controls leave (about 74 cells), so the bar stays on one line.
    const cells = Math.max(MIN_SEEK_CELLS, Math.min(MAX_SEEK_CELLS, e.props.bodyColumns - 74));
    const head = now.dur ? Math.min(cells - 1, Math.floor((now.pos / now.dur) * cells)) : 0;
    const isLoading = !now.dur && !now.done;

    // Padded labels give the mouse a wider target; secondary controls stay dim until pointed at.
    return (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text color="cyan">say-back</Text>
        <Text dimColor>
          {i + 1}/{count}
        </Text>
        <Button key="prev" plain label=" |◀ " onPress={() => skip($, -1)} />
        <Button key="back" plain label=" ◀◀ " onPress={() => seek($, now.pos - 10)} />
        <Button
          key="play"
          plain
          label={now.paused || now.done ? " ▶ " : " ❚❚ "}
          onPress={() => toggle($)}
        />
        <Button key="fwd" plain label=" ▶▶ " onPress={() => seek($, now.pos + 10)} />
        <Button key="next" plain label=" ▶| " onPress={() => skip($, 1)} />
        {isLoading ? (
          <Text dimColor>loading voice…</Text>
        ) : (
          <Box flexDirection="row" columnGap={1}>
            <Text>{clock(now.pos)}</Text>
            <Box flexDirection="row">
              {Array.from({ length: cells }, (_, c) => (
                <Button
                  key={`seek${c}`}
                  plain
                  dimColor={c > head}
                  label={c === head ? "●" : c < head ? "━" : "─"}
                  onPress={() => seek($, (c / cells) * now.dur)}
                />
              ))}
            </Box>
            <Text>{clock(now.dur)}</Text>
          </Box>
        )}
        <Button key="vol-" plain dimColor label=" − " onPress={() => setLevel($, "volume", -0.1)} />
        <Text>vol {Math.round(vol * 100)}%</Text>
        <Button key="vol+" plain dimColor label=" + " onPress={() => setLevel($, "volume", 0.1)} />
        <Button key="spd-" plain dimColor label=" − " onPress={() => setLevel($, "speed", -0.1)} />
        <Text>{rate.toFixed(1)}×</Text>
        <Button key="spd+" plain dimColor label=" + " onPress={() => setLevel($, "speed", 0.1)} />
        <Button
          key="close"
          plain
          dimColor
          label=" ✕ "
          onPress={async () => {
            stop();
            await update($, playback, () => null);
          }}
        />
      </Box>
    );
  });
};
