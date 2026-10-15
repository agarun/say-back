# Say-back

A Claude Code plugin that reads each of Claude's replies aloud using [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), a small, natural-sounding voice model that runs on-device.

This is meant to be paired with Claude Code's built-in `/voice` dictation for a hands-free loop where you can speak your prompt with spacebar and hear the answer.

```
say-back 2/3  |◀   ◀◀   ❚❚   ▶▶   ▶|  0:04 ━━━━━━━━━●────────────── 0:11  −  vol 90%  +   −  1.1×  +   ✕
```

## Install

Requires [uv](https://docs.astral.sh/uv/getting-started/installation/). In a Claude Code session:

```
/plugin install say-back --marketplace agarun/say-back
```

Or from a shell: `claude plugin install say-back --marketplace agarun/say-back`.

The first session downloads the model (about 120 MB) in the background.

## The player

When Claude finishes a reply, a player bar appears above the prompt and speech starts in about two seconds. Click a control, or press ctrl+x then Tab to focus the bar, move with the arrow keys, and press Enter.

| Control    | Does                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| \|◀ ▶\|    | Previous and next reply (the last 20 are kept). \|◀ restarts the current reply when you're more than 3 seconds in |
| ◀◀ ▶▶      | Back and forward 10 seconds                                                                                       |
| ❚❚ ▶       | Pause and resume, or replay a finished reply                                                                      |
| seekbar    | Click a spot to jump there (it can't be dragged)                                                                  |
| vol, speed | `−` and `+`, remembered across sessions                                                                           |
| ✕          | Stop and hide the bar until the next reply                                                                        |

New replies interrupt previous ones. Markdown is stripped and code blocks are skipped.

## Settings

Change these in `/config`, or with `/plugin configure say-back`:

| Option         | Default    |                                                                                                                                                                                                       |
| -------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speak replies  | on         | Mute without disabling the plugin                                                                                                                                                                     |
| Voice          | `af_heart` | Any [Kokoro voice](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md). The first letter sets the accent (`a` US, `b` UK, `e` Spanish, `f` French, `h` Hindi, `i` Italian, `p` Portuguese) |
| Max characters | `1500`     | Long replies stop at the last full sentence before this; `0` reads everything                                                                                                                         |

## Platforms

macOS and Windows should work out of the box.

On Linux, install PortAudio (`sudo apt install libportaudio2`).

On WSL2, it plays through WSLg. If you hear nothing, run `wsl --shutdown` from Windows and reopen your terminal.

Say-back stays silent in `claude -p`, SDK, and cloud sessions. The model is cached in `~/.cache/say-back` (`%LOCALAPPDATA%\say-back` on Windows).

## Develop

```sh
claude plugin validate --strict .
claude --plugin-dir .
```

Edits reload when you save. The player bar is a [mod](https://code.claude.com/docs/en/plugins/mods/overview) in `hooks/say-back.tsx`, and `scripts/player.py` does the speaking.

## License

MIT
