import type {
  ProjectLoadResult,
  ProjectSaveResult,
  StartupData,
  StoryBridge,
  UpdateState
} from "@/shared/ipc";
import { assertStoryProjectFile, type RuntimeStoryAsset, type StoryProjectFile } from "@/shared/types";

const WEB_BUNDLE_FORMAT = "buttherefore-web-bundle";
const WEB_BUNDLE_VERSION = 1;
const PROJECT_EXTENSION = ".buttherefore";
const DEFAULT_PROJECT_NAME = "story-project";
const AUTOSAVE_KEY = "buttherefore:web:autosave";

interface WebProjectBundle {
  format: typeof WEB_BUNDLE_FORMAT;
  version: number;
  project: StoryProjectFile;
  assetPayloads: Record<string, string>;
}

interface PickerFileHandle {
  name?: string;
  getFile?: () => Promise<File>;
  createWritable?: () => Promise<PickerWritable>;
}

interface PickerWritable {
  write: (data: BlobPart) => Promise<void>;
  close: () => Promise<void>;
}

interface WindowWithFilePickers extends Window {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<PickerFileHandle[]>;
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    excludeAcceptAllOption?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<PickerFileHandle>;
}

const selectedFilesByToken = new Map<string, File>();
const assetBlobsById = new Map<string, Blob>();
const assetUrisById = new Map<string, string>();
let currentProjectHandle: PickerFileHandle | null = null;

function randomId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot) : "";
}

function detectMimeType(fileName: string): string {
  const ext = fileExtension(fileName).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "application/octet-stream";
}

function extensionFromMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return ".png";
  if (normalized === "image/jpeg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/bmp") return ".bmp";
  return ".bin";
}

function sanitizeProjectName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_PROJECT_NAME;
  return trimmed
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function ensureProjectExtension(fileName: string): string {
  if (fileName.toLowerCase().endsWith(PROJECT_EXTENSION)) {
    return fileName;
  }
  return `${fileName}${PROJECT_EXTENSION}`;
}

function suggestProjectName(project: StoryProjectFile, fallbackPath: string | null): string {
  if (fallbackPath) {
    const lastSegment = fallbackPath.split(/[\\/]/).pop();
    if (lastSegment) {
      return ensureProjectExtension(lastSegment);
    }
  }

  return ensureProjectExtension(sanitizeProjectName(project.meta.name));
}

function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read file."));
    reader.readAsText(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = reader.result;
      if (typeof value === "string") {
        resolve(value);
        return;
      }
      reject(new Error("Unable to encode asset."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Unable to encode asset."));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/u.exec(dataUrl);
  if (!match) return null;

  const mimeType = match[1] || "application/octet-stream";
  const payload = match[3] || "";
  const decoded = match[2] ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return new Blob([bytes], { type: mimeType });
}

function storeSelectedFile(file: File): string {
  const token = `web-file:${randomId()}`;
  selectedFilesByToken.set(token, file);
  return token;
}

function revokeRuntimeAssets(): void {
  assetUrisById.forEach((uri) => {
    URL.revokeObjectURL(uri);
  });
  assetUrisById.clear();
  assetBlobsById.clear();
}

function clearSelectionState(): void {
  selectedFilesByToken.clear();
}

function readAssetPayloads(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};

  return Object.entries(raw as Record<string, unknown>).reduce<Record<string, string>>((acc, [assetId, payload]) => {
    if (typeof payload === "string") {
      acc[assetId] = payload;
    }
    return acc;
  }, {});
}

function createRuntimeAssets(project: StoryProjectFile, payloads: Record<string, string>): RuntimeStoryAsset[] {
  return project.assets.reduce<RuntimeStoryAsset[]>((acc, asset) => {
    const dataUrl = payloads[asset.id];
    if (!dataUrl) return acc;

    const blob = dataUrlToBlob(dataUrl);
    if (!blob) return acc;

    const uri = URL.createObjectURL(blob);
    assetBlobsById.set(asset.id, blob);
    assetUrisById.set(asset.id, uri);

    acc.push({
      ...asset,
      absolutePath: `web://assets/${asset.relativePath}`,
      uri
    });

    return acc;
  }, []);
}

function parseProjectPayload(raw: unknown): { project: StoryProjectFile; assetPayloads: Record<string, string> } {
  if (raw && typeof raw === "object") {
    const bundle = raw as Partial<WebProjectBundle> & { project?: unknown; assetPayloads?: unknown };

    if (
      bundle.format === WEB_BUNDLE_FORMAT &&
      typeof bundle.version === "number" &&
      bundle.version >= WEB_BUNDLE_VERSION &&
      bundle.project
    ) {
      return {
        project: assertStoryProjectFile(bundle.project),
        assetPayloads: readAssetPayloads(bundle.assetPayloads)
      };
    }

    if (bundle.project) {
      return {
        project: assertStoryProjectFile(bundle.project),
        assetPayloads: readAssetPayloads(bundle.assetPayloads)
      };
    }
  }

  return {
    project: assertStoryProjectFile(raw),
    assetPayloads: {}
  };
}

async function readPickedProjectFile(): Promise<{ file: File; fileName: string; handle: PickerFileHandle | null } | null> {
  const hostWindow = window as WindowWithFilePickers;

  if (typeof hostWindow.showOpenFilePicker === "function") {
    try {
      const handles = await hostWindow.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "ButTherefore Project",
            accept: {
              "application/json": [PROJECT_EXTENSION, ".json"]
            }
          }
        ]
      });

      const handle = handles[0];
      if (!handle?.getFile) return null;
      const file = await handle.getFile();
      return {
        file,
        fileName: handle.name || file.name,
        handle
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }

  const file = await pickFileWithInput(`${PROJECT_EXTENSION},.json,application/json`);
  if (!file) return null;
  return {
    file,
    fileName: file.name,
    handle: null
  };
}

function pickFileWithInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.style.display = "none";

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener(
      "change",
      () => {
        const file = input.files && input.files.length > 0 ? input.files[0] : null;
        cleanup();
        resolve(file);
      },
      { once: true }
    );

    document.body.appendChild(input);
    input.click();
  });
}

function pickFilesWithInput(accept: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = true;
    input.style.display = "none";

    const cleanup = () => {
      input.remove();
    };

    input.addEventListener(
      "change",
      () => {
        const files = input.files ? Array.from(input.files) : [];
        cleanup();
        resolve(files);
      },
      { once: true }
    );

    document.body.appendChild(input);
    input.click();
  });
}

function triggerBrowserDownload(contents: string, fileName: string): void {
  const blob = new Blob([contents], { type: "application/json" });
  const uri = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = uri;
  anchor.download = fileName;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(uri), 0);
}

async function writeProjectFile(
  project: StoryProjectFile,
  projectPath: string | null
): Promise<ProjectSaveResult | null> {
  const now = new Date().toISOString();
  const nextProject: StoryProjectFile = {
    ...project,
    meta: {
      ...project.meta,
      updatedAt: now
    }
  };

  const assetPayloads: Record<string, string> = {};

  for (const asset of nextProject.assets) {
    const blob = assetBlobsById.get(asset.id);
    if (!blob) continue;
    assetPayloads[asset.id] = await blobToDataUrl(blob);
  }

  const payload: WebProjectBundle = {
    format: WEB_BUNDLE_FORMAT,
    version: WEB_BUNDLE_VERSION,
    project: nextProject,
    assetPayloads
  };

  const contents = JSON.stringify(payload, null, 2);
  const suggestedName = suggestProjectName(nextProject, projectPath);
  const hostWindow = window as WindowWithFilePickers;

  if (typeof hostWindow.showSaveFilePicker === "function") {
    try {
      const handle = await hostWindow.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: "ButTherefore Project",
            accept: {
              "application/json": [PROJECT_EXTENSION]
            }
          }
        ]
      });

      if (!handle.createWritable) {
        throw new Error("Browser save API is not available.");
      }

      const writable = await handle.createWritable();
      await writable.write(contents);
      await writable.close();
      currentProjectHandle = handle;

      return {
        projectPath: handle.name || suggestedName,
        savedAt: now
      };
    } catch (error) {
      if (isAbortError(error)) return null;
      throw error;
    }
  }

  triggerBrowserDownload(contents, suggestedName);
  currentProjectHandle = null;

  return {
    projectPath: suggestedName,
    savedAt: now
  };
}

async function parsePickedProject(file: File): Promise<{ project: StoryProjectFile; assets: RuntimeStoryAsset[] }> {
  const text = await readAsText(file);
  const raw = JSON.parse(text) as unknown;
  const parsed = parseProjectPayload(raw);

  revokeRuntimeAssets();
  clearSelectionState();

  return {
    project: parsed.project,
    assets: createRuntimeAssets(parsed.project, parsed.assetPayloads)
  };
}

async function pickImageFiles(): Promise<string[]> {
  const hostWindow = window as WindowWithFilePickers;

  if (typeof hostWindow.showOpenFilePicker === "function") {
    try {
      const handles = await hostWindow.showOpenFilePicker({
        multiple: true,
        excludeAcceptAllOption: false,
        types: [
          {
            description: "Images",
            accept: {
              "image/*": [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]
            }
          }
        ]
      });

      const tokens: string[] = [];
      for (const handle of handles) {
        if (!handle.getFile) continue;
        const file = await handle.getFile();
        tokens.push(storeSelectedFile(file));
      }

      return tokens;
    } catch (error) {
      if (isAbortError(error)) return [];
      throw error;
    }
  }

  const files = await pickFilesWithInput("image/*");
  return files.map((file) => storeSelectedFile(file));
}

