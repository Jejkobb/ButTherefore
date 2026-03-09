import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { assertStoryProjectFile, type RuntimeStoryAsset, type StoryProjectFile } from "../src/shared/types";
import type {
  ProjectLoadResult,
  ProjectSaveResult,
  RecentProjectEntry,
  StartupData,
  UpdateState
} from "../src/shared/ipc";

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const PROJECT_EXTENSION = ".storybeat.json";
const AUTOSAVE_ROOT = "autosave";
const SESSION_ASSETS_ROOT = "session-assets";
const ASSET_SCHEME = "story-asset";
const ASSET_HOST = "asset";
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RECENT_PROJECTS_FILE = "recent-projects.json";
const MAX_RECENT_PROJECTS = 12;
const APP_USER_MODEL_ID = "com.jejkobb.buttherefore";

let mainWindow: BrowserWindow | null = null;
let currentProjectPath: string | null = null;
let workspaceAssetsDir = "";
const assetPathIndex = new Map<string, string>();
let recentProjects: RecentProjectEntry[] = [];
let updateState: UpdateState = {
  status: app.isPackaged ? "idle" : "unsupported",
  currentVersion: app.getVersion(),
  latestVersion: null,
  message: app.isPackaged ? null : "Updates are available in packaged builds."
};

interface PersistedRecentProjects {
  projects: RecentProjectEntry[];
}

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

function recentProjectsPath(): string {
  return path.join(app.getPath("userData"), RECENT_PROJECTS_FILE);
}

function sanitizeRecentProjects(value: unknown): RecentProjectEntry[] {
  if (!value || typeof value !== "object") return [];
  const projects = (value as PersistedRecentProjects).projects;
  if (!Array.isArray(projects)) return [];

  const deduped = new Map<string, RecentProjectEntry>();
  for (const entry of projects) {
    if (!entry || typeof entry !== "object") continue;
    const projectPath = typeof entry.path === "string" ? entry.path.trim() : "";
    const projectName = typeof entry.name === "string" ? entry.name.trim() : "";
    const lastOpenedAt = typeof entry.lastOpenedAt === "string" ? entry.lastOpenedAt.trim() : "";
    if (!projectPath || !projectName || !lastOpenedAt) continue;

    const normalizedPath = path.resolve(projectPath);
    deduped.set(normalizedPath, {
      path: normalizedPath,
      name: projectName,
      lastOpenedAt
    });
  }

  return [...deduped.values()]
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt))
    .slice(0, MAX_RECENT_PROJECTS);
}

