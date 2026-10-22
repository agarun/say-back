import type { ClientModule } from "claude-code";

import type { Seek } from "../types";

export const clock = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const headOf = (pos: number, dur: number, cells: number) =>
  dur ? Math.min(cells - 1, Math.floor((pos / dur) * cells)) : 0;

// The seekbar with its two clocks. Pressing on the bar grabs the head and dragging moves it
// (the clock follows); letting go seeks there, one message per drag.
const Seekbar: ClientModule<Seek, { at: number | null }> = (p, surface) => {
  const { Box, Text } = surface.elements;
  // A cell of margin each side, so the bar's Clients sit edge to edge with no selectable gap.
  if (p.status) {
    return (
      <Box paddingX={1}>
        <Text dimColor>{p.status}</Text>
      </Box>
    );
  }

  const at = surface.state?.at ?? null;
  const head = at ?? headOf(p.pos, p.dur, p.cells);
  const shown = at === null ? p.pos : (at / p.cells) * p.dur;
  const offset = 1 + clock(shown).length + 1; // the margin, the left clock and the gap after it
  const cell = (x: number) => Math.max(0, Math.min(p.cells - 1, x - offset));

  // Set on every draw (a later call replaces the listener) so it reads the current props.
  surface.onPointer((ev) => {
    if (ev.type === "down" && ev.button === "left") {
      if (ev.x >= offset && ev.x < offset + p.cells) surface.setState({ at: cell(ev.x) });
    } else if (at === null) {
      return;
    } else if (ev.type === "move" && ev.button) {
      if (cell(ev.x) !== at) surface.setState({ at: cell(ev.x) });
    } else if (ev.type === "up") {
      surface.post({ seek: (cell(ev.x) / p.cells) * p.dur });
      surface.setState({ at: null });
    }
  });

  return (
    <Box flexDirection="row" columnGap={1} paddingX={1}>
      <Text>{clock(shown)}</Text>
      <Text>
        {"━".repeat(head)}
        <Text bold={at !== null}>●</Text>
        <Text dimColor>{"─".repeat(p.cells - head - 1)}</Text>
      </Text>
      <Text>{clock(p.dur)}</Text>
    </Box>
  );
};

export default Seekbar;
