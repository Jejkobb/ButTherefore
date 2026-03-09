import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition
} from "@xyflow/react";
import { create } from "zustand";
import { createEmptyProject } from "@/shared/types";
import type { RuntimeStoryAsset } from "@/shared/types";
import {
  documentToProject,
  type ImageFlowNode,
  projectToDocument,
  type FlowNode,
  type GraphDocument,
  type PostItFlowNode,
  type StoryFlowEdge,
  type StoryFlowNode
} from "@/renderer/domain/project";

interface GraphCommand {
  label: string;
  redo: (doc: GraphDocument) => GraphDocument;
  undo: (doc: GraphDocument) => GraphDocument;
  mergeKey?: string;
}

interface GraphHistory {
  past: GraphCommand[];
  future: GraphCommand[];
}

interface GraphStore {
  doc: GraphDocument;
  history: GraphHistory;
  projectPath: string | null;
  projectName: string;
  createdAt: string;
  lastSavedAt: string | null;
  dirty: boolean;
  hoveredStoryNodeId: string | null;
  executeCommand: (command: GraphCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  applyNodeChangesLive: (changes: NodeChange<FlowNode>[]) => void;
  applyEdgeChangesLive: (changes: EdgeChange<StoryFlowEdge>[]) => void;
  setViewport: (viewport: GraphDocument["viewport"]) => void;
  setHoveredStoryNodeId: (nodeId: string | null) => void;
  createNode: (position: XYPosition) => void;
  createPostItNode: (position: XYPosition) => void;
  createImageNodes: (position: XYPosition, filePaths: string[]) => Promise<void>;
  createNodeFromConnection: (sourceNodeId: string, sourceHandleId: string | null, position: XYPosition) => void;
  connectNodes: (connection: Connection) => void;
  commitNodeMove: (previousPositions: Record<string, XYPosition>) => void;
  deleteSelection: () => void;
  updateNodeTitle: (nodeId: string, title: string) => void;
  updateBeatLine: (nodeId: string, index: number, value: string) => void;
  updatePostItNote: (nodeId: string, note: string) => void;
  addBeatLine: (nodeId: string) => void;
  removeBeatLine: (nodeId: string, index: number) => void;
  toggleEdgeRelation: (edgeId: string) => void;
  attachImagesToNode: (nodeId: string, filePaths: string[]) => Promise<void>;
  dockImageNodesToStoryNodes: (nodeIds: string[]) => void;
  removeImageNode: (nodeId: string) => Promise<void>;
  removeImageFromNode: (nodeId: string, assetId: string) => Promise<void>;
  newProject: () => Promise<void>;
  openProject: () => Promise<boolean>;
  openProjectAtPath: (projectPath: string) => Promise<boolean>;
  saveProject: () => Promise<void>;
  saveProjectAs: () => Promise<void>;
  autosaveProject: () => Promise<void>;
  updateProjectName: (projectName: string) => void;
}

const empty = createEmptyProject();
const DEFAULT_IMAGE_NODE_WIDTH = 180;
const DEFAULT_IMAGE_NODE_HEIGHT = 120;
const MIN_IMAGE_NODE_WIDTH = 92;
const MIN_IMAGE_NODE_HEIGHT = 62;
const IMAGE_SPAWN_LONG_SIDE = 220;

interface ImageDimensions {
  width: number;
  height: number;
}

function readImageDimensions(uri: string): Promise<ImageDimensions | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (width > 0 && height > 0) {
        resolve({ width, height });
        return;
      }
      resolve(null);
    };
    image.onerror = () => resolve(null);
    image.src = uri;
  });
}

function computeStandaloneImageSize(dimensions: ImageDimensions | null): { width: number; height: number } {
  if (!dimensions) {
    return { width: DEFAULT_IMAGE_NODE_WIDTH, height: DEFAULT_IMAGE_NODE_HEIGHT };
  }

  const ratio = dimensions.width / dimensions.height;
  let width: number;
  let height: number;

  if (ratio >= 1) {
    width = IMAGE_SPAWN_LONG_SIDE;
    height = width / ratio;
  } else {
    height = IMAGE_SPAWN_LONG_SIDE;
    width = height * ratio;
  }

  const scaleUp = Math.max(MIN_IMAGE_NODE_WIDTH / width, MIN_IMAGE_NODE_HEIGHT / height, 1);
  return {
    width: width * scaleUp,
    height: height * scaleUp
  };
}

