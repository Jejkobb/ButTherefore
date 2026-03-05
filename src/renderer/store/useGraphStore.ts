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
import { documentToProject, projectToDocument, type GraphDocument, type StoryFlowEdge, type StoryFlowNode } from "@/renderer/domain/project";

interface GraphCommand {
  label: string;
  redo: (doc: GraphDocument) => GraphDocument;
  undo: (doc: GraphDocument) => GraphDocument;
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
  executeCommand: (command: GraphCommand) => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
  applyNodeChangesLive: (changes: NodeChange<StoryFlowNode>[]) => void;
  applyEdgeChangesLive: (changes: EdgeChange<StoryFlowEdge>[]) => void;
  setViewport: (viewport: GraphDocument["viewport"]) => void;
  createNode: (position: XYPosition) => void;
  connectNodes: (connection: Connection) => void;
  commitNodeMove: (previousPositions: Record<string, XYPosition>) => void;
  deleteSelection: () => void;
  updateNodeTitle: (nodeId: string, title: string) => void;
  updateBeatLine: (nodeId: string, index: number, value: string) => void;
  addBeatLine: (nodeId: string) => void;
  removeBeatLine: (nodeId: string, index: number) => void;
  toggleEdgeRelation: (edgeId: string) => void;
  attachImagesToNode: (nodeId: string, filePaths: string[]) => Promise<void>;
  newProject: () => Promise<void>;
  openProject: () => Promise<void>;
  saveProject: () => Promise<void>;
  saveProjectAs: () => Promise<void>;
  autosaveProject: () => Promise<void>;
}

const empty = createEmptyProject();

const initialDoc: GraphDocument = {
  nodes: [],
  edges: [],
  assets: {},
  viewport: empty.viewport
};

