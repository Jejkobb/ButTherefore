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
      data: node.data
    })),
    edges: project.edges.map((edge: StoryEdgeModel) => ({
      id: edge.id,
      type: "storyEdge",
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
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
    nodes: document.nodes.map((node) => ({
      id: node.id,
      position: node.position,
      data: node.data
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
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
