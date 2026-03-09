import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useReactFlow, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { PostItNodeData } from "@/shared/types";
import { useGraphStore } from "@/renderer/store/useGraphStore";

const MIN_POSTIT_WIDTH = 220;
const MIN_POSTIT_HEIGHT = 180;

type ResizeCorner = "bl" | "br";

interface ResizeSession {
  pointerId: number;
  corner: ResizeCorner;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startWidth: number;
  startHeight: number;
  zoom: number;
}

interface NodeRectSnapshot {
  x: number;
  width: number;
  height: number;
}

function parsePixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNodeSize(node: { width?: number; height?: number; style?: Record<string, unknown> }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  const width = styleWidth ?? (typeof node.width === "number" ? node.width : MIN_POSTIT_WIDTH);
  const height = styleHeight ?? (typeof node.height === "number" ? node.height : MIN_POSTIT_HEIGHT);
  return { width, height };
}

export const PostItNode = memo(function PostItNode({ id, data }: NodeProps<PostItNodeData>) {
  const updatePostItNote = useGraphStore((state) => state.updatePostItNote);
  const flow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const [isEditing, setIsEditing] = useState(false);
  const nodeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const contentRef = useRef<HTMLElement | null>(null);
  const pendingInternalsFrame = useRef<number | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);

  const scheduleNodeInternalsUpdate = useCallback(() => {
    if (pendingInternalsFrame.current !== null) return;
    pendingInternalsFrame.current = requestAnimationFrame(() => {
      pendingInternalsFrame.current = null;
      updateNodeInternals(id);
    });
  }, [id, updateNodeInternals]);

  const resizeNoteField = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.max(120, element.scrollHeight)}px`;
  }, []);

  const growNodeToFitContent = useCallback(() => {
    const nodeSurface = nodeSurfaceRef.current;
    const content = contentRef.current;
    if (!nodeSurface || !content) return;

    const nodeStyles = window.getComputedStyle(nodeSurface);
    const paddingTop = parsePixels(nodeStyles.paddingTop);
    const paddingBottom = parsePixels(nodeStyles.paddingBottom);
    const requiredHeight = Math.ceil(Math.max(MIN_POSTIT_HEIGHT, content.scrollHeight + paddingTop + paddingBottom));
    const node = useGraphStore.getState().doc.nodes.find((candidate) => candidate.id === id);
    if (!node) return;

    const { height } = readNodeSize(node);
    if (requiredHeight <= height) return;

    useGraphStore.setState((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((candidate) => {
          if (candidate.id !== id) return candidate;
          return {
            ...candidate,
            style: {
              ...(candidate.style ?? {}),
              height: requiredHeight
            }
          };
        })
      }
    }));

    scheduleNodeInternalsUpdate();
  }, [id, scheduleNodeInternalsUpdate]);

  useEffect(() => {
    resizeNoteField(textareaRef.current);
    growNodeToFitContent();
    scheduleNodeInternalsUpdate();
  }, [data.note, growNodeToFitContent, isEditing, resizeNoteField, scheduleNodeInternalsUpdate]);

  useEffect(() => {
    if (!isEditing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [isEditing]);

  useEffect(() => {
    return () => {
      if (pendingInternalsFrame.current !== null) {
        cancelAnimationFrame(pendingInternalsFrame.current);
      }
    };
  }, []);

  const applyLiveResize = useCallback((next: NodeRectSnapshot) => {
    useGraphStore.setState((state) => ({
      doc: {
        ...state.doc,
        nodes: state.doc.nodes.map((node) => {
          if (node.id !== id) return node;
          return {
            ...node,
            position: { ...node.position, x: next.x },
            style: {
              ...(node.style ?? {}),
              width: next.width,
              height: next.height
            }
          };
        })
      }
    }));
  }, [id]);

  const commitResize = useCallback((previous: NodeRectSnapshot, next: NodeRectSnapshot) => {
    if (previous.x === next.x && previous.width === next.width && previous.height === next.height) {
      return;
    }

    useGraphStore.getState().executeCommand({
      label: "Resize Note",
      redo: (doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
          if (node.id !== id) return node;
          return {
            ...node,
            position: { ...node.position, x: next.x },
            style: {
              ...(node.style ?? {}),
              width: next.width,
              height: next.height
            }
          };
        })
      }),
      undo: (doc) => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
          if (node.id !== id) return node;
          return {
            ...node,
            position: { ...node.position, x: previous.x },
            style: {
              ...(node.style ?? {}),
              width: previous.width,
              height: previous.height
            }
          };
        })
      })
    });
  }, [id]);

  const startResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, corner: ResizeCorner) => {
    event.preventDefault();
    event.stopPropagation();

    const node = useGraphStore.getState().doc.nodes.find((candidate) => candidate.id === id);
    if (!node) return;

    const zoom = Math.max(flow.getZoom(), 0.01);
    const measuredRect = nodeSurfaceRef.current?.getBoundingClientRect();
    const measuredWidth = measuredRect ? measuredRect.width / zoom : null;
    const measuredHeight = measuredRect ? measuredRect.height / zoom : null;
    const fallbackSize = readNodeSize(node);
    const width = measuredWidth ?? fallbackSize.width;
    const height = measuredHeight ?? fallbackSize.height;
    const start: NodeRectSnapshot = {
      x: node.position.x,
      width,
      height
    };

    resizeSessionRef.current = {
      pointerId: event.pointerId,
      corner,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startNodeX: node.position.x,
      startWidth: width,
      startHeight: height,
      zoom
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const session = resizeSessionRef.current;
      if (!session || moveEvent.pointerId !== session.pointerId) return;

      const dx = (moveEvent.clientX - session.startClientX) / session.zoom;
      const dy = (moveEvent.clientY - session.startClientY) / session.zoom;

      let nextWidth = session.startWidth;
      let nextHeight = Math.max(MIN_POSTIT_HEIGHT, session.startHeight + dy);
      let nextX = session.startNodeX;

      if (session.corner === "br") {
        nextWidth = Math.max(MIN_POSTIT_WIDTH, session.startWidth + dx);
      } else {
        nextWidth = Math.max(MIN_POSTIT_WIDTH, session.startWidth - dx);
        nextX = session.startNodeX + (session.startWidth - nextWidth);
      }

      applyLiveResize({ x: nextX, width: nextWidth, height: nextHeight });
      scheduleNodeInternalsUpdate();
    };

    const stopResize = (upEvent: PointerEvent) => {
      const session = resizeSessionRef.current;
      if (!session || upEvent.pointerId !== session.pointerId) return;

      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);

      const current = useGraphStore.getState().doc.nodes.find((candidate) => candidate.id === id);
      if (current) {
        const currentSize = readNodeSize(current);
        const next: NodeRectSnapshot = {
          x: current.position.x,
          width: currentSize.width,
          height: currentSize.height
        };
        commitResize(start, next);
      }

      resizeSessionRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [applyLiveResize, commitResize, flow, id, scheduleNodeInternalsUpdate]);

  return (
    <div className="postit-node-shell">
      <div className="postit-node" ref={nodeSurfaceRef}>
        <div className="postit-node__resize-zone postit-node__resize-zone--bl nodrag nopan" onPointerDown={(event) => startResize(event, "bl")} />
        <div className="postit-node__resize-zone postit-node__resize-zone--br nodrag nopan" onPointerDown={(event) => startResize(event, "br")} />
        {isEditing ? (
          <textarea
            ref={(element) => {
              textareaRef.current = element;
              contentRef.current = element;
            }}
            className="postit-node__text nodrag"
            value={data.note}
            onChange={(event) => {
              updatePostItNote(id, event.target.value);
              resizeNoteField(event.currentTarget);
              growNodeToFitContent();
            }}
            placeholder="Note..."
            rows={8}
            spellCheck={false}
            onInput={(event) => {
              resizeNoteField(event.currentTarget);
              growNodeToFitContent();
            }}
            onBlur={() => setIsEditing(false)}
            onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setIsEditing(false);
              }
            }}
          />
        ) : (
          <div
            ref={(element) => {
              contentRef.current = element;
            }}
            className={`postit-node__display ${data.note ? "" : "is-empty"}`}
            onDoubleClick={(event) => {
              event.stopPropagation();
              setIsEditing(true);
            }}
            title="Double-click to edit"
          >
            {data.note || "Note..."}
          </div>
        )}
      </div>
    </div>
  );
});

PostItNode.displayName = "PostItNode";
