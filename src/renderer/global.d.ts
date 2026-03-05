import type { StoryBridge } from "../shared/ipc";

declare global {
  interface Window {
    storyBridge: StoryBridge;
  }
}

export {};
