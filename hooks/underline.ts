export function locate(block: string, sentence: string): [number, number] | null {
  const keep = (c: string) => /[\p{L}\p{N}]/u.test(c);
  const needle = [...sentence].filter(keep).join("").toLowerCase();
  if (needle.length < 8) return null;
  const said = block.replace(/\]\([^)]*\)/g, (m) => " ".repeat(m.length));
  let hay = "";
  const at: number[] = [];
  for (let k = 0; k < said.length; k++) {
    if (keep(said[k]!)) {
      hay += said[k]!.toLowerCase();
      at.push(k);
    }
  }
  const found = hay.indexOf(needle);
  if (found < 0) return null;
  return [at[found]!, at[found + needle.length - 1]! + 1];
}

type Style = {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
};
export type Char = Style & { underline?: boolean; ch: string; at: number };

function inline(s: string, base: number, style: Style = {}): Char[] | null {
  if (/!\[|\*\*\*|___|<\/?[a-z][^>]*>|&#?\w+;/i.test(s)) return null;
  const out: Char[] = [];
  const put = (text: string, at: number, extra: Style = {}) =>
    [...text].forEach((ch) =>
      out.push({ ...style, ...extra, ch, at: (at += ch.length) - ch.length }),
    );
  for (let k = 0; k < s.length; ) {
    const rest = s.slice(k);
    const wordy = (n: number) => /\w/.test(s[n] ?? "");
    let m: RegExpExecArray | null;
    if ((m = /^\\([!-/:-@[-`{-~])/.exec(rest))) put(m[1]!, base + k + 1);
    else if ((m = /^(`+)(?!`)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
      const pad = /^ .*[^ ].* $/s.test(m[2]!) ? 1 : 0;
      put(m[2]!.slice(pad, m[2]!.length - pad), base + k + m[1]!.length + pad, {
        code: true,
      });
    } else if ((m = /^\[([^\]]+)\]\([^)\s]+(?: "[^"]*")?\)/.exec(rest))) {
      const label = inline(m[1]!, base + k + 1, style);
      if (!label) return null;
      out.push(...label);
    } else if ((m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) put(m[1]!, base + k + 1);
    else if (
      (m = /^(\*\*|__|~~|\*|_)(?=[^\s*_~])([\s\S]*?[^\s\\])\1(?![*_~])/.exec(rest)) &&
      !(m[1]!.startsWith("_") && (wordy(k - 1) || wordy(k + m[0].length)))
    ) {
      const mark = m[1]!;
      const which = mark === "~~" ? "strikethrough" : mark.length === 2 ? "bold" : "italic";
      const inner = inline(m[2]!, base + k + mark.length, {
        ...style,
        [which]: true,
      });
      if (!inner) return null;
      out.push(...inner);
    } else {
      put(s[k]!, base + k);
      k++;
      continue;
    }
    k += m[0].length;
  }
  return out;
}

export function takeOver(block: string, span: [number, number]) {
  if (/^ {0,3}\[[^\]]+\]:\s/m.test(block)) return null;
  let fenced = false;
  let start = -1;
  let paragraph: { at: number; line: string }[] = [];
  for (const m of block.matchAll(/^.*$/gm)) {
    const isFence = /^\s*(```|~~~)/.test(m[0]);
    if (isFence) fenced = !fenced;
    if (isFence || fenced || !m[0].trim()) {
      if (start >= 0) break;
      paragraph = [];
      continue;
    }
    paragraph.push({ at: m.index, line: m[0] });
    if (m.index <= span[0] && span[0] <= m.index + m[0].length) start = paragraph[0]!.at;
  }
  const last = paragraph.at(-1);
  if (start < 0 || !last || span[1] > last.at + last.line.length) return null;
  const end = last.at + last.line.length;
  const after = block.slice(end).replace(/^\s*\n/, "");
  if (/^\s/.test(after)) return null;

  const chars: Char[] = [];
  let indent = "";
  let number = -1;
  for (const [n, { at, line }] of paragraph.entries()) {
    if (/^(\s|>|\||<|[-*_= ]+$)/.test(line) || /^[\s|:-]*\|[\s|:-]*-/.test(line)) {
      return null;
    }
    const heading = /^(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(line);
    const item = /^([-*+]|(\d{1,9})[.)])\s+/.exec(line);
    let parsed: Char[] | null;
    if (heading) {
      const h1 = heading[1]!.length === 1;
      parsed = inline(heading[2]!, at + line.indexOf(heading[2]!, heading[1]!.length), {
        bold: true,
        italic: h1,
      });
      parsed?.forEach((c) => (c.underline ||= h1));
      if (parsed && n < paragraph.length - 1) parsed.push({ ch: "\n", at: -1 });
      indent = "";
    } else if (item) {
      if (item[2] !== undefined) number = number < 0 ? Number(item[2]) : number + 1;
      const marker = item[2] === undefined ? "-" : `${number}.`;
      indent = " ".repeat(marker.length + 1);
      parsed = inline(line.slice(item[0].length), at + item[0].length);
      parsed?.unshift(...[...`${marker} `].map((ch) => ({ ch, at: -1 })));
    } else {
      parsed = inline(line, at);
      parsed?.unshift(...[...indent].map((ch) => ({ ch, at: -1 })));
    }
    if (!parsed) return null;
    if (n) chars.push({ ch: "\n", at: -1 });
    chars.push(...parsed);
  }
  return {
    before: block.slice(0, start).trimEnd(),
    chars,
    after: after.trimEnd(),
  };
}
