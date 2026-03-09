import { contextBridge, ipcRenderer } from "electron";
import type { StoryBridge } from "../src/shared/ipc";
import type { StoryProjectFile } from "../src/shared/types";

const bridge: StoryBridge = {
  newProjectSession: () => ipcRenderer.invoke("project:new"),
  openProject: () => ipcRenderer.invoke("project:open"),
  openProjectAtPath: (projectPath: string) => ipcRenderer.invoke("project:openAtPath", projectPath),
  saveProject: (project: StoryProjectFile, projectPath: string | null) => ipcRenderer.invoke("project:save", project, projectPath),
  saveProjectAs: (project: StoryProjectFile) => ipcRenderer.invoke("project:saveAs", project),
  pickImageFiles: () => ipcRenderer.invoke("project:pickImages"),
  importAsset: (sourcePath: string) => ipcRenderer.invoke("project:importAsset", sourcePath),
  deleteAsset: (assetId: string, relativePath: string) => ipcRenderer.invoke("project:deleteAsset", assetId, relativePath),
  autosaveProject: (project: StoryProjectFile) => ipcRenderer.invoke("project:autosave", project),
  getStartupData: () => ipcRenderer.invoke("app:getStartupData"),
  checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
  installUpdate: () => ipcRenderer.invoke("app:installUpdate")
};

contextBridge.exposeInMainWorld("storyBridge", bridge);
