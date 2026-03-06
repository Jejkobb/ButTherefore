import type { Edge, Node, Viewport } from "@xyflow/react";
import type {
  ImageNodeData,
  PostItNodeData,
  RelationType,
  RuntimeStoryAsset,
  StoryEdgeModel,
  StoryNodeData,
  StoryNodeType,
  StoryProjectFile
} from "@/shared/types";

export type StoryFlowNode = Node<StoryNodeData, "storyNode">;
export type PostItFlowNode = Node<PostItNodeData, "postItNode">;
export type ImageFlowNode = Node<ImageNodeData, "imageNode">;
export type FlowNode = StoryFlowNode | PostItFlowNode | ImageFlowNode;
export type StoryFlowEdge = Edge<{ relation: RelationType }, "storyEdge">;

export interface GraphDocument {
  nodes: FlowNode[];
  edges: StoryFlowEdge[];
  assets: Record<string, RuntimeStoryAsset>;
  viewport: Viewport;
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractNodeSize(node: FlowNode): { width: number; height: number } | undefined {
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

function normalizeStoryNodeData(value: unknown): StoryNodeData {
  const candidate = value as Partial<StoryNodeData> | null | undefined;
  const beats = Array.isArray(candidate?.beats) ? candidate.beats.filter((beat): beat is string => typeof beat === "string") : [];
  const imageAssetIds = Array.isArray(candidate?.imageAssetIds)
    ? candidate.imageAssetIds.filter((assetId): assetId is string => typeof assetId === "string")
    : [];

  return {
    title: typeof candidate?.title === "string" ? candidate.title : "Story Beat",
    beats: beats.length > 0 ? beats : [""],
    imageAssetIds
  };
}

function normalizePostItNodeData(value: unknown): PostItNodeData {
  const candidate = value as Partial<PostItNodeData> | null | undefined;
  return {
    note: typeof candidate?.note === "string" ? candidate.note : ""
  };
}

function normalizeImageNodeData(value: unknown): ImageNodeData {
  const candidate = value as Partial<ImageNodeData> | null | undefined;
  return {
    assetId: typeof candidate?.assetId === "string" ? candidate.assetId : ""
  };
}

function normalizeNodeType(type: StoryNodeType | undefined): StoryNodeType {
  if (type === "postItNode") return "postItNode";
  if (type === "imageNode") return "imageNode";
  return "storyNode";
}

export function projectToDocument(project: StoryProjectFile, runtimeAssets: RuntimeStoryAsset[]): GraphDocument {
  const assets = runtimeAssets.reduce<Record<string, RuntimeStoryAsset>>((acc, asset) => {
    acc[asset.id] = asset;
    return acc;
  }, {});

  const nodes: FlowNode[] = [];

  for (const node of project.nodes) {
    const type = normalizeNodeType(node.type);

    if (type === "postItNode") {
      nodes.push({
        id: node.id,
        type: "postItNode",
        position: node.position,
        parentId: node.parentId,
        extent: node.extent,
        ...(node.size ? { style: { width: node.size.width, height: node.size.height } } : {}),
        data: normalizePostItNodeData(node.data)
      });
      continue;
    }

    if (type === "imageNode") {
      const parentedFlags = node.parentId ? { draggable: false, selectable: false, focusable: false } : {};
      const parentedStyle = node.parentId ? { pointerEvents: "none" as const } : {};
      nodes.push({
        id: node.id,
        type: "imageNode",
        position: node.position,
        parentId: node.parentId,
        extent: node.extent,
        ...parentedFlags,
        ...(node.size ? { style: { width: node.size.width, height: node.size.height, ...parentedStyle } } : {}),
        ...(!node.size && node.parentId ? { style: { ...parentedStyle } } : {}),
        data: normalizeImageNodeData(node.data)
      });
      continue;
    }

    const normalizedStoryData = normalizeStoryNodeData(node.data);
    nodes.push({
      id: node.id,
      type: "storyNode",
      position: node.position,
      ...(node.size ? { style: { width: node.size.width, height: node.size.height } } : {}),
      data: {
        ...normalizedStoryData,
        imageAssetIds: []
      }
    });

    // Backward compatibility: pre-image-node projects store image ids on the story node itself.
    normalizedStoryData.imageAssetIds.forEach((assetId) => {
      if (!assets[assetId]) return;
      nodes.push({
        id: crypto.randomUUID(),
        type: "imageNode",
        parentId: node.id,
        extent: "parent",
        position: { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        focusable: false,
        style: {
          width: node.size?.width ?? 320,
          height: node.size?.height ?? 120,
          pointerEvents: "none"
        },
        data: { assetId }
      });
    });
  }

  return {
    nodes,
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
        type: node.type,
        position: node.position,
        ...(size ? { size } : {}),
        ...(node.parentId ? { parentId: node.parentId } : {}),
        ...(node.extent === "parent" ? { extent: "parent" as const } : {}),
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
