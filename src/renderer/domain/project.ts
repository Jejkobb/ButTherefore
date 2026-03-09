import type { Edge, Node, Viewport } from "@xyflow/react";
import type {
  ImageNodeData,
  PostItNodeData,
  RelationType,
  RuntimeStoryAsset,
  StoryEdgeModel,
  StoryNodeData,
  StoryNodeModel,
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

interface NormalizedProjectNode {
  id: string;
  type: StoryNodeType;
  position: { x: number; y: number };
  size?: { width: number; height: number };
  parentId?: string;
  extent?: "parent";
  data: StoryNodeData | PostItNodeData | ImageNodeData;
  zIndex?: number;
}

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_POSTIT_Z_INDEX = 10_000;

function toNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeNodeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePosition(value: unknown): { x: number; y: number } {
  const candidate = value as { x?: unknown; y?: unknown } | null | undefined;
  return {
    x: toNumber(candidate?.x) ?? 0,
    y: toNumber(candidate?.y) ?? 0
  };
}

function normalizeSize(value: unknown): { width: number; height: number } | undefined {
  const candidate = value as { width?: unknown; height?: unknown } | null | undefined;
  const width = toNumber(candidate?.width);
  const height = toNumber(candidate?.height);
  if (width === null || height === null || width <= 0 || height <= 0) return undefined;
  return { width, height };
}

function normalizeViewport(viewport: unknown): Viewport {
  const candidate = viewport as { x?: unknown; y?: unknown; zoom?: unknown } | null | undefined;
  const x = toNumber(candidate?.x) ?? DEFAULT_VIEWPORT.x;
  const y = toNumber(candidate?.y) ?? DEFAULT_VIEWPORT.y;
  const zoomRaw = toNumber(candidate?.zoom) ?? DEFAULT_VIEWPORT.zoom;
  const zoom = zoomRaw > 0 ? zoomRaw : DEFAULT_VIEWPORT.zoom;

  return { x, y, zoom };
}

function extractNodeSize(node: FlowNode): { width: number; height: number } | undefined {
  const width =
    toNumber(node.width) ??
    toNumber((node.style as Record<string, unknown> | undefined)?.width);
  const height =
    toNumber(node.height) ??
    toNumber((node.style as Record<string, unknown> | undefined)?.height);

  if (width === null || height === null || width <= 0 || height <= 0) return undefined;
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

function normalizeRelation(value: unknown): RelationType {
  return value === "BUT" ? "BUT" : "THEREFORE";
}

function normalizeProjectNode(node: StoryNodeModel): NormalizedProjectNode | null {
  const id = normalizeNodeId(node.id);
  if (!id) return null;

  const type = normalizeNodeType(node.type);
  const position = normalizePosition(node.position);
  const size = normalizeSize(node.size);
  const parentId = normalizeNodeId(node.parentId);
  const zIndexValue = toNumber((node as { zIndex?: unknown }).zIndex);
  const zIndex = zIndexValue === null ? undefined : zIndexValue;

  if (type === "postItNode") {
    return {
      id,
      type,
      position,
      size,
      data: normalizePostItNodeData(node.data),
      ...(zIndex !== undefined ? { zIndex } : {})
    };
  }

  if (type === "imageNode") {
    return {
      id,
      type,
      position,
      size,
      ...(parentId ? { parentId, extent: "parent" as const } : {}),
      data: normalizeImageNodeData(node.data),
      ...(zIndex !== undefined ? { zIndex } : {})
    };
  }

  return {
    id,
    type,
    position,
    size,
    data: normalizeStoryNodeData(node.data),
    ...(zIndex !== undefined ? { zIndex } : {})
  };
}

function normalizeProjectEdge(edge: StoryEdgeModel): StoryFlowEdge | null {
  const id = normalizeNodeId(edge.id);
  const source = normalizeNodeId(edge.source);
  const target = normalizeNodeId(edge.target);
  if (!id || !source || !target) return null;

  const sourceHandleRaw =
    typeof edge.sourceHandle === "string" || edge.sourceHandle === null
      ? edge.sourceHandle
      : undefined;
  const targetHandleRaw =
    typeof edge.targetHandle === "string" || edge.targetHandle === null
      ? edge.targetHandle
      : undefined;

  return {
    id,
    type: "storyEdge",
    source,
    target,
    sourceHandle: normalizeHandleId(sourceHandleRaw),
    targetHandle: normalizeHandleId(targetHandleRaw),
    data: { relation: normalizeRelation(edge.relation) }
  };
}

function isStoryFlowNode(node: FlowNode): node is StoryFlowNode {
  return node.type === "storyNode";
}

function isImageFlowNode(node: FlowNode): node is ImageFlowNode {
  return node.type === "imageNode";
}

function collectReferencedAssetIds(nodes: FlowNode[]): Set<string> {
  return nodes.reduce<Set<string>>((acc, node) => {
    if (!isImageFlowNode(node)) return acc;
    const assetId = node.data.assetId;
    if (assetId) {
      acc.add(assetId);
    }
    return acc;
  }, new Set());
}

function retainReferencedAssets(
  assets: Record<string, RuntimeStoryAsset>,
  referencedAssetIds: Set<string>
): Record<string, RuntimeStoryAsset> {
  return Object.entries(assets).reduce<Record<string, RuntimeStoryAsset>>((acc, [assetId, asset]) => {
    if (referencedAssetIds.has(assetId)) {
      acc[assetId] = asset;
    }
    return acc;
  }, {});
}

export function projectToDocument(project: StoryProjectFile, runtimeAssets: RuntimeStoryAsset[]): GraphDocument {
  const assetMap = runtimeAssets.reduce<Record<string, RuntimeStoryAsset>>((acc, asset) => {
    acc[asset.id] = asset;
    return acc;
  }, {});

  const normalizedProjectNodes: NormalizedProjectNode[] = [];
  const seenNodeIds = new Set<string>();

  for (const node of project.nodes) {
    const normalized = normalizeProjectNode(node);
    if (!normalized || seenNodeIds.has(normalized.id)) continue;
    seenNodeIds.add(normalized.id);
    normalizedProjectNodes.push(normalized);
  }

  const storyNodeIds = new Set(
    normalizedProjectNodes
      .filter((node): node is NormalizedProjectNode & { type: "storyNode" } => node.type === "storyNode")
      .map((node) => node.id)
  );
  const explicitParentedPairs = new Set(
    normalizedProjectNodes
      .filter(
        (node): node is NormalizedProjectNode & { type: "imageNode"; parentId: string } =>
          node.type === "imageNode" && Boolean(node.parentId) && storyNodeIds.has(node.parentId)
      )
      .map((node) => `${node.parentId}:${(node.data as ImageNodeData).assetId}`)
  );

  const nodes: FlowNode[] = [];

  for (const node of normalizedProjectNodes) {
    const type = node.type;

    if (type === "postItNode") {
      nodes.push({
        id: node.id,
        type: "postItNode",
        position: node.position,
        zIndex: node.zIndex ?? DEFAULT_POSTIT_Z_INDEX,
        ...(node.size ? { style: { width: node.size.width, height: node.size.height } } : {}),
        data: normalizePostItNodeData(node.data)
      });
      continue;
    }

    if (type === "imageNode") {
      if (node.parentId && !storyNodeIds.has(node.parentId)) {
        continue;
      }

      const isParented = Boolean(node.parentId);
      const parentedFlags = isParented ? { draggable: false, selectable: false, focusable: false } : {};
      const parentedStyle = isParented ? { pointerEvents: "none" as const } : {};
      const imageData = normalizeImageNodeData(node.data);

      nodes.push({
        id: node.id,
        type: "imageNode",
        position: node.position,
        ...(isParented ? { parentId: node.parentId, extent: "parent" as const } : {}),
        ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {}),
        ...parentedFlags,
        ...(node.size ? { style: { width: node.size.width, height: node.size.height, ...parentedStyle } } : {}),
        ...(!node.size && isParented ? { style: { ...parentedStyle } } : {}),
        data: imageData
      });
      continue;
    }

    const normalizedStoryData = normalizeStoryNodeData(node.data);
    nodes.push({
      id: node.id,
      type: "storyNode",
      position: node.position,
      ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {}),
      ...(node.size ? { style: { width: node.size.width, height: node.size.height } } : {}),
      data: {
        ...normalizedStoryData,
        imageAssetIds: []
      }
    });

    // Backward compatibility: pre-image-node projects store image ids on the story node itself.
    normalizedStoryData.imageAssetIds.forEach((assetId) => {
      if (!assetMap[assetId]) return;
      if (explicitParentedPairs.has(`${node.id}:${assetId}`)) return;
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

  const storyFlowNodeIds = new Set(nodes.filter(isStoryFlowNode).map((node) => node.id));
  const seenEdgeIds = new Set<string>();
  const edges: StoryFlowEdge[] = [];
  for (const edge of project.edges) {
    const normalized = normalizeProjectEdge(edge);
    if (!normalized || seenEdgeIds.has(normalized.id)) continue;
    if (!storyFlowNodeIds.has(normalized.source) || !storyFlowNodeIds.has(normalized.target)) continue;
    seenEdgeIds.add(normalized.id);
    edges.push(normalized);
  }

  const referencedAssetIds = collectReferencedAssetIds(nodes);

  return {
    nodes,
    edges,
    assets: retainReferencedAssets(assetMap, referencedAssetIds),
    viewport: normalizeViewport(project.viewport)
  };
}

export function documentToProject(document: GraphDocument, name: string, createdAt?: string): StoryProjectFile {
  const now = new Date().toISOString();
  const normalizedName = name.trim().length > 0 ? name.trim() : "Untitled Project";
  const normalizedNodes: NormalizedProjectNode[] = [];
  const seenNodeIds = new Set<string>();

  for (const node of document.nodes) {
    const id = normalizeNodeId(node.id);
    if (!id || seenNodeIds.has(id)) continue;
    seenNodeIds.add(id);

    const type = normalizeNodeType((node as { type?: StoryNodeType }).type);
    const position = normalizePosition(node.position);
    const size = extractNodeSize(node);
    const zIndexValue = toNumber((node as { zIndex?: unknown }).zIndex);
    const zIndex = zIndexValue === null ? undefined : zIndexValue;

    if (type === "postItNode") {
      normalizedNodes.push({
        id,
        type,
        position,
        ...(size ? { size } : {}),
        data: normalizePostItNodeData(node.data),
        ...(zIndex !== undefined ? { zIndex } : {})
      });
      continue;
    }

    if (type === "imageNode") {
      const parentId = normalizeNodeId(node.parentId);
      normalizedNodes.push({
        id,
        type,
        position,
        ...(size ? { size } : {}),
        ...(parentId ? { parentId, extent: "parent" as const } : {}),
        data: normalizeImageNodeData(node.data),
        ...(zIndex !== undefined ? { zIndex } : {})
      });
      continue;
    }

    normalizedNodes.push({
      id,
      type: "storyNode",
      position,
      ...(size ? { size } : {}),
      data: {
        ...normalizeStoryNodeData(node.data),
        imageAssetIds: []
      },
      ...(zIndex !== undefined ? { zIndex } : {})
    });
  }

  const storyNodeIds = new Set(
    normalizedNodes
      .filter((node): node is NormalizedProjectNode & { type: "storyNode" } => node.type === "storyNode")
      .map((node) => node.id)
  );

  const persistedNodes: StoryProjectFile["nodes"] = normalizedNodes
    .filter((node) => node.type !== "imageNode" || !node.parentId || storyNodeIds.has(node.parentId))
    .map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      ...(node.size ? { size: node.size } : {}),
      ...(node.zIndex !== undefined ? { zIndex: node.zIndex } : {}),
      ...(node.type === "imageNode" && node.parentId ? { parentId: node.parentId, extent: "parent" as const } : {}),
      data: node.data
    }));

  const persistedStoryNodeIds = new Set(
    persistedNodes
      .filter((node): node is StoryNodeModel & { type: "storyNode" } => normalizeNodeType(node.type) === "storyNode")
      .map((node) => node.id)
  );

  const seenEdgeIds = new Set<string>();
  const persistedEdges: StoryProjectFile["edges"] = [];
  for (const edge of document.edges) {
    const id = normalizeNodeId(edge.id);
    const source = normalizeNodeId(edge.source);
    const target = normalizeNodeId(edge.target);
    if (!id || !source || !target) continue;
    if (seenEdgeIds.has(id)) continue;
    if (!persistedStoryNodeIds.has(source) || !persistedStoryNodeIds.has(target)) continue;
    seenEdgeIds.add(id);

    persistedEdges.push({
      id,
      source,
      target,
      sourceHandle: normalizeHandleId(edge.sourceHandle),
      targetHandle: normalizeHandleId(edge.targetHandle),
      relation: normalizeRelation(edge.data?.relation)
    });
  }

  const referencedAssetIds = persistedNodes.reduce<Set<string>>((acc, node) => {
    if (normalizeNodeType(node.type) !== "imageNode") return acc;
    const assetId = normalizeImageNodeData(node.data).assetId;
    if (assetId) {
      acc.add(assetId);
    }
    return acc;
  }, new Set());

  const persistedAssets = Object.values(document.assets)
    .filter((asset) => referencedAssetIds.has(asset.id))
    .map((asset) => ({
      id: asset.id,
      fileName: asset.fileName,
      relativePath: asset.relativePath,
      mimeType: asset.mimeType
    }));

  return {
    schemaVersion: 1,
    meta: {
      name: normalizedName,
      createdAt: createdAt ?? now,
      updatedAt: now
    },
    nodes: persistedNodes,
    edges: persistedEdges,
    assets: persistedAssets,
    viewport: normalizeViewport(document.viewport)
  };
}
