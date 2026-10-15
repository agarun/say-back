export type Playback = { pos: number; dur: number; paused: boolean; done: boolean };

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
