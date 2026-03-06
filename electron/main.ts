import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { assertStoryProjectFile, type RuntimeStoryAsset, type StoryProjectFile } from "../src/shared/types";
import type { ProjectLoadResult, ProjectSaveResult } from "../src/shared/ipc";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const PROJECT_EXTENSION = ".storybeat.json";
const AUTOSAVE_ROOT = "autosave";
const SESSION_ASSETS_ROOT = "session-assets";
const ASSET_SCHEME = "story-asset";
const ASSET_HOST = "asset";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let mainWindow: BrowserWindow | null = null;
let currentProjectPath: string | null = null;
let workspaceAssetsDir = "";
const assetPathIndex = new Map<string, string>();

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
]);

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

function resolveWorkspaceAssetPath(relativePath: string): string {
  const root = path.resolve(workspaceAssetsDir);
  const target = path.resolve(root, relativePath);

  if (!target.startsWith(root + path.sep)) {
    throw new Error("Invalid asset path.");
  }

  return target;
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
  assetPathIndex.clear();
}

function buildAssetUri(assetId: string): string {
  return `${ASSET_SCHEME}://${ASSET_HOST}/${encodeURIComponent(assetId)}`;
}

function runtimeAssetsForProject(project: StoryProjectFile, assetsDir: string): RuntimeStoryAsset[] {
  assetPathIndex.clear();

  return project.assets.map((asset) => {
    const absolutePath = path.join(assetsDir, asset.relativePath);
    assetPathIndex.set(asset.id, absolutePath);

    return {
      ...asset,
      absolutePath,
      uri: buildAssetUri(asset.id)
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
  for (const asset of project.assets) {
    assetPathIndex.set(asset.id, path.join(assetsDir, asset.relativePath));
  }

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
      webSecurity: true,
      spellcheck: false
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

function registerAutoUpdates(): void {
  if (!app.isPackaged) {
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (error) => {
    console.error("Auto-update error", error);
  });

  autoUpdater.on("update-available", (info) => {
    console.info(`Update available: ${info.version}`);
  });

  autoUpdater.on("update-not-available", () => {
    console.info("No updates available.");
  });

  autoUpdater.on("update-downloaded", async (info) => {
    console.info(`Update downloaded: ${info.version}`);

    if (!mainWindow) {
      autoUpdater.quitAndInstall();
      return;
    }

    const decision = await dialog.showMessageBox(mainWindow, {
      type: "info",
      title: "Update ready",
      message: `Version ${info.version} has been downloaded.`,
      detail: "Restart now to install the update.",
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1
    });

    if (decision.response === 0) {
      setImmediate(() => {
        autoUpdater.quitAndInstall();
      });
    }
  });

  const checkForUpdates = (): void => {
    void autoUpdater.checkForUpdates().catch((error) => {
      console.error("Failed to check for updates", error);
    });
  };

  checkForUpdates();
  const interval = setInterval(checkForUpdates, UPDATE_CHECK_INTERVAL_MS);
  interval.unref();
}

function registerIpc(): void {
  ipcMain.handle("project:new", async () => {
    currentProjectPath = null;
    const userData = app.getPath("userData");
    workspaceAssetsDir = path.join(userData, SESSION_ASSETS_ROOT);
    await resetDir(workspaceAssetsDir);
    assetPathIndex.clear();
  });

  ipcMain.handle("project:importAsset", async (_event, sourcePath: string): Promise<RuntimeStoryAsset> => {
    await ensureDir(workspaceAssetsDir);

    const ext = path.extname(sourcePath);
    const relativePath = `${randomUUID()}${ext}`;
    const targetPath = path.join(workspaceAssetsDir, relativePath);

    await fs.copyFile(sourcePath, targetPath);

    const assetId = randomUUID();
    assetPathIndex.set(assetId, targetPath);

    return {
      id: assetId,
      fileName: path.basename(sourcePath),
      relativePath,
      mimeType: detectMimeType(sourcePath),
      absolutePath: targetPath,
      uri: buildAssetUri(assetId)
    };
  });

  ipcMain.handle("project:deleteAsset", async (_event, assetId: string, relativePath: string): Promise<void> => {
    const targetPath = resolveWorkspaceAssetPath(relativePath);
    assetPathIndex.delete(assetId);
    await fs.rm(targetPath, { force: true });
  });

  ipcMain.handle("project:pickImages", async (): Promise<string[]> => {
    const selected = await dialog.showOpenDialog({
      title: "Attach Images",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Images",
          extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"]
        }
      ]
    });

    if (selected.canceled) return [];
    return selected.filePaths;
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
  Menu.setApplicationMenu(null);

  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url);
    const assetId = decodeURIComponent(url.pathname.replace(/^\//, ""));
    const assetPath = assetPathIndex.get(assetId);

    if (!assetPath) {
      return new Response("Asset not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(assetPath).toString());
  });

  await initializeWorkspace();
  registerIpc();
  await createWindow();
  registerAutoUpdates();

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
