import { atom, read, update } from 'claude-code';
import type { EngineInterface, Register } from 'claude-code';

import type { Control, Playback, Seek } from '../types';
import { controls } from './controls';
import { clock, headOf } from './seekbar';
import { type Char, locate, takeOver } from './underline';

const playback = atom({ plugin: 'say-back', key: 'playback' } as const, null);
const replies = atom({ plugin: 'say-back', key: 'replies' } as const, []);
const index = atom({ plugin: 'say-back', key: 'index' } as const, -1);
const volume = atom({ plugin: 'say-back', key: 'volume' } as const, 1);
const speed = atom({ plugin: 'say-back', key: 'speed' } as const, 1.1);

const HISTORY = 20;
// Keys pressed while the bar has the keyboard (after a click on it, until Escape). Not shown.
const KEYS: Record<string, string> = {
  b: 'prev',
  j: 'back',
  k: 'play',
  l: 'fwd',
  n: 'next',
  m: 'mute',
  space: 'play',
  ' ': 'play',
  left: 'back',
  right: 'fwd',
};
const MIN_SEEK_CELLS = 10;
const MAX_SEEK_CELLS = 40;

const clamp = (n: number, lo: number, hi: number) =>
  Math.round(Math.min(hi, Math.max(lo, n)) * 10) / 10;

let config = {
  voice: 'af_heart',
  maxChars: 1500,
  underline: false,
  autoplay: true,
};
let stop = () => {};
let generation = 0;
let ctl = ''; // the player's control file
let beforeMute = 1; // the volume to come back to when unmuting
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

