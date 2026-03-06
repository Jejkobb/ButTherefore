import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ConnectionLineType,
  Controls,
  SelectionMode,
  type FinalConnectionState,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type OnConnectStartParams,
  type NodeDragHandler,
  type Viewport,
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

function eventToClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } {
  if ("touches" in event && event.touches.length > 0) {
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }

  if ("changedTouches" in event && event.changedTouches.length > 0) {
    return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY };
  }

  return { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY };
}

function isSameViewport(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

function Editor() {
  const flow = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const dragStartPositions = useRef<Record<string, XYPosition>>({});
  const connectStartRef = useRef<OnConnectStartParams | null>(null);

  const doc = useGraphStore((state) => state.doc);
  const history = useGraphStore((state) => state.history);
  const projectPath = useGraphStore((state) => state.projectPath);
  const dirty = useGraphStore((state) => state.dirty);

  const applyNodeChangesLive = useGraphStore((state) => state.applyNodeChangesLive);
  const applyEdgeChangesLive = useGraphStore((state) => state.applyEdgeChangesLive);
  const setViewport = useGraphStore((state) => state.setViewport);
  const connectNodes = useGraphStore((state) => state.connectNodes);
  const createNodeFromConnection = useGraphStore((state) => state.createNodeFromConnection);
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

  const createNodeAtViewportCenter = useCallback(() => {
    const bounds = wrapperRef.current?.getBoundingClientRect();
    const center = flow.screenToFlowPosition({
      x: (bounds?.left ?? 0) + (bounds?.width ?? window.innerWidth) / 2,
      y: (bounds?.top ?? 0) + (bounds?.height ?? window.innerHeight) / 2
    });
    createNode(center);
  }, [createNode, flow]);

  const frameAllNodes = useCallback(() => {
    if (useGraphStore.getState().doc.nodes.length === 0) return;
    void flow.fitView({
      padding: 0.22,
      duration: 180,
      includeHiddenNodes: true
    });
  }, [flow]);

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
    // Browser/electron can occasionally miss drag-stop if pointer-up occurs outside the window.
    const forceStopDrag = () => {
      if (Object.keys(dragStartPositions.current).length === 0) return;
      commitNodeMove(dragStartPositions.current);
      dragStartPositions.current = {};
    };

    window.addEventListener("pointerup", forceStopDrag);
    window.addEventListener("pointercancel", forceStopDrag);
    window.addEventListener("mouseup", forceStopDrag);
    window.addEventListener("touchend", forceStopDrag);
    window.addEventListener("blur", forceStopDrag);

    return () => {
      window.removeEventListener("pointerup", forceStopDrag);
      window.removeEventListener("pointercancel", forceStopDrag);
      window.removeEventListener("mouseup", forceStopDrag);
      window.removeEventListener("touchend", forceStopDrag);
      window.removeEventListener("blur", forceStopDrag);
    };
  }, [commitNodeMove]);

  useEffect(() => {
    const currentViewport = flow.getViewport();
    if (isSameViewport(currentViewport, doc.viewport)) return;
    void flow.setViewport(doc.viewport, { duration: 0 });
  }, [doc.viewport, flow]);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      const connectStart = connectStartRef.current;
      connectStartRef.current = null;

      if (!connectStart || connectStart.handleType !== "source" || !connectStart.nodeId || connectionState.isValid) {
        return;
      }

      const flowPosition = flow.screenToFlowPosition(eventToClientPosition(event));

      createNodeFromConnection(connectStart.nodeId, connectStart.handleId, flowPosition);
    },
    [createNodeFromConnection, flow]
  );

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

      if (!modKey && event.key === "Home") {
        event.preventDefault();
        frameAllNodes();
        return;
      }

      if (!modKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        createNodeAtViewportCenter();
        return;
      }

      if (!modKey && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        deleteSelection();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createNodeAtViewportCenter, deleteSelection, frameAllNodes, openProject, redo, saveProject, undo]);

  return (
    <div className="app-shell">
      <header className="app-toolbar">
        <div className="app-toolbar__brand">ButTherefore</div>
        <div className="app-toolbar__actions">
          <button onClick={createNodeAtViewportCenter} type="button">+ Node</button>
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
          onConnectStart={(_event, params) => {
            connectStartRef.current = params;
          }}
          onConnectEnd={onConnectEnd}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          connectionMode={ConnectionMode.Loose}
          connectionLineType={ConnectionLineType.Bezier}
          panOnDrag={[1]}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          deleteKeyCode={null}
          snapToGrid={false}
          minZoom={0.25}
          maxZoom={2.2}
          onlyRenderVisibleElements
          fitView={false}
          defaultViewport={doc.viewport}
          onMoveEnd={(_event, nextViewport) => {
            setViewport(nextViewport);
          }}
          onPaneDoubleClick={(event) => {
            const position = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
            createNode(position);
          }}
          defaultEdgeOptions={{
            type: "storyEdge",
            animated: false
          }}
        >
          <Background variant={BackgroundVariant.Dots} gap={30} size={1.15} color="rgba(255, 255, 255, 0.14)" />
          <Controls className="flow-controls" showInteractive={false} />
          <MiniMap
            className="flow-minimap"
            pannable
            zoomable
            nodeColor={() => "rgba(210, 210, 210, 0.7)"}
            maskColor="rgba(5, 5, 5, 0.76)"
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
