export type Playback = {
  pos: number;
  dur: number;
  paused: boolean;
  waiting?: boolean;
  done: boolean;
  sentence?: string;
};

export type Control = {
  key: string;
  label?: string;
  text?: string;
  dim?: boolean;
  accent?: boolean;
};

export type Seek = { pos: number; dur: number; cells: number; status?: string };

declare module 'claude-code' {
  interface PluginState {
    'say-back': {
      playback: Playback | null;
      replies: string[];
      index: number;
      volume: number;
      speed: number;
    };
  }
}