async function play($: EngineInterface, i: number, start = 0, paused = false) {
  stop();
  const mine = ++generation;
  const text = (await read($, replies))[i];
  if (text === undefined || mine !== generation) return;
  // Another session may have muted or changed the volume since this one last read it; the store
  // keeps the latest, so each reply starts at that level.
  const stored = await $.store.get('volume');
  if (typeof stored === 'number') await update($, volume, () => stored);
  await update($, index, () => i);
  await update($, playback, () => ({
    pos: start,
    dur: 0,
    paused,
    done: false,
  }));
  steering = {
    paused,
    volume: await read($, volume),
    speed: await read($, speed),
    seek: null,
    seq: 0,
  };
  ctl = '';
  if (mine !== generation) return;

  const child = $.process.spawn({
    argv: [
      'uv',
      'run',
      '--quiet',
      '--script',
      `${$.plugin.root}/scripts/player.py`,
    ],
    input: JSON.stringify({
      ...steering,
      text,
      voice: config.voice,
      max_chars: config.maxChars,
      start,
    }),
  });
  let isStopped = false;
  const isLive = () => !isStopped && mine === generation;
  stop = () => {
    isStopped = true;
    void child.return({ code: null, signal: 'SIGTERM' });
  };
  void (async () => {
    let buffered = '';
    let errors = '';
    let started = false;
    try {
      for await (const { stream, text: piece } of child) {
        started = true;
        if (!isLive()) return;
        if (stream === 'stderr') {
          errors = (errors + piece).slice(-300);
          continue;
        }
        const lines = (buffered + piece).split('\n');
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const msg = JSON.parse(line) as { ctl?: string } & Playback;
          if (!isLive()) return;
          if (msg.ctl) ctl = msg.ctl;
          else await update($, playback, () => msg);
        }
      }
      started = true;
      const exit = await child.result.catch(() => undefined);
      if (isLive() && exit?.code) {
        throw new Error(
          errors.trim().split('\n').pop() || `player exited with ${exit.code}`,
        );
      }
    } catch (err) {
      if (!isLive()) return;
      const why = err instanceof Error ? err.message : String(err);
      $.ui.toast(
        `say-back couldn't play: ${why}${started ? '' : '. Is uv installed?'}`,
      );
      return update($, playback, () => null);
    }
    if (isLive())
      await update($, playback, (now) => now && { ...now, done: true });
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

async function setLevel(
  $: EngineInterface,
  which: 'volume' | 'speed',
  by: number,
) {
  const value =
    which === 'volume'
      ? await update($, volume, (v) => clamp(v + by, 0, 1.5))
      : await update($, speed, (v) => clamp(v + by, 0.5, 2));
  await $.store.set(which, value);
  await steer($, { [which]: value });
}

async function toggleMute($: EngineInterface) {
  const now = await read($, volume);
  if (now > 0) {
    beforeMute = now;
    await $.store.set('beforeMute', now);
  }
  const value = await update($, volume, () => (now > 0 ? 0 : beforeMute));
  await $.store.set('volume', value);
  await steer($, { volume: value });
}

async function act($: EngineInterface, key: string) {
  const now = await read($, playback);
  if (key === 'prev') return skip($, -1);
  if (key === 'next') return skip($, 1);
  if (key === 'play') return toggle($);
  if (key === 'back' && now) return seek($, now.pos - 10);
  if (key === 'fwd' && now) return seek($, now.pos + 10);
  if (key === 'vol-') return setLevel($, 'volume', -0.1);
  if (key === 'vol+') return setLevel($, 'volume', 0.1);
  if (key === 'mute') return toggleMute($);
  if (key === 'spd-') return setLevel($, 'speed', -0.1);
  if (key === 'spd+') return setLevel($, 'speed', 0.1);
  if (key === 'close') {
    stop();
    await update($, playback, () => null);
  }
}

export const register: Register = (on, options) => {
  config = {
    voice: String(options.voice ?? 'af_heart'),
    maxChars: Number(options.max_chars ?? 1500),
    underline: options.underline === true,
    autoplay: options.autoplay !== false,
  };
  let isOn = false; // false under `-p`, the SDK and cloud sessions

  on('session.start', async ($, e, next) => {
    isOn =
      e.isInteractive && (await $.env.get('CLAUDE_CODE_REMOTE')) !== 'true';
    if (isOn) {
      const [savedVolume, savedSpeed] = [
        await $.store.get('volume'),
        await $.store.get('speed'),
      ];
      if (typeof savedVolume === 'number')
        await update($, volume, () => savedVolume);
      const savedBeforeMute = await $.store.get('beforeMute');
      if (typeof savedBeforeMute === 'number' && savedBeforeMute > 0)
        beforeMute = savedBeforeMute;
      if (typeof savedSpeed === 'number')
        await update($, speed, () => savedSpeed);
      // Fetch the model now so the first reply isn't silent while it downloads.
      void $.process
        .run(
          [
            'uv',
            'run',
            '--quiet',
            '--script',
            `${$.plugin.root}/scripts/player.py`,
            '--setup',
          ],
          { timeoutMs: 600_000 },
        )
        .catch(() => {});
    }
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const done = await next(e);
    if (
      isOn &&
      options.enabled !== false &&
      !e.agentId &&
      e.reason === 'answer' &&
      e.answer.trim()
    ) {
      const list = await update($, replies, (list) =>
        [...list, e.answer].slice(-HISTORY),
      );
      await play($, list.length - 1, 0, !config.autoplay);
    }
    return done;
  });

  on('prompt.change', { origin: { kind: 'engine' } }, async ($, e, next) => {
    const now = await read($, playback);
    if (isOn && now && !now.paused && !now.done && e.text.trim()) {
      await update($, playback, () => ({ ...now, paused: true }));
      await steer($, { paused: true });
    }
    return next(e);
  });

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!config.underline) return next(e);
    const now = await read($, playback);
    if (!now?.sentence || now.done) return next(e);
    const span = locate(e.props.text, now.sentence);
    const part = span && takeOver(e.props.text, span);
    if (!span || !part) return next(e);
    const { Box, Markdown, Text } = $.ui.resolve(e);
    const runs: (Char & { lit: boolean })[] = [];
    for (const c of part.chars) {
      const lit = c.at >= span[0] && c.at < span[1];
      const prev = runs.at(-1);
      const same = (k: keyof Char) => !prev?.[k] === !c[k];
      if (
        prev &&
        prev.lit === lit &&
        (
          ['bold', 'italic', 'strikethrough', 'code', 'underline'] as const
        ).every(same)
      ) {
        prev.ch += c.ch;
      } else runs.push({ ...c, lit });
    }
    return (
      <Box flexDirection="row" columnGap={1}>
        {e.props.isFirstOfReply ? <Text>●</Text> : null}
        <Box flexDirection="column" rowGap={1}>
          {part.before ? <Markdown text={part.before} /> : null}
          <Text>
            {runs.map((r, n) => (
              <Text
                key={String(n)}
                bold={r.bold}
                italic={r.italic}
                strikethrough={r.strikethrough}
                underline={r.underline || r.lit}
                color={r.code ? 'permission' : undefined}
              >
                {r.ch}
              </Text>
            ))}
          </Text>
          {part.after ? <Markdown text={part.after} /> : null}
        </Box>
      </Box>
    );
  });

  // The bar's Client modules post { act } for a control, { hotkey } for a key, { seek } when a
  // drag ends.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { act?: unknown; hotkey?: unknown; seek?: unknown };
    const key =
      typeof data.act === 'string' ? data.act : KEYS[String(data.hotkey)];
    if (key) await act($, key);
    else if (typeof data.seek === 'number') await seek($, data.seek);
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, playback);
    if (!now || e.props.hasSurvey) return next(e);
    const ui = $.ui.resolve(e);
    const { Box, Button, Text } = ui;
    const [i, count, vol, rate] = [
      await read($, index),
      (await read($, replies)).length,
      await read($, volume),
      await read($, speed),
    ];
    // The seekbar takes what the controls leave (about 92 cells), so the bar stays on one line.
    const cells = Math.max(
      MIN_SEEK_CELLS,
      Math.min(MAX_SEEK_CELLS, e.props.bodyColumns - 92),
    );
    const isLoading = !now.dur && !now.done;
    const status =
      // a reply held by autoplay-off is neither loading nor queued until play is pressed
      (isLoading || now.waiting) && !now.paused
        ? now.waiting
          ? 'waiting for turn…'
          : 'loading voice…'
        : undefined;

    const left: Control[] = [
      { key: 'name', text: 'say-back', accent: true },
      { key: 'count', text: `${i + 1}/${count}`, dim: true },
      { key: 'prev', label: ' |◀ ' },
      { key: 'back', label: ' ◀◀ ' },
      { key: 'play', label: now.paused || now.done ? ' ▶ ' : ' ❚❚ ' },
      { key: 'fwd', label: ' ▶▶ ' },
      { key: 'next', label: ' ▶| ' },
    ];
    const right: Control[] = [
      { key: 'vol-', label: ' − ', dim: true },
      { key: 'vol', text: `vol ${Math.round(vol * 100)}%` },
      { key: 'vol+', label: ' + ', dim: true },
      { key: 'mute', label: vol === 0 ? ' unmute ' : ' mute ', dim: true },
      { key: 'spd-', label: ' − ', dim: true },
      { key: 'spd', text: `${rate.toFixed(1)}×` },
      { key: 'spd+', label: ' + ', dim: true },
      { key: 'close', label: ' ✕ ', dim: true },
    ];

    if (e.surface === 'terminal' || e.surface === 'desktop') {
      const { Client } = $.ui.resolve(e);
      const bar: Seek = {
        pos: now.pos,
        dur: now.dur,
        cells,
        ...(status && { status }),
      };
      return (
        <Box flexDirection="row" flexWrap="wrap">
          <Client key="left" module="./controls.tsx" props={left} />
          <Client key="seek" module="./seekbar.tsx" props={bar} />
          <Client key="right" module="./controls.tsx" props={right} />
        </Box>
      );
    }

    const head = headOf(now.pos, now.dur, cells);
    const press = (key: string) => void act($, key);
    return (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {controls(ui, left, press)}
        {status ? (
          <Text dimColor>{status}</Text>
        ) : (
          <Box flexDirection="row" columnGap={1}>
            <Text>{clock(now.pos)}</Text>
            <Box flexDirection="row">
              {Array.from({ length: cells }, (_, c) => (
                <Button
                  key={`seek${c}`}
                  plain
                  dimColor={c > head}
                  label={c === head ? '●' : c < head ? '━' : '─'}
                  onPress={() => seek($, (c / cells) * now.dur)}
                />
              ))}
            </Box>
            <Text>{clock(now.dur)}</Text>
          </Box>
        )}
        {controls(ui, right, press)}
      </Box>
    );
  });
};