function startupData(update: UpdateState): StartupData {
  return {
    appName: "ButTherefore Demo",
    version: "web",
    launchProjectPath: null,
    recentProjects: [],
    update
  };
}

const unsupportedUpdate: UpdateState = {
  status: "unsupported",
  currentVersion: "web",
  latestVersion: null,
  message: "Updates are not available in the web demo."
};

export function createWebStoryBridge(): StoryBridge {
  return {
    newProjectSession: async () => {
      currentProjectHandle = null;
      clearSelectionState();
      revokeRuntimeAssets();
      localStorage.removeItem(AUTOSAVE_KEY);
    },

    openProject: async () => {
      const picked = await readPickedProjectFile();
      if (!picked) return null;

      const loaded = await parsePickedProject(picked.file);
      currentProjectHandle = picked.handle;

      return {
        projectPath: picked.fileName,
        project: loaded.project,
        assets: loaded.assets
      } satisfies ProjectLoadResult;
    },

    openProjectAtPath: async () => {
      return null;
    },

    saveProject: async (project: StoryProjectFile, projectPath: string | null) => {
      const fallbackPath = projectPath ?? currentProjectHandle?.name ?? null;
      return writeProjectFile(project, fallbackPath);
    },

    saveProjectAs: async (project: StoryProjectFile) => {
      const fallbackPath = currentProjectHandle?.name ?? null;
      return writeProjectFile(project, fallbackPath);
    },

    pickImageFiles: async () => {
      return pickImageFiles();
    },

    importAsset: async (sourcePath: string) => {
      const file = selectedFilesByToken.get(sourcePath);
      if (!file) {
        throw new Error("Selected image is no longer available.");
      }

      selectedFilesByToken.delete(sourcePath);

      const assetId = randomId();
      const ext = fileExtension(file.name);
      const mimeType = file.type || detectMimeType(file.name);
      const relativePath = `${assetId}${ext}`;
      const blob = file.slice(0, file.size, mimeType);

      const previousUri = assetUrisById.get(assetId);
      if (previousUri) {
        URL.revokeObjectURL(previousUri);
      }

      const uri = URL.createObjectURL(blob);
      assetBlobsById.set(assetId, blob);
      assetUrisById.set(assetId, uri);

      return {
        id: assetId,
        fileName: file.name,
        relativePath,
        mimeType,
        absolutePath: `web://assets/${relativePath}`,
        uri
      } satisfies RuntimeStoryAsset;
    },

    importDataAsset: async (dataUrl: string, fileName: string) => {
      const blob = dataUrlToBlob(dataUrl);
      if (!blob) {
        throw new Error("Drawing data is invalid.");
      }

      const normalizedName = fileName.trim().length > 0 ? fileName.trim() : `drawing-${Date.now()}.png`;
      const assetId = randomId();
      const mimeType = blob.type || detectMimeType(normalizedName);
      const ext = fileExtension(normalizedName) || extensionFromMimeType(mimeType);
      const relativePath = `${assetId}${ext}`;
      const runtimeBlob = blob.type ? blob : blob.slice(0, blob.size, mimeType);

      const previousUri = assetUrisById.get(assetId);
      if (previousUri) {
        URL.revokeObjectURL(previousUri);
      }

      const uri = URL.createObjectURL(runtimeBlob);
      assetBlobsById.set(assetId, runtimeBlob);
      assetUrisById.set(assetId, uri);

      return {
        id: assetId,
        fileName: normalizedName,
        relativePath,
        mimeType,
        absolutePath: `web://assets/${relativePath}`,
        uri
      } satisfies RuntimeStoryAsset;
    },

    deleteAsset: async (assetId: string) => {
      const uri = assetUrisById.get(assetId);
      if (uri) {
        URL.revokeObjectURL(uri);
      }
      assetUrisById.delete(assetId);
      assetBlobsById.delete(assetId);
    },

    autosaveProject: async (project: StoryProjectFile) => {
      const now = new Date().toISOString();
      const nextProject: StoryProjectFile = {
        ...project,
        meta: {
          ...project.meta,
          updatedAt: now
        }
      };

      const assetPayloads: Record<string, string> = {};
      for (const asset of nextProject.assets) {
        const blob = assetBlobsById.get(asset.id);
        if (!blob) continue;
        assetPayloads[asset.id] = await blobToDataUrl(blob);
      }

      const payload: WebProjectBundle = {
        format: WEB_BUNDLE_FORMAT,
        version: WEB_BUNDLE_VERSION,
        project: nextProject,
        assetPayloads
      };

      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
      } catch {
        // Ignore storage quota and private-mode restrictions.
      }
    },

    getStartupData: async () => {
      return startupData(unsupportedUpdate);
    },

    checkForUpdates: async () => {
      return unsupportedUpdate;
    },

    installUpdate: async () => {
      return false;
    }
  };
}
