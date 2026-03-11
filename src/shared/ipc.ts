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

export interface RecentProjectEntry {
  path: string;
  name: string;
  lastOpenedAt: string;
}

export type UpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloaded"
  | "error";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  latestVersion: string | null;
  message: string | null;
}

export interface StartupData {
  appName: string;
  version: string;
  launchProjectPath: string | null;
  recentProjects: RecentProjectEntry[];
  update: UpdateState;
}

export interface StoryBridge {
  newProjectSession: () => Promise<void>;
  openProject: () => Promise<ProjectLoadResult | null>;
  openProjectAtPath: (projectPath: string) => Promise<ProjectLoadResult | null>;
  saveProject: (project: StoryProjectFile, projectPath: string | null) => Promise<ProjectSaveResult | null>;
  saveProjectAs: (project: StoryProjectFile) => Promise<ProjectSaveResult | null>;
  pickImageFiles: () => Promise<string[]>;
  importAsset: (sourcePath: string) => Promise<RuntimeStoryAsset>;
  importDataAsset: (dataUrl: string, fileName: string) => Promise<RuntimeStoryAsset>;
  deleteAsset: (assetId: string, relativePath: string) => Promise<void>;
  autosaveProject: (project: StoryProjectFile) => Promise<void>;
  getStartupData: () => Promise<StartupData>;
  checkForUpdates: () => Promise<UpdateState>;
  installUpdate: () => Promise<boolean>;
}