function replaceNode(doc: GraphDocument, nodeId: string, updater: (node: StoryFlowNode) => StoryFlowNode): GraphDocument {
  return {
    ...doc,
    nodes: doc.nodes.map((node) => (node.id === nodeId ? updater(node) : node))
  };
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

export const useGraphStore = create<GraphStore>((set, get) => ({
  doc: initialDoc,
  history: { past: [], future: [] },
  projectPath: null,
  projectName: empty.meta.name,
  createdAt: empty.meta.createdAt,
  lastSavedAt: null,
  dirty: false,

  executeCommand: (command) => {
    set((state) => ({
      doc: command.redo(state.doc),
      history: {
        past: [...state.history.past, command],
        future: []
      },
      dirty: true
    }));
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
    set((state) => ({
      doc: {
        ...state.doc,
        nodes: applyNodeChanges(changes, state.doc.nodes)
      }
    }));
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
    set((state) => ({
      doc: {
        ...state.doc,
        viewport
      }
    }));
  },

  createNode: (position) => {
    const node: StoryFlowNode = {
      id: crypto.randomUUID(),
      type: "storyNode",
      position,
      data: {
        title: "Story Beat",
        beats: [""],
        imageAssetIds: []
      }
    };

    get().executeCommand({
      label: "Create Node",
      redo: (doc) => ({ ...doc, nodes: [...doc.nodes, node] }),
      undo: (doc) => ({ ...doc, nodes: doc.nodes.filter((candidate) => candidate.id !== node.id) })
    });
  },

  connectNodes: (connection) => {
    if (!connection.source || !connection.target) return;
    if (edgeExists(get().doc, connection)) return;

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
    const movedIds = Object.keys(previousPositions).filter((id) => {
      const current = doc.nodes.find((node) => node.id === id);
      if (!current) return false;
      const previous = previousPositions[id];
      return current.position.x !== previous.x || current.position.y !== previous.y;
    });

    if (movedIds.length === 0) return;

    const nextPositions = movedIds.reduce<Record<string, XYPosition>>((acc, id) => {
      const current = doc.nodes.find((node) => node.id === id);
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
    const selectedNodeIds = new Set(doc.nodes.filter((node) => node.selected).map((node) => node.id));
    const selectedEdgeIds = new Set(doc.edges.filter((edge) => edge.selected).map((edge) => edge.id));

    if (selectedNodeIds.size === 0 && selectedEdgeIds.size === 0) return;

    const removedNodes = doc.nodes.filter((node) => selectedNodeIds.has(node.id));
    const removedEdges = doc.edges.filter(
      (edge) => selectedEdgeIds.has(edge.id) || selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target)
    );

    get().executeCommand({
      label: "Delete Selection",
      redo: (stateDoc) => ({
        ...stateDoc,
        nodes: stateDoc.nodes.filter((node) => !selectedNodeIds.has(node.id)),
        edges: stateDoc.edges.filter((edge) => !removedEdges.some((candidate) => candidate.id === edge.id))
      }),
      undo: (stateDoc) => ({
        ...stateDoc,
        nodes: [...stateDoc.nodes, ...removedNodes],
        edges: [...stateDoc.edges, ...removedEdges]
      })
    });
  },

  updateNodeTitle: (nodeId, title) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || current.data.title === title) return;

    const previous = current.data.title;

    get().executeCommand({
      label: "Edit Node Title",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => ({
          ...node,
          data: { ...node.data, title }
        })),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => ({
          ...node,
          data: { ...node.data, title: previous }
        }))
    });
  },

  updateBeatLine: (nodeId, index, value) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || current.data.beats[index] === value) return;

    const previous = current.data.beats[index] ?? "";

    get().executeCommand({
      label: "Edit Beat",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          const beats = [...node.data.beats];
          beats[index] = value;
          return { ...node, data: { ...node.data, beats } };
        }),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
          const beats = [...node.data.beats];
          beats[index] = previous;
          return { ...node, data: { ...node.data, beats } };
        })
    });
  },

  addBeatLine: (nodeId) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current) return;

    get().executeCommand({
      label: "Add Beat",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => ({
          ...node,
          data: { ...node.data, beats: [...node.data.beats, ""] }
        })),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => ({
          ...node,
          data: { ...node.data, beats: node.data.beats.slice(0, -1) }
        }))
    });
  },

  removeBeatLine: (nodeId, index) => {
    const current = get().doc.nodes.find((node) => node.id === nodeId);
    if (!current || current.data.beats.length <= 1 || index < 0 || index >= current.data.beats.length) return;

    const removedValue = current.data.beats[index];

    get().executeCommand({
      label: "Remove Beat",
      redo: (doc) =>
        replaceNode(doc, nodeId, (node) => ({
          ...node,
          data: {
            ...node.data,
            beats: node.data.beats.filter((_, beatIndex) => beatIndex !== index)
          }
        })),
      undo: (doc) =>
        replaceNode(doc, nodeId, (node) => {
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
    if (!currentNode) return;

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

    get().executeCommand({
      label: "Attach Images",
      redo: (doc) => ({
        ...doc,
        assets: {
          ...doc.assets,
          ...importedAssetMap
        },
        nodes: doc.nodes.map((node) => {
          if (node.id !== nodeId) return node;
          return {
            ...node,
            data: {
              ...node.data,
              imageAssetIds: [...node.data.imageAssetIds, ...imageAssetIds]
            }
          };
        })
      }),
      undo: (doc) => {
        const nextAssets = { ...doc.assets };
        for (const assetId of imageAssetIds) {
          delete nextAssets[assetId];
        }

        return {
          ...doc,
          assets: nextAssets,
          nodes: doc.nodes.map((node) => {
            if (node.id !== nodeId) return node;
            return {
              ...node,
              data: {
                ...node.data,
                imageAssetIds: node.data.imageAssetIds.filter((assetId) => !imageAssetIds.includes(assetId))
              }
            };
          })
        };
      }
    });
  },

  newProject: async () => {
    await window.storyBridge.newProjectSession();
    const fresh = createEmptyProject();

    set({
      doc: {
        nodes: [],
        edges: [],
        assets: {},
        viewport: fresh.viewport
      },
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
    if (!opened) return;

    set({
      doc: projectToDocument(opened.project, opened.assets),
      history: { past: [], future: [] },
      projectPath: opened.projectPath,
      projectName: opened.project.meta.name,
      createdAt: opened.project.meta.createdAt,
      lastSavedAt: opened.project.meta.updatedAt,
      dirty: false
    });
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
  }
}));