async function loadRecentProjects(): Promise<void> {
  try {
    const raw = await fs.readFile(recentProjectsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    recentProjects = sanitizeRecentProjects(parsed);
  } catch {
    recentProjects = [];
  }
}

async function saveRecentProjects(): Promise<void> {
  const payload: PersistedRecentProjects = { projects: recentProjects };
  await fs.writeFile(recentProjectsPath(), JSON.stringify(payload, null, 2), "utf-8");
}

async function rememberRecentProject(projectPath: string, projectName: string): Promise<void> {
  const normalizedPath = path.resolve(projectPath);
  const now = new Date().toISOString();

  recentProjects = [
    {
      path: normalizedPath,
      name: projectName,
      lastOpenedAt: now
    },
    ...recentProjects.filter((entry) => entry.path !== normalizedPath)
  ].slice(0, MAX_RECENT_PROJECTS);

  try {
    await saveRecentProjects();
  } catch (error) {
    console.error("Failed to persist recent projects", error);
  }
}

async function existingRecentProjects(): Promise<RecentProjectEntry[]> {
  const visible: RecentProjectEntry[] = [];
  let changed = false;

  for (const entry of recentProjects) {
    try {
      await fs.access(entry.path);
      visible.push(entry);
    } catch {
      changed = true;
    }
  }

  if (changed) {
    recentProjects = visible;
    try {
      await saveRecentProjects();
    } catch (error) {
      console.error("Failed to prune recent projects", error);
    }
  }

  return visible;
}

function currentUpdateState(): UpdateState {
  return { ...updateState };
}

function setUpdateState(next: Partial<UpdateState>): UpdateState {
  updateState = {
    ...updateState,
    ...next,
    currentVersion: app.getVersion()
  };
  return currentUpdateState();
}

function updateErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function mapUpdaterError(error: unknown): { status: UpdateState["status"]; message: string } {
  const raw = updateErrorText(error);
  const normalized = raw.toLowerCase();
  const feedUnavailable = normalized.includes("releases.atom") && normalized.includes("404");

  if (feedUnavailable) {
    return {
      status: "not-available",
      message:
        "Update feed was not found on GitHub (releases.atom returned 404). Publish a Release first, or make sure the release repo is publicly accessible."
    };
  }

  return {
    status: "error",
    message: raw || "Failed to check for updates."
  };
}

function appIconPath(): string {
  return path.join(app.getAppPath(), "icons", "icon.png");
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

async function listRelativeFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(rootDir, absolutePath));
      }
    }
  };

  try {
    await walk(rootDir);
  } catch (error) {
    const candidate = error as NodeJS.ErrnoException;
    if (candidate.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return files;
}

async function syncWorkspaceAssetsTo(targetAssetsDir: string, project: StoryProjectFile): Promise<void> {
  await ensureDir(targetAssetsDir);
  const expected = new Set(project.assets.map((asset) => path.normalize(asset.relativePath)));

  for (const asset of project.assets) {
    const sourcePath = path.join(workspaceAssetsDir, asset.relativePath);
    const targetPath = path.join(targetAssetsDir, asset.relativePath);
    await ensureDir(path.dirname(targetPath));
    if (path.resolve(sourcePath) !== path.resolve(targetPath)) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }

  const existingFiles = await listRelativeFiles(targetAssetsDir);
  for (const relativePath of existingFiles) {
    if (expected.has(path.normalize(relativePath))) continue;
    await fs.rm(path.join(targetAssetsDir, relativePath), { force: true });
  }
}

async function loadProjectFromPath(projectPath: string): Promise<ProjectLoadResult> {
  const raw = await fs.readFile(projectPath, "utf-8");
  const parsed = assertStoryProjectFile(JSON.parse(raw));

  currentProjectPath = projectPath;
  workspaceAssetsDir = projectAssetsDir(projectPath);
  await ensureDir(workspaceAssetsDir);
  await rememberRecentProject(projectPath, parsed.meta.name);

  return {
    projectPath,
    project: parsed,
    assets: runtimeAssetsForProject(parsed, workspaceAssetsDir)
  };
}

async function writeProjectToPath(project: StoryProjectFile, filePath: string): Promise<ProjectSaveResult> {
  const finalPath = ensureProjectExtension(filePath);
  const assetsDir = projectAssetsDir(finalPath);
  await syncWorkspaceAssetsTo(assetsDir, project);

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
  await rememberRecentProject(finalPath, nextProject.meta.name);

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
    icon: appIconPath(),
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
    setUpdateState({
      status: "unsupported",
      latestVersion: null,
      message: "Updates are available in packaged builds."
    });
    return;
  }

  setUpdateState({
    status: "idle",
    latestVersion: null,
    message: null
  });

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateState({
      status: "checking",
      message: null
    });
  });

  autoUpdater.on("error", (error) => {
    console.error("Auto-update error", error);
    const mapped = mapUpdaterError(error);
    setUpdateState({
      status: mapped.status,
      message: mapped.message
    });
  });

  autoUpdater.on("update-available", (info) => {
    console.info(`Update available: ${info.version}`);
    setUpdateState({
      status: "available",
      latestVersion: info.version,
      message: `Downloading version ${info.version}.`
    });
  });

  autoUpdater.on("update-not-available", () => {
    console.info("No updates available.");
    setUpdateState({
      status: "not-available",
      latestVersion: null,
      message: "You're on the latest version."
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    console.info(`Update downloaded: ${info.version}`);
    setUpdateState({
      status: "downloaded",
      latestVersion: info.version,
      message: `Version ${info.version} is ready to install.`
    });
  });

  const checkForUpdates = async (): Promise<void> => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      console.error("Failed to check for updates", error);
      const mapped = mapUpdaterError(error);
      setUpdateState({
        status: mapped.status,
        message: mapped.message
      });
    }
  };

  void checkForUpdates();
  const interval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  interval.unref();
}

async function checkForUpdatesOnDemand(): Promise<UpdateState> {
  if (!app.isPackaged) {
    return currentUpdateState();
  }

  setUpdateState({ status: "checking", message: null });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    console.error("Failed to check for updates", error);
    const mapped = mapUpdaterError(error);
    setUpdateState({
      status: mapped.status,
      message: mapped.message
    });
  }

  return currentUpdateState();
}

function installDownloadedUpdate(): boolean {
  if (!app.isPackaged || updateState.status !== "downloaded") {
    return false;
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall();
  });
  return true;
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

    return loadProjectFromPath(selected.filePaths[0]);
  });

  ipcMain.handle("project:openAtPath", async (_event, projectPath: string): Promise<ProjectLoadResult | null> => {
    try {
      return await loadProjectFromPath(projectPath);
    } catch (error) {
      console.error("Failed to open project", error);
      return null;
    }
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
    await syncWorkspaceAssetsTo(autosaveAssetsDir, project);

    const autosaveProject: StoryProjectFile = {
      ...project,
      meta: {
        ...project.meta,
        updatedAt: new Date().toISOString()
      }
    };

    await fs.writeFile(path.join(root, "autosave.storybeat.json"), JSON.stringify(autosaveProject, null, 2), "utf-8");
  });

  ipcMain.handle("app:getStartupData", async (): Promise<StartupData> => {
    return {
      appName: "ButTherefore",
      version: app.getVersion(),
      recentProjects: await existingRecentProjects(),
      update: currentUpdateState()
    };
  });

  ipcMain.handle("app:checkForUpdates", async (): Promise<UpdateState> => {
    return checkForUpdatesOnDemand();
  });

  ipcMain.handle("app:installUpdate", (): boolean => {
    return installDownloadedUpdate();
  });
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }

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
  await loadRecentProjects();
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
