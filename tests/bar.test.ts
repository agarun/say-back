import type { On } from 'claude-code';
import { type Engine, expect, mock, test } from 'claude-code/testing';

const BAR = {
  plugin: 'say-back',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 132, // 40 seek cells
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const;

async function clickControl(ui: any, client: string, n: number) {
  const texts = await ui.findAll({ type: 'Text', in: client });
  let x = 0;
  for (const t of texts.slice(0, n)) x += [...t.text].length;
  return ui.pointer({
    type: 'down',
    x: x + 1,
    y: 0,
    button: 'left',
    in: client,
  });
}

async function playing($: Engine, on: On, saved: Record<string, unknown> = {}) {
  mock.store(on, saved);
  mock.env(on, {});
  on('session.start', (_$, e) => ({ cwd: e.cwd }));
  on('turn.complete', () => ({ text: '', reason: 'answer' }));
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: '',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }));
  on('process.spawn', async function* (_$, e) {
    const start = Number(JSON.parse(e.input ?? '{}').start) || 5;
    const status = { pos: start, dur: 40, paused: false, done: false };
    yield { stream: 'stdout' as const, text: `${JSON.stringify(status)}\n` };
    return { value: { code: 0, signal: null } };
  });
  await $.session.start({ cwd: '/', surface: null, isInteractive: true });
  await $.turn.complete({
    answer: 'Parrots can live for decades.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  });
}

test("the bar's controls work through Clients, and dragging the seekbar seeks", async ($, on) => {
  await playing($, on);
  let rate = 1.1; // the speed is the session's, so it carries from one surface to the next
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface });
    expect(await ui.find({ type: 'Client', key: 'left' })).toBeDefined();

    await clickControl(ui, 'right', 6); // spd+ is the 7th control on the right
    expect(
      await ui.find({
        type: 'Text',
        text: `${(rate += 0.1).toFixed(1)}×`,
        in: 'right',
      }),
    ).toBeDefined();

    // " 0:05 " is 6 cells, so x 16 is cell 10 and x 26 is cell 20: a second a cell
    await ui.pointer({ type: 'down', x: 16, y: 0, button: 'left', in: 'seek' });
    await ui.pointer({ type: 'move', x: 26, y: 0, button: 'left', in: 'seek' });
    expect(
      await ui.find({ type: 'Text', text: '0:20', in: 'seek' }),
    ).toBeDefined();
    await ui.pointer({ type: 'up', x: 26, y: 0, button: 'left', in: 'seek' });
    await ui.redraw();
    expect(
      await ui.find({ type: 'Text', text: '0:20', in: 'seek' }),
    ).toBeDefined();
    await ui.key({ key: 'm', in: 'left' });
    expect(
      await ui.find({ type: 'Text', text: 'vol 0%', in: 'right' }),
    ).toBeDefined();
    await ui.key({ key: 'm', in: 'left' });
    expect(
      await ui.find({ type: 'Text', text: 'vol 100%', in: 'right' }),
    ).toBeDefined();

    await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: 'seek' }); // back to 0:00
    await ui.pointer({ type: 'up', x: 6, y: 0, button: 'left', in: 'seek' });
    await ui.unmount();
  }
});

test('a session starts at the volume the store holds', async ($, on) => {
  await playing($, on, { volume: 0 });
  const ui = await $.ui.mount({ ...BAR, surface: 'terminal' });
  expect(
    await ui.find({ type: 'Text', text: 'vol 0%', in: 'right' }),
  ).toBeDefined();
  await ui.unmount();
});

test('surfaces without Clients draw plain buttons that still work', async ($, on) => {
  await playing($, on);
  for (const surface of ['vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAR, surface });
    expect(await ui.find({ type: 'Client' })).toBeUndefined();
    await ui.press({ key: 'vol-' });
    expect(await ui.find({ type: 'Text', text: /vol \d+%/ })).toBeDefined();
    await ui.press({ key: 'seek20' });
    expect(await ui.find({ type: 'Text', text: '0:20' })).toBeDefined();
    await ui.press({ key: 'seek0' });
    await ui.unmount();
  }
});
