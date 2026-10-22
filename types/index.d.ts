export type Playback = {
  pos: number;
  dur: number;
  paused: boolean;
  waiting?: boolean;
  done: boolean;
  sentence?: string;
};

// One item of a control row: a Button (or a clickable run of text) when it has a label, else a Text.
export type Control = {
  key: string;
  label?: string;
  text?: string;
  dim?: boolean;
  accent?: boolean;
};

// The seekbar module's props: where playback is, how many cells, or a status shown instead.
export type Seek = { pos: number; dur: number; cells: number; status?: string };

declare module "claude-code" {
  interface PluginState {
    "say-back": {
      playback: Playback | null;
      replies: string[];
      index: number;
      volume: number;
      speed: number;
    };
  }
}
