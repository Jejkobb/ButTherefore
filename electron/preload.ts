import { contextBridge, ipcRenderer } from "electron";
import type { StoryBridge } from "../src/shared/ipc";
import type { StoryProjectFile } from "../src/shared/types";

const bridge: StoryBridge = {
  newProjectSession: () => ipcRenderer.invoke("project:new"),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveProject: (project: StoryProjectFile, projectPath: string | null) => ipcRenderer.invoke("project:save", project, projectPath),
  saveProjectAs: (project: StoryProjectFile) => ipcRenderer.invoke("project:saveAs", project),
  pickImageFiles: () => ipcRenderer.invoke("project:pickImages"),
  importAsset: (sourcePath: string) => ipcRenderer.invoke("project:importAsset", sourcePath),
  deleteAsset: (assetId: string, relativePath: string) => ipcRenderer.invoke("project:deleteAsset", assetId, relativePath),
  autosaveProject: (project: StoryProjectFile) => ipcRenderer.invoke("project:autosave", project)
};

contextBridge.exposeInMainWorld("storyBridge", bridge);
