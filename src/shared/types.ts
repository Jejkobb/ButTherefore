export const STORY_SCHEMA_VERSION = 1 as const;

export type RelationType = "BUT" | "THEREFORE";

export interface StoryAsset {
  id: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
}

export interface RuntimeStoryAsset extends StoryAsset {
  absolutePath: string;
  uri: string;
}

export interface StoryNodeData {
  title: string;
  beats: string[];
  imageAssetIds: string[];
}

export interface StoryNodeModel {
  id: string;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  data: StoryNodeData;
}

export interface StoryEdgeModel {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  relation: RelationType;
}

export interface StoryViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface StoryProjectFile {
  schemaVersion: typeof STORY_SCHEMA_VERSION;
  meta: {
    name: string;
    createdAt: string;
    updatedAt: string;
  };
  nodes: StoryNodeModel[];
  edges: StoryEdgeModel[];
  assets: StoryAsset[];
  viewport: StoryViewport;
}

export function createEmptyProject(name = "Untitled Project"): StoryProjectFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    meta: {
      name,
      createdAt: now,
      updatedAt: now
    },
    nodes: [],
    edges: [],
    assets: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assertStoryProjectFile(value: unknown): StoryProjectFile {
  if (!isObject(value)) {
    throw new Error("Project file must be an object.");
  }

  if (value.schemaVersion !== STORY_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${String(value.schemaVersion)}`);
  }

  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges) || !Array.isArray(value.assets)) {
    throw new Error("Project file is missing required arrays.");
  }

  if (!isObject(value.meta)) {
    throw new Error("Project meta is missing.");
  }

  if (!isObject(value.viewport)) {
    throw new Error("Project viewport is missing.");
  }

  return value as StoryProjectFile;
}
