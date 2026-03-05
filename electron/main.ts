import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { assertStoryProjectFile, type RuntimeStoryAsset, type StoryProjectFile } from "../src/shared/types";
import type { ProjectLoadResult, ProjectSaveResult } from "../src/shared/ipc";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const PROJECT_EXTENSION = ".storybeat.json";
const AUTOSAVE_ROOT = "autosave";
const SESSION_ASSETS_ROOT = "session-assets";

let mainWindow: BrowserWindow | null = null;
let currentProjectPath: string | null = null;
let workspaceAssetsDir = "";

function ensureProjectExtension(filePath: string): string {
  if (filePath.endsWith(PROJECT_EXTENSION)) return filePath;
  if (filePath.toLowerCase().endsWith(".json")) {
    return `${filePath.slice(0, -5)}${PROJECT_EXTENSION}`;
  }
  return `${filePath}${PROJECT_EXTENSION}`;
}

function projectAssetsDir(projectPath: string): string {
  const base = path.basename(projectPath, PROJECT_EXTENSION);
  return path.join(path.dirname(projectPath), `${base}.assets`);
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function resetDir(dirPath: string): Promise<void> {
  await fs.rm(dirPath, { recursive: true, force: true });
  await ensureDir(dirPath);
}

async function initializeWorkspace(): Promise<void> {
  const userData = app.getPath("userData");
  workspaceAssetsDir = path.join(userData, SESSION_ASSETS_ROOT);
  await resetDir(workspaceAssetsDir);
}

function runtimeAssetsForProject(project: StoryProjectFile, assetsDir: string): RuntimeStoryAsset[] {
  return project.assets.map((asset) => {
    const absolutePath = path.join(assetsDir, asset.relativePath);
    return {
      ...asset,
      absolutePath,
      uri: pathToFileURL(absolutePath).toString()
    };
  });
}

async function copyWorkspaceAssetsTo(targetAssetsDir: string, project: StoryProjectFile): Promise<void> {
  await ensureDir(targetAssetsDir);

  for (const asset of project.assets) {
    const sourcePath = path.join(workspaceAssetsDir, asset.relativePath);
    const targetPath = path.join(targetAssetsDir, asset.relativePath);
    await ensureDir(path.dirname(targetPath));
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function writeProjectToPath(project: StoryProjectFile, filePath: string): Promise<ProjectSaveResult> {
  const finalPath = ensureProjectExtension(filePath);
  const assetsDir = projectAssetsDir(finalPath);
  await copyWorkspaceAssetsTo(assetsDir, project);

  const nextProject: StoryProjectFile = {
    ...project,
    meta: {
      ...project.meta,
      updatedAt: new Date().toISOString()
    }
  };

  // Project format: JSON sidecar file + sibling ".assets" directory.
  // JSON stores typed graph metadata, while imported images are kept on disk and referenced by relativePath.
  await fs.writeFile(finalPath, JSON.stringify(nextProject, null, 2), "utf-8");

  currentProjectPath = finalPath;
  workspaceAssetsDir = assetsDir;

  return {
    projectPath: finalPath,
    savedAt: nextProject.meta.updatedAt
  };
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0b0f17",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_SERVER_URL) {
    await mainWindow.loadURL(DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  }
}

function registerIpc(): void {
  ipcMain.handle("project:new", async () => {
    currentProjectPath = null;
    const userData = app.getPath("userData");
    workspaceAssetsDir = path.join(userData, SESSION_ASSETS_ROOT);
    await resetDir(workspaceAssetsDir);
  });

  ipcMain.handle("project:importAsset", async (_event, sourcePath: string): Promise<RuntimeStoryAsset> => {
    await ensureDir(workspaceAssetsDir);

    const ext = path.extname(sourcePath);
    const relativePath = `${randomUUID()}${ext}`;
    const targetPath = path.join(workspaceAssetsDir, relativePath);

    await fs.copyFile(sourcePath, targetPath);

    return {
      id: randomUUID(),
      fileName: path.basename(sourcePath),
      relativePath,
      mimeType: detectMimeType(sourcePath),
      absolutePath: targetPath,
      uri: pathToFileURL(targetPath).toString()
    };
  });

  ipcMain.handle("project:open", async (): Promise<ProjectLoadResult | null> => {
    const selected = await dialog.showOpenDialog({
      title: "Open Story Project",
      filters: [{ name: "Story Projects", extensions: ["json"] }],
      properties: ["openFile"]
    });

    if (selected.canceled || selected.filePaths.length === 0) {
      return null;
    }

    const projectPath = selected.filePaths[0];
    const raw = await fs.readFile(projectPath, "utf-8");
    const parsed = assertStoryProjectFile(JSON.parse(raw));

    currentProjectPath = projectPath;
    workspaceAssetsDir = projectAssetsDir(projectPath);
    await ensureDir(workspaceAssetsDir);

    return {
      projectPath,
      project: parsed,
      assets: runtimeAssetsForProject(parsed, workspaceAssetsDir)
    };
  });

  ipcMain.handle("project:save", async (_event, project: StoryProjectFile, projectPath: string | null): Promise<ProjectSaveResult | null> => {
    const targetPath = projectPath ?? currentProjectPath;
    if (!targetPath) {
      const selected = await dialog.showSaveDialog({
        title: "Save Story Project",
        defaultPath: path.join(app.getPath("documents"), `story-project${PROJECT_EXTENSION}`),
        filters: [{ name: "Story Projects", extensions: ["json"] }]
      });

      if (selected.canceled || !selected.filePath) {
        return null;
      }

      return writeProjectToPath(project, selected.filePath);
    }

    return writeProjectToPath(project, targetPath);
  });

  ipcMain.handle("project:saveAs", async (_event, project: StoryProjectFile): Promise<ProjectSaveResult | null> => {
    const selected = await dialog.showSaveDialog({
      title: "Save Story Project As",
      defaultPath: path.join(app.getPath("documents"), `story-project${PROJECT_EXTENSION}`),
      filters: [{ name: "Story Projects", extensions: ["json"] }]
    });

    if (selected.canceled || !selected.filePath) {
      return null;
    }

    return writeProjectToPath(project, selected.filePath);
  });

  ipcMain.handle("project:autosave", async (_event, project: StoryProjectFile): Promise<void> => {
    const root = path.join(app.getPath("userData"), AUTOSAVE_ROOT);
    const autosaveAssetsDir = path.join(root, "assets");
    await ensureDir(root);
    await ensureDir(autosaveAssetsDir);

    for (const asset of project.assets) {
      const sourcePath = path.join(workspaceAssetsDir, asset.relativePath);
      const targetPath = path.join(autosaveAssetsDir, asset.relativePath);
      await ensureDir(path.dirname(targetPath));
      await fs.copyFile(sourcePath, targetPath);
    }

    const autosaveProject: StoryProjectFile = {
      ...project,
      meta: {
        ...project.meta,
        updatedAt: new Date().toISOString()
      }
    };

    await fs.writeFile(path.join(root, "autosave.storybeat.json"), JSON.stringify(autosaveProject, null, 2), "utf-8");
  });
}

app.whenReady().then(async () => {
  await initializeWorkspace();
  registerIpc();
  await createWindow();

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception", error);
});
