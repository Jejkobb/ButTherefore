import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeDragHandler,
  type XYPosition
} from "@xyflow/react";
import { StoryEdge } from "@/renderer/components/StoryEdge";
import { StoryNode } from "@/renderer/components/StoryNode";
import { useGraphStore } from "@/renderer/store/useGraphStore";

const nodeTypes = { storyNode: StoryNode };
const edgeTypes = { storyEdge: StoryEdge };

function getDisplayName(projectPath: string | null): string {
  if (!projectPath) return "Untitled Project";
  const parts = projectPath.split(/[\\/]/);
  return parts[parts.length - 1];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return target.isContentEditable || tag === "input" || tag === "textarea" || tag === "select";
}

function Editor() {
  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragStartPositions = useRef<Record<string, XYPosition>>({});

  const doc = useGraphStore((state) => state.doc);
  const history = useGraphStore((state) => state.history);
  const projectPath = useGraphStore((state) => state.projectPath);
  const dirty = useGraphStore((state) => state.dirty);

  const applyNodeChangesLive = useGraphStore((state) => state.applyNodeChangesLive);
  const applyEdgeChangesLive = useGraphStore((state) => state.applyEdgeChangesLive);
  const setViewport = useGraphStore((state) => state.setViewport);
  const connectNodes = useGraphStore((state) => state.connectNodes);
  const commitNodeMove = useGraphStore((state) => state.commitNodeMove);
  const createNode = useGraphStore((state) => state.createNode);
  const deleteSelection = useGraphStore((state) => state.deleteSelection);
  const undo = useGraphStore((state) => state.undo);
  const redo = useGraphStore((state) => state.redo);
  const newProject = useGraphStore((state) => state.newProject);
  const openProject = useGraphStore((state) => state.openProject);
  const saveProject = useGraphStore((state) => state.saveProject);
  const saveProjectAs = useGraphStore((state) => state.saveProjectAs);
  const autosaveProject = useGraphStore((state) => state.autosaveProject);

  const toolbarTitle = useMemo(() => `${getDisplayName(projectPath)}${dirty ? " *" : ""}`, [projectPath, dirty]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (dirty) {
        void autosaveProject();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [dirty, doc, autosaveProject]);

  const onNodeDragStart: NodeDragHandler = useCallback((_event, node) => {
    const currentNodes = useGraphStore.getState().doc.nodes;
    const draggedNodes = currentNodes.filter((candidate) => candidate.selected || candidate.id === node.id);

    dragStartPositions.current = draggedNodes.reduce<Record<string, XYPosition>>((acc, candidate) => {
      acc[candidate.id] = { ...candidate.position };
      return acc;
    }, {});
  }, []);

  const onNodeDragStop: NodeDragHandler = useCallback(() => {
    commitNodeMove(dragStartPositions.current);
    dragStartPositions.current = {};
  }, [commitNodeMove]);

  useEffect(() => {
    // Global shortcuts: N, Delete, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl/Cmd+S, Ctrl/Cmd+O.
    const onKeyDown = (event: KeyboardEvent) => {
      const targetTyping = isTypingTarget(event.target);
      const modKey = event.metaKey || event.ctrlKey;

      if (modKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
        return;
      }

      if (modKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openProject();
        return;
      }

      if (modKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          redo();
        } else {
          undo();
        }
        return;
      }

      if (targetTyping) return;

      if (!modKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        const bounds = wrapperRef.current?.getBoundingClientRect();
        const center = flow.screenToFlowPosition({
          x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2,
          y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2
        });
        createNode(center);
        return;
      }

      if (!modKey && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createNode, deleteSelection, flow, openProject, redo, saveProject, undo]);

  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <div className="app-toolbar__brand">Story Beat Node Editor</div>
        <div className="app-toolbar__actions">
          <button onClick={() => void newProject()} type="button">New</button>
          <button onClick={() => void openProject()} type="button">Open</button>
          <button onClick={() => void saveProject()} type="button">Save</button>
          <button onClick={() => void saveProjectAs()} type="button">Save As</button>
          <button onClick={undo} type="button" disabled={history.past.length === 0}>Undo</button>
          <button onClick={redo} type="button" disabled={history.future.length === 0}>Redo</button>
        </div>
        <div className="app-toolbar__project">{toolbarTitle}</div>
      </header>

      <main className="canvas-shell" ref={wrapperRef}>
        <ReactFlow
          proOptions={{ hideAttribution: true }}
          nodes={doc.nodes}
          edges={doc.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={applyNodeChangesLive}
          onEdgesChange={applyEdgeChangesLive}
          onConnect={connectNodes}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          connectionLineType={ConnectionLineType.Bezier}
          deleteKeyCode={null}
          snapToGrid={false}
          minZoom={0.25}
          maxZoom={2.2}
          fitView={false}
          viewport={doc.viewport}
          onViewportChange={setViewport}
          defaultEdgeOptions={{
            type: "storyEdge",
            animated: false
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={28} size={1.4} color="rgba(130, 146, 176, 0.28)" />
          <Controls className="flow-controls" showInteractive={false} />
          <MiniMap
            className="flow-minimap"
            pannable
            zoomable
            nodeColor={() => "rgba(180, 199, 255, 0.8)"}
            maskColor="rgba(5, 8, 13, 0.72)"
          />
        </ReactFlow>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Editor />
    </ReactFlowProvider>
  );
}
