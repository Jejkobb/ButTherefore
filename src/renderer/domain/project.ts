import type { Edge, Node, Viewport } from "@xyflow/react";
import type {
  RelationType,
  RuntimeStoryAsset,
  StoryEdgeModel,
  StoryNodeData,
  StoryNodeModel,
  StoryProjectFile
} from "@/shared/types";

export type StoryFlowNode = Node<StoryNodeData, "storyNode">;
export type StoryFlowEdge = Edge<{ relation: RelationType }, "storyEdge">;

export interface GraphDocument {
  nodes: StoryFlowNode[];
  edges: StoryFlowEdge[];
  assets: Record<string, RuntimeStoryAsset>;
  viewport: Viewport;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractNodeSize(node: StoryFlowNode): { width: number; height: number } | undefined {
  const width =
    toNumber(node.width) ??
    toNumber((node.style as Record<string, unknown> | undefined)?.width);
  const height =
    toNumber(node.height) ??
    toNumber((node.style as Record<string, unknown> | undefined)?.height);

  if (width === null || height === null) return undefined;
  return { width, height };
}

function normalizeHandleId(handleId: string | null | undefined): string | null {
  if (handleId === "out-left") return "in";
  if (handleId === "in-right") return "out";
  return handleId ?? null;
}

export function projectToDocument(project: StoryProjectFile, runtimeAssets: RuntimeStoryAsset[]): GraphDocument {
  const assets = runtimeAssets.reduce<Record<string, RuntimeStoryAsset>>((acc, asset) => {
    acc[asset.id] = asset;
    return acc;
  }, {});

  return {
    nodes: project.nodes.map((node: StoryNodeModel) => ({
      id: node.id,
      type: "storyNode",
      position: node.position,
      ...(node.size ? { style: { width: node.size.width, height: node.size.height } } : {}),
      data: node.data
    })),
    edges: project.edges.map((edge: StoryEdgeModel) => ({
      id: edge.id,
      type: "storyEdge",
      source: edge.source,
      target: edge.target,
      sourceHandle: normalizeHandleId(edge.sourceHandle),
      targetHandle: normalizeHandleId(edge.targetHandle),
      data: { relation: edge.relation }
    })),
    assets,
    viewport: project.viewport
  };
}

export function documentToProject(document: GraphDocument, name: string, createdAt?: string): StoryProjectFile {
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    meta: {
      name,
      createdAt: createdAt ?? now,
      updatedAt: now
    },
    nodes: document.nodes.map((node) => {
      const size = extractNodeSize(node);
      return {
        id: node.id,
        position: node.position,
        ...(size ? { size } : {}),
        data: node.data
      };
    }),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: normalizeHandleId(edge.sourceHandle),
      targetHandle: normalizeHandleId(edge.targetHandle),
      relation: edge.data?.relation ?? "THEREFORE"
    })),
    assets: Object.values(document.assets).map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      relativePath: asset.relativePath,
      mimeType: asset.mimeType
    })),
    viewport: document.viewport
  };
}
