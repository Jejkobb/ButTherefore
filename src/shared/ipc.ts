import type { RuntimeStoryAsset, StoryProjectFile } from "./types";

export interface ProjectLoadResult {
  projectPath: string;
  project: StoryProjectFile;
  assets: RuntimeStoryAsset[];
}

export interface ProjectSaveResult {
  projectPath: string;
  savedAt: string;
}

export interface StoryBridge {
  newProjectSession: () => Promise<void>;
  openProject: () => Promise<ProjectLoadResult | null>;
  saveProject: (project: StoryProjectFile, projectPath: string | null) => Promise<ProjectSaveResult | null>;
  saveProjectAs: (project: StoryProjectFile) => Promise<ProjectSaveResult | null>;
  pickImageFiles: () => Promise<string[]>;
  importAsset: (sourcePath: string) => Promise<RuntimeStoryAsset>;
  deleteAsset: (assetId: string, relativePath: string) => Promise<void>;
  autosaveProject: (project: StoryProjectFile) => Promise<void>;
}