function createStarterNode(position: XYPosition = { x: 120, y: 120 }): StoryFlowNode {
  return {
    id: crypto.randomUUID(),
    type: "storyNode",
    position,
    style: {
      width: 320
    },
    data: {
      title: "Story Beat",
      beats: [""],
      imageAssetIds: []
    }
  };
}

function createPostItNodeTemplate(position: XYPosition): PostItFlowNode {
  return {
    id: crypto.randomUUID(),
    type: "postItNode",
    position,
    style: {
      width: 280,
      height: 260
    },
    data: {
      note: ""
    }
  };
}

function createImageNodeTemplate(assetId: string, position: XYPosition, parentId?: string, draggable = true): ImageFlowNode {
  return {
    id: crypto.randomUUID(),
    type: "imageNode",
    position,
    draggable,
    ...(parentId ? { parentId, extent: "parent" as const, selectable: false, focusable: false } : {}),
    style: {
      width: DEFAULT_IMAGE_NODE_WIDTH,
      height: DEFAULT_IMAGE_NODE_HEIGHT,
      ...(parentId ? { pointerEvents: "none" as const } : {})
    },
    data: {
      assetId
    }
  };
}

function createInitialDocument(viewport: GraphDocument["viewport"] = empty.viewport): GraphDocument {
  return {
    nodes: [createStarterNode()],
    edges: [],
    assets: {},
    viewport
  };
}

const initialDoc: GraphDocument = createInitialDocument();

function replaceNode(doc: GraphDocument, nodeId: string, updater: (node: FlowNode) => FlowNode): GraphDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? updater(node) : node))
  };
}

function isStoryNode(node: FlowNode): node is StoryFlowNode {
  return node.type === "storyNode";
}

function isPostItNode(node: FlowNode): node is PostItFlowNode {
  return node.type === "postItNode";
}

function isImageNode(node: FlowNode): node is ImageFlowNode {
  return node.type === "imageNode";
}

function readNodeSize(node: { width?: number; height?: number; style?: Record<string, unknown> }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  return {
    width: styleWidth ?? (typeof node.width === "number" ? node.width : 0),
    height: styleHeight ?? (typeof node.height === "number" ? node.height : 0)
  };
}

function absoluteNodePosition(node: FlowNode, nodeById: Map<string, FlowNode>): XYPosition {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;

  while (parentId) {
    const parent = nodeById.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }

  return { x, y };
}

function edgeExists(doc: GraphDocument, connection: Connection): boolean {
  return doc.edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.sourceHandle === (connection.sourceHandle ?? null) &&
      edge.targetHandle === (connection.targetHandle ?? null)
  );
}

function collectDescendantNodeIds(nodes: FlowNode[], selectedNodeIds: Set<string>): Set<string> {
  if (selectedNodeIds.size === 0) return new Set();

  const childrenByParent = nodes.reduce<Map<string, string[]>>((acc, node) => {
    if (!node.parentId) return acc;
    const siblings = acc.get(node.parentId) ?? [];
    siblings.push(node.id);
    acc.set(node.parentId, siblings);
    return acc;
  }, new Map());

  const nodeIdsToRemove = new Set(selectedNodeIds);
  const queue = [...selectedNodeIds];

  while (queue.length > 0) {
    const parentId = queue.pop();
    if (!parentId) continue;
    const childIds = childrenByParent.get(parentId) ?? [];

    for (const childId of childIds) {
      if (nodeIdsToRemove.has(childId)) continue;
      nodeIdsToRemove.add(childId);
      queue.push(childId);
    }
  }

  return nodeIdsToRemove;
}

