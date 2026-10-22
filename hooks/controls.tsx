import type { ClientElements, ClientModule } from 'claude-code';

import type { Control } from '../types';

const Controls: ClientModule<Control[]> = (items, surface) => {
  const { Box, Text } = surface.elements;
  const zones: { key: string; from: number; to: number }[] = [];
  let x = 0;
  const parts = items.map((c, n) => {
    const part = `${n > 0 ? ' ' : ''}${c.label ?? c.text ?? ''}`;
    if (c.label !== undefined)
      zones.push({ key: c.key, from: x, to: x + [...part].length });
    x += [...part].length;
    return part;
  });

  // Set on every draw, so the listener reads this render's columns.
  surface.onPointer((ev) => {
    if (ev.type !== 'down' || ev.button !== 'left') return;
    const hit = zones.find((z) => ev.x >= z.from && ev.x < z.to);
    if (hit) surface.post({ act: hit.key });
  });
  // A click on the row gives it the keyboard until Escape, and the keys reach the hooks module.
  surface.onKey((ev) => {
    if (!ev.ctrl && !ev.meta) surface.post({ hotkey: ev.key });
  });

  return (
    <Box flexDirection="row">
      {items.map((c, n) => (
        <Text
          key={c.key}
          color={c.accent ? 'cyan' : undefined}
          dimColor={c.dim}
          // over exactly the columns a press hits
          hover={
            c.label === undefined
              ? undefined
              : { scope: `say-back-${c.key}`, inverse: true }
          }
        >
          {parts[n]}
        </Text>
      ))}
    </Box>
  );
};

export default Controls;

export function controls(
  { Box, Button, Text }: Pick<ClientElements, 'Box' | 'Button' | 'Text'>,
  items: Control[],
  act: (key: string) => void,
) {
  return (
    <Box flexDirection="row" columnGap={1}>
      {items.map((c) =>
        c.label === undefined ? (
          <Text
            key={c.key}
            color={c.accent ? 'cyan' : undefined}
            dimColor={c.dim}
          >
            {c.text}
          </Text>
        ) : (
          <Button
            key={c.key}
            plain
            dimColor={c.dim}
            label={c.label}
            onPress={() => act(c.key)}
          />
        ),
      )}
    </Box>
  );
}