function retainReferencedAssets(
  nodes: FlowNode[],
  assets: Record<string, RuntimeStoryAsset>
): Record<string, RuntimeStoryAsset> {
  const referencedAssetIds = new Set(
    nodes
      .filter((node): node is ImageFlowNode => isImageNode(node))
      .map((node) => node.data.assetId)
      .filter((assetId): assetId is string => typeof assetId === "string" && assetId.length > 0)
  );

  return Object.entries(assets).reduce<Record<string, RuntimeStoryAsset>>((acc, [assetId, asset]) => {
    if (referencedAssetIds.has(assetId)) {
      acc[assetId] = asset;
    }
    return acc;
  }, {});
}

export const useGraphStore = create<GraphStore>((set, get) => ({
  doc: initialDoc,
  history: { past: [], future: [] },
  projectPath: null,
  projectName: empty.meta.name,
  createdAt: empty.meta.createdAt,
  lastSavedAt: null,
  dirty: false,
  hoveredStoryNodeId: null,

  executeCommand: (command) => {
    set((state) => {
      const past = state.history.past;
      const lastCommand = past[past.length - 1];

      if (command.mergeKey && lastCommand?.mergeKey === command.mergeKey) {
        const mergedCommand: GraphCommand = {
          ...command,
          undo: lastCommand.undo,
          mergeKey: command.mergeKey
        };

        return {
          doc: command.redo(state.doc),
          history: {
            past: [...past.slice(0, -1), mergedCommand],
            future: []
          },
          dirty: true
        };
      }

      return {
        doc: command.redo(state.doc),
        history: {
          past: [...past, command],
          future: []
        },
        dirty: true
      };
    });
  },

  undo: () => {
    const { history } = get();
    if (history.past.length === 0) return;

    const command = history.past[history.past.length - 1];

    set((state) => ({
      doc: command.undo(state.doc),
      history: {
        past: state.history.past.slice(0, -1),
        future: [command, ...state.history.future]
      },
      dirty: true
    }));
  },

  redo: () => {
    const { history } = get();
    if (history.future.length === 0) return;

    const [command, ...remaining] = history.future;

    set((state) => ({
      doc: command.redo(state.doc),
      history: {
        past: [...state.history.past, command],
        future: remaining
      },
      dirty: true
    }));
  },

  canUndo: () => get().history.past.length > 0,
  canRedo: () => get().history.future.length > 0,

  applyNodeChangesLive: (changes) => {
    set((state) => {
      const blockedIds = new Set(
        state.doc.nodes
          .filter((node) => isImageNode(node) && Boolean(node.parentId))
          .map((node) => node.id)
      );
      const filteredChanges = changes.filter((change) => !("id" in change) || !blockedIds.has(change.id));
      return {
        doc: {
          ...state.doc,
          nodes: applyNodeChanges(filteredChanges, state.doc.nodes)
        }
      };
    });
  },

  applyEdgeChangesLive: (changes) => {
    set((state) => ({
      doc: {
        ...state.doc,
        edges: applyEdgeChanges(changes, state.doc.edges)
      }
    }));
  },

  setViewport: (viewport) => {
    set((state) => {
      if (
        state.doc.viewport.x === viewport.x &&
        state.doc.viewport.y === viewport.y &&
        state.doc.viewport.zoom === viewport.zoom
      ) {
        return state;
      }

      return {
        doc: {
          ...state.doc,
          viewport
        },
        dirty: true
      };
    });
  },

  setHoveredStoryNodeId: (nodeId) => {
    set({ hoveredStoryNodeId: nodeId });
  },

  createNode: (position) => {
    const node = createStarterNode(position);

    get().executeCommand({
      label: "Create Node",
      redo: (doc) => ({ ...doc, nodes: [...doc.nodes, node] }),
      undo: (doc) => ({ ...doc, nodes: doc.nodes.filter((candidate) => candidate.id !== node.id) })
    });
  },

  createPostItNode: (position) => {
    const node = createPostItNodeTemplate(position);

    get().executeCommand({
      label: "Create Note",
      redo: (doc) => ({ ...doc, nodes: [...doc.nodes, node] }),
      undo: (doc) => ({ ...doc, nodes: doc.nodes.filter((candidate) => candidate.id !== node.id) })
    });
  },

  createImageNodes: async (position, filePaths) => {
    if (filePaths.length === 0) return;

    const importedAssets: RuntimeStoryAsset[] = [];
    for (const filePath of filePaths) {
      const imported = await window.storyBridge.importAsset(filePath);
      importedAssets.push(imported);
    }

    const importedAssetMap = importedAssets.reduce<Record<string, RuntimeStoryAsset>>((acc, asset) => {
      acc[asset.id] = asset;
      return acc;
    }, {});
    const imageDimensions = await Promise.all(importedAssets.map((asset) => readImageDimensions(asset.uri)));
    const currentDoc = get().doc;
    const baseZIndex = currentDoc.nodes.reduce((maxZ, node) => Math.max(maxZ, node.zIndex ?? 0), 0);
    const imageNodes = importedAssets.map((asset, index) => {
      const size = computeStandaloneImageSize(imageDimensions[index] ?? null);
      return {
        ...createImageNodeTemplate(asset.id, {
          x: position.x + index * 24,
          y: position.y + index * 24
        }),
        style: {
          width: size.width,
          height: size.height
        },
        zIndex: baseZIndex + index + 1
      };
    });

    get().executeCommand({
      label: "Add Images",
      redo: (doc) => ({
        ...doc,
        assets: {
          ...doc.assets,
          ...importedAssetMap
        },
        nodes: [...doc.nodes, ...imageNodes]
      }),
      undo: (doc) => {
        const nextAssets = { ...doc.assets };
        for (const asset of importedAssets) {
          delete nextAssets[asset.id];
        }

        return {
          ...doc,
          assets: nextAssets,
          nodes: doc.nodes.filter((node) => !imageNodes.some((imageNode) => imageNode.id === node.id))
        };
      }
    });
  },

  createNodeFromConnection: (sourceNodeId, sourceHandleId, position) => {
    const sourceNode = get().doc.nodes.find((node) => node.id === sourceNodeId);
    if (!sourceNode || !isStoryNode(sourceNode)) return;

    const node = createStarterNode(position);
    const sourceSide = sourceHandleId === "in" || sourceHandleId === "out-left" ? "left" : "right";
    const targetHandleId = sourceSide === "left" ? "out" : "in";

    const edge: StoryFlowEdge = {
      id: crypto.randomUUID(),
      type: "storyEdge",
      source: sourceNodeId,
      target: node.id,
      sourceHandle: sourceHandleId,
      targetHandle: targetHandleId,
      data: { relation: "THEREFORE" }
    };

    get().executeCommand({
      label: "Create Connected Node",
      redo: (doc) => ({
        ...doc,
        nodes: [...doc.nodes, node],
        edges: addEdge(edge, doc.edges)
      }),
      undo: (doc) => ({
        ...doc,
        nodes: doc.nodes.filter((candidate) => candidate.id !== node.id),
        edges: doc.edges.filter((candidate) => candidate.id !== edge.id)
      })
    });
  },

  connectNodes: (connection) => {
    if (!connection.source || !connection.target) return;
    if (edgeExists(get().doc, connection)) return;

    const sourceNode = get().doc.nodes.find((node) => node.id === connection.source);
    const targetNode = get().doc.nodes.find((node) => node.id === connection.target);
    if (!sourceNode || !targetNode || !isStoryNode(sourceNode) || !isStoryNode(targetNode)) return;

    const edge: StoryFlowEdge = {
      id: crypto.randomUUID(),
      type: "storyEdge",
      source: connection.source,
      target: connection.target,
      sourceHandle: connection.sourceHandle ?? null,
      targetHandle: connection.targetHandle ?? null,
      data: { relation: "THEREFORE" }
    };

    get().executeCommand({
      label: "Create Edge",
      redo: (doc) => ({ ...doc, edges: addEdge(edge, doc.edges) }),
      undo: (doc) => ({ ...doc, edges: doc.edges.filter((candidate) => candidate.id !== edge.id) })
    });
  },

  commitNodeMove: (previousPositions) => {
    const doc = get().doc;
    const nodeById = new Map(doc.nodes.map((node) => [node.id, node]));
    const movedIds = Object.keys(previousPositions).filter((id) => {
      const current = nodeById.get(id);
      if (!current) return false;
      const previous = previousPositions[id];
      return current.position.x !== previous.x || current.position.y !== previous.y;
    });

    if (movedIds.length === 0) return;

    const nextPositions = movedIds.reduce<Record<string, XYPosition>>((acc, id) => {
      const current = nodeById.get(id);
      if (current) {
        acc[id] = { ...current.position };
      }
      return acc;
    }, {});

    get().executeCommand({
      label: "Move Nodes",
      redo: (stateDoc) => ({
        ...stateDoc,
        nodes: stateDoc.nodes.map((node) =>
          nextPositions[node.id] ? { ...node, position: nextPositions[node.id] } : node
        )
      }),
      undo: (stateDoc) => ({
        ...stateDoc,
        nodes: stateDoc.nodes.map((node) =>
          previousPositions[node.id] ? { ...node, position: previousPositions[node.id] } : node
        )
      })
    });
  },

  deleteSelection: () => {
    const { doc } = get();
    const directlySelectedNodeIds = new Set(doc.nodes.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(doc.edges.filter((edge) => edge.selected).map((edge) => edge.id));
    const selectedNodeIds = collectDescendantNodeIds(doc.nodes, directlySelectedNodeIds);

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

    const removedEdgeIds = new Set(
      doc.edges
        .filter((edge) => selectedEdgeIds.has(edge.id) || selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target))
        .map((edge) => edge.id)
    );
    const nextNodes = doc.nodes.filter((node) => !selectedNodeIds.has(node.id));
    const nextEdges = doc.edges.filter((edge) => !removedEdgeIds.has(edge.id));
    const nextAssets = retainReferencedAssets(nextNodes, doc.assets);
    const nextDoc: GraphDocument = {
      ...doc,
      nodes: nextNodes,
      edges: nextEdges,
      assets: nextAssets
    };

    if (selectedNodeIds.size === 0 && removedEdgeIds.size === 0) return;

    get().executeCommand({
      label: "Delete Selection",
      redo: () => nextDoc,
      undo: () => doc
    });
  },

  updateNodeTitle: (nodeId, title) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || !isStoryNode(current) || current.data.title === title) return;

    const previous = current.data.title;

    get().executeCommand({
      label: "Edit Node Title",
      mergeKey: `title:${nodeId}`,
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          return {
            ...node,
            data: { ...node.data, title }
          };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          return {
            ...node,
            data: { ...node.data, title: previous }
          };
        })
    });
  },

  updateBeatLine: (nodeId, index, value) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || !isStoryNode(current) || current.data.beats[index] === value) return;

    const previous = current.data.beats[index] ?? "";

    get().executeCommand({
      label: "Edit Beat",
      mergeKey: `beat:${nodeId}:${index}`,
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          const beats = [...node.data.beats];
          beats[index] = value;
          return { ...node, data: { ...node.data, beats } };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          const beats = [...node.data.beats];
          beats[index] = previous;
          return { ...node, data: { ...node.data, beats } };
        })
    });
  },

  updatePostItNote: (nodeId, note) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || !isPostItNode(current) || current.data.note === note) return;

    const previous = current.data.note;

    get().executeCommand({
      label: "Edit Note",
      mergeKey: `postit:${nodeId}`,
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isPostItNode(node)) return node;
          return {
            ...node,
            data: {
              ...node.data,
              note
            }
          };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isPostItNode(node)) return node;
          return {
            ...node,
            data: {
              ...node.data,
              note: previous
            }
          };
        })
    });
  },

  addBeatLine: (nodeId) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || !isStoryNode(current)) return;

    get().executeCommand({
      label: "Add Beat",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          return {
            ...node,
            data: { ...node.data, beats: [...node.data.beats, ""] }
          };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          return {
            ...node,
            data: { ...node.data, beats: node.data.beats.slice(0, -1) }
          };
        })
    });
  },

  removeBeatLine: (nodeId, index) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || !isStoryNode(current) || current.data.beats.length <= 1 || index < 0 || index >= current.data.beats.length) return;

    const removedValue = current.data.beats[index];

    get().executeCommand({
      label: "Remove Beat",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          return {
            ...node,
            data: {
              ...node.data,
              beats: node.data.beats.filter((_, beatIndex) => beatIndex !== index)
            }
          };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          if (!isStoryNode(node)) return node;
          const beats = [...node.data.beats];
          beats.splice(index, 0, removedValue);
          return {
            ...node,
            data: {
              ...node.data,
              beats
            }
          };
        })
    });
  },

  toggleEdgeRelation: (edgeId) => {
    const current = get().doc.edges.find((edge) => edge.id === edgeId);
    if (!current) return;

    const currentRelation = current.data?.relation ?? "THEREFORE";
    const nextRelation = currentRelation === "BUT" ? "THEREFORE" : "BUT";

    get().executeCommand({
      label: "Toggle Relation",
      redo: (doc) => ({
        ...doc,
        edges: doc.edges.map((edge) =>
          edge.id === edgeId ? { ...edge, data: { relation: nextRelation } } : edge
        )
      }),
      undo: (doc) => ({
        ...doc,
        edges: doc.edges.map((edge) =>
          edge.id === edgeId ? { ...edge, data: { relation: currentRelation } } : edge
        )
      })
    });
  },

  attachImagesToNode: async (nodeId, filePaths) => {
    if (filePaths.length === 0) return;

    const currentNode = get().doc.nodes.find((node) => node.id === nodeId);
    if (!currentNode || !isStoryNode(currentNode)) return;

    const importedAssets: RuntimeStoryAsset[] = [];
    for (const filePath of filePaths) {
      const imported = await window.storyBridge.importAsset(filePath);
      importedAssets.push(imported);
    }

    const imageAssetIds = importedAssets.map((asset) => asset.id);
    const importedAssetMap = importedAssets.reduce<Record<string, RuntimeStoryAsset>>((acc, asset) => {
      acc[asset.id] = asset;
      return acc;
    }, {});
    const imageNodes = imageAssetIds.map((assetId) => createImageNodeTemplate(assetId, { x: 0, y: 0 }, nodeId, false));

    get().executeCommand({
      label: "Attach Images",
      redo: (doc) => {
        const targetStory = doc.nodes.find((node): node is StoryFlowNode => node.id === nodeId && isStoryNode(node));
        const targetStorySize = targetStory ? readNodeSize(targetStory) : { width: 0, height: 0 };
        const targetWidth = Math.max(targetStorySize.width, DEFAULT_IMAGE_NODE_WIDTH);
        const targetHeight = Math.max(targetStorySize.height, DEFAULT_IMAGE_NODE_HEIGHT);

        const nextNodes = doc.nodes.map((node) => {
          if (node.id !== nodeId || !isStoryNode(node)) return node;
          return {
            ...node,
            style: {
              ...(node.style ?? {}),
              width: targetWidth,
              height: targetHeight
            }
          };
        });

        const normalizedImageNodes = imageNodes.map((node) => ({
          ...node,
          position: { x: 0, y: 0 },
          draggable: false,
          style: {
            ...(node.style ?? {}),
            width: targetWidth,
            height: targetHeight
          }
        }));

        return {
          ...doc,
          assets: {
            ...doc.assets,
            ...importedAssetMap
          },
          nodes: [...nextNodes, ...normalizedImageNodes]
        };
      },
      undo: (doc) => {
        const nextAssets = { ...doc.assets };
        for (const assetId of imageAssetIds) {
          delete nextAssets[assetId];
        }

        return {
          ...doc,
          assets: nextAssets,
          nodes: doc.nodes.filter((node) => !imageNodes.some((imageNode) => imageNode.id === node.id))
        };
      }
    });
  },

  dockImageNodesToStoryNodes: (nodeIds) => {
    if (nodeIds.length === 0) return;
    const movedIds = new Set(nodeIds);
    const currentDoc = get().doc;
    const nodeById = new Map(currentDoc.nodes.map((node) => [node.id, node]));
    const storyNodes = currentDoc.nodes.filter((node): node is StoryFlowNode => isStoryNode(node));
    const storySizeOverrides = new Map<string, { width: number; height: number }>();
    let changed = false;

    const nextNodes = currentDoc.nodes.map((node) => {
      if (!movedIds.has(node.id) || !isImageNode(node)) return node;

      const baseSize = readNodeSize(node);
      const imageSize = {
        width: baseSize.width > 0 ? baseSize.width : DEFAULT_IMAGE_NODE_WIDTH,
        height: baseSize.height > 0 ? baseSize.height : DEFAULT_IMAGE_NODE_HEIGHT
      };
      const absolute = absoluteNodePosition(node, nodeById);
      const centerX = absolute.x + imageSize.width / 2;
      const centerY = absolute.y + imageSize.height / 2;

      let bestStory: StoryFlowNode | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (const story of storyNodes) {
        const storyAbsolute = absoluteNodePosition(story, nodeById);
        const storySize = storySizeOverrides.get(story.id) ?? readNodeSize(story);
        const left = storyAbsolute.x;
        const top = storyAbsolute.y;
        const right = storyAbsolute.x + storySize.width;
        const bottom = storyAbsolute.y + storySize.height;
        const insideBounds = centerX >= left && centerX <= right && centerY >= top && centerY <= bottom;
        if (!insideBounds) continue;

        const storyCenterX = storyAbsolute.x + storySize.width / 2;
        const storyCenterY = storyAbsolute.y + storySize.height / 2;
        const distance = Math.hypot(storyCenterX - centerX, storyCenterY - centerY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestStory = story;
        }
      }

      if (!bestStory) {
        if (!node.parentId) return node;

        const nodeStyle = node.style ?? {};
        changed = true;
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          draggable: true,
          selectable: true,
          focusable: true,
          style: {
            ...nodeStyle,
            pointerEvents: undefined
          },
          position: absolute
        };
      }

      const storySize = storySizeOverrides.get(bestStory.id) ?? readNodeSize(bestStory);
      const requiredWidth = Math.max(storySize.width, imageSize.width);
      const requiredHeight = Math.max(storySize.height, imageSize.height);
      if (requiredWidth > storySize.width || requiredHeight > storySize.height) {
        storySizeOverrides.set(bestStory.id, {
          width: requiredWidth,
          height: requiredHeight
        });
      }

      if (
        node.parentId !== bestStory.id ||
        node.extent !== "parent" ||
        node.position.x !== 0 ||
        node.position.y !== 0 ||
        node.draggable !== false
      ) {
        changed = true;
      }

      return {
        ...node,
        parentId: bestStory.id,
        extent: "parent",
        draggable: false,
        selectable: false,
        focusable: false,
        style: {
          ...(node.style ?? {}),
          pointerEvents: "none"
        },
        position: { x: 0, y: 0 }
      };
    });

    const nextWithExpandedStories = nextNodes.map((node) => {
      if (!isStoryNode(node)) return node;
      const override = storySizeOverrides.get(node.id);
      if (!override) return node;

      const currentSize = readNodeSize(node);
      if (currentSize.width !== override.width || currentSize.height !== override.height) {
        changed = true;
      }

      return {
        ...node,
        style: {
          ...(node.style ?? {}),
          width: override.width,
          height: override.height
        }
      };
    });

    const storySizeById = nextWithExpandedStories.reduce<Map<string, { width: number; height: number }>>((acc, node) => {
      if (isStoryNode(node)) {
        acc.set(node.id, readNodeSize(node));
      }
      return acc;
    }, new Map());

    const nextWithLockedParentedImages = nextWithExpandedStories.map((node) => {
      if (!isImageNode(node) || !node.parentId) return node;
      const parentSize = storySizeById.get(node.parentId);
      if (!parentSize) return node;

      const size = readNodeSize(node);
      if (
        node.position.x !== 0 ||
        node.position.y !== 0 ||
        node.draggable !== false ||
        size.width !== parentSize.width ||
        size.height !== parentSize.height
      ) {
        changed = true;
      }

      return {
        ...node,
        position: { x: 0, y: 0 },
        draggable: false,
        selectable: false,
        focusable: false,
        style: {
          ...(node.style ?? {}),
          width: parentSize.width,
          height: parentSize.height,
          pointerEvents: "none"
        }
      };
    });

    if (!changed) return;

    const nextDoc: GraphDocument = {
      ...currentDoc,
      nodes: nextWithLockedParentedImages
    };

    get().executeCommand({
      label: "Dock Images",
      redo: () => nextDoc,
      undo: () => currentDoc
    });
  },

  removeImageNode: async (nodeId) => {
    const { doc } = get();
    const target = doc.nodes.find((node): node is ImageFlowNode => node.id === nodeId && isImageNode(node));
    if (!target) return;

    const nextNodes = doc.nodes.filter((node) => node.id !== nodeId);
    const nextAssets = retainReferencedAssets(nextNodes, doc.assets);
    const nextDoc: GraphDocument = {
      ...doc,
      nodes: nextNodes,
      assets: nextAssets
    };

    get().executeCommand({
      label: "Delete Image",
      redo: () => nextDoc,
      undo: () => doc
    });
  },

  removeImageFromNode: async (nodeId, assetId) => {
    const target = get().doc.nodes.find(
      (node): node is ImageFlowNode => isImageNode(node) && node.data.assetId === assetId && (!nodeId || node.parentId === nodeId)
    );
    if (!target) return;
    await get().removeImageNode(target.id);
  },

  newProject: async () => {
    await window.storyBridge.newProjectSession();
    const fresh = createEmptyProject();

    set({
      doc: createInitialDocument(fresh.viewport),
      history: { past: [], future: [] },
      projectPath: null,
      projectName: fresh.meta.name,
      createdAt: fresh.meta.createdAt,
      lastSavedAt: null,
      dirty: false
    });
  },

  openProject: async () => {
    const opened = await window.storyBridge.openProject();
    if (!opened) return false;

    set({
      doc: projectToDocument(opened.project, opened.assets),
      history: { past: [], future: [] },
      projectPath: opened.projectPath,
      projectName: opened.project.meta.name,
      createdAt: opened.project.meta.createdAt,
      lastSavedAt: opened.project.meta.updatedAt,
      dirty: false
    });
    return true;
  },

  openProjectAtPath: async (projectPath) => {
    const opened = await window.storyBridge.openProjectAtPath(projectPath);
    if (!opened) return false;

    set({
      doc: projectToDocument(opened.project, opened.assets),
      history: { past: [], future: [] },
      projectPath: opened.projectPath,
      projectName: opened.project.meta.name,
      createdAt: opened.project.meta.createdAt,
      lastSavedAt: opened.project.meta.updatedAt,
      dirty: false
    });
    return true;
  },

  saveProject: async () => {
    const state = get();
    const payload = documentToProject(state.doc, state.projectName, state.createdAt);
    const saved = await window.storyBridge.saveProject(payload, state.projectPath);
    if (!saved) return;

    set({
      projectPath: saved.projectPath,
      lastSavedAt: saved.savedAt,
      dirty: false
    });
  },

  saveProjectAs: async () => {
    const state = get();
    const payload = documentToProject(state.doc, state.projectName, state.createdAt);
    const saved = await window.storyBridge.saveProjectAs(payload);
    if (!saved) return;

    set({
      projectPath: saved.projectPath,
      lastSavedAt: saved.savedAt,
      dirty: false
    });
  },

  autosaveProject: async () => {
    const state = get();
    const payload = documentToProject(state.doc, state.projectName, state.createdAt);
    await window.storyBridge.autosaveProject(payload);
  },

  updateProjectName: (projectName) => {
    const normalized = projectName.trim();
    const nextName = normalized.length > 0 ? normalized : "Untitled Project";

    set((state) => {
      if (state.projectName === nextName) return state;

      return {
        projectName: nextName,
        dirty: true
      };
    });
  }
}));
