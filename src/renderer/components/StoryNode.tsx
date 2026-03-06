import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Handle, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { StoryNodeData } from "@/shared/types";
import { useGraphStore } from "@/renderer/store/useGraphStore";

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;

  try {
    const parsed = new URL(uri);
    let resolvedPath = decodeURIComponent(parsed.pathname);

    if (/^\/[A-Za-z]:/.test(resolvedPath)) {
      resolvedPath = resolvedPath.slice(1);
    }

    if (parsed.hostname) {
      return `\\\\${parsed.hostname}${resolvedPath.replace(/\//g, "\\")}`;
    }

    return resolvedPath.replace(/\//g, "\\");
  } catch {
    return null;
  }
}

function extractDroppedPaths(event: DragEvent<HTMLDivElement>): string[] {
  const paths = new Set<string>();

  for (const file of Array.from(event.dataTransfer.files)) {
    const nativePath = (file as File & { path?: string }).path;
    if (nativePath) {
      paths.add(nativePath);
    }
  }

  const uriList = event.dataTransfer.getData("text/uri-list");
  if (uriList) {
    for (const line of uriList.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const nativePath = fileUriToPath(trimmed);
      if (nativePath) {
        paths.add(nativePath);
      }
    }
  }

  return Array.from(paths);
}

const MIN_NODE_WIDTH = 320;
const MIN_NODE_HEIGHT = 60;

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
  minWidth: number;
  minHeight: number;
}

interface NodeRectSnapshot {
  x: number;
  width: number;
  height: number;
}

function readNodeSize(node: { width?: number; height?: number; style?: Record<string, unknown> }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  const width = styleWidth ?? (typeof node.width === "number" ? node.width : MIN_NODE_WIDTH);
  const height = styleHeight ?? (typeof node.height === "number" ? node.height : MIN_NODE_HEIGHT);
  return { width, height };
}

function parsePixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNodeContentRequiredHeight(nodeSurface: HTMLDivElement | null): number {
  if (!nodeSurface) return MIN_NODE_HEIGHT;

  const beatsContainer = nodeSurface.querySelector<HTMLElement>(".story-node__beats");
  const imagesContainer = nodeSurface.querySelector<HTMLElement>(".story-node__images");

  const nodeStyles = window.getComputedStyle(nodeSurface);
  const paddingTop = parsePixels(nodeStyles.paddingTop);
  const paddingBottom = parsePixels(nodeStyles.paddingBottom);
  const rowGap = parsePixels(nodeStyles.rowGap || nodeStyles.gap);

  const beatsHeight = beatsContainer ? beatsContainer.scrollHeight : 0;
  const imagesHeight = imagesContainer ? imagesContainer.scrollHeight : 0;
  const gapHeight = beatsContainer && imagesContainer ? rowGap : 0;

  return Math.ceil(Math.max(MIN_NODE_HEIGHT, beatsHeight + imagesHeight + gapHeight + paddingTop + paddingBottom));
}

function readBeatTextMinimumHeight(nodeSurface: HTMLDivElement | null): number {
  if (!nodeSurface) return MIN_NODE_HEIGHT;

  const beatsContainer = nodeSurface.querySelector<HTMLElement>(".story-node__beats");
  if (!beatsContainer) return MIN_NODE_HEIGHT;

  const nodeStyles = window.getComputedStyle(nodeSurface);
  const paddingTop = parsePixels(nodeStyles.paddingTop);
  const paddingBottom = parsePixels(nodeStyles.paddingBottom);

  return Math.ceil(beatsContainer.scrollHeight + paddingTop + paddingBottom);
}

export const StoryNode = memo(function StoryNode({ id, data }: NodeProps<StoryNodeData>) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [editingBeatIndex, setEditingBeatIndex] = useState<number | null>(null);
  const beatRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());
  const nodeSurfaceRef = useRef<HTMLDivElement | null>(null);
  const pendingInternalsFrame = useRef<number | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const flow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();

  const assets = useGraphStore((state) => state.doc.assets);
  const updateBeatLine = useGraphStore((state) => state.updateBeatLine);
  const removeBeatLine = useGraphStore((state) => state.removeBeatLine);
  const attachImagesToNode = useGraphStore((state) => state.attachImagesToNode);

  const images = useMemo(
    () => data.imageAssetIds.map((assetId) => assets[assetId]).filter(Boolean),
    [data.imageAssetIds, assets]
  );

  const importImagePaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    await attachImagesToNode(id, paths);
  };

  const scheduleNodeInternalsUpdate = useCallback(() => {
    if (pendingInternalsFrame.current !== null) return;

    pendingInternalsFrame.current = requestAnimationFrame(() => {
      pendingInternalsFrame.current = null;
      updateNodeInternals(id);
    });
  }, [id, updateNodeInternals]);

  const growNodeToFitContent = useCallback(() => {
    const nodeSurface = nodeSurfaceRef.current;
    if (!nodeSurface) return;

    const requiredHeight = readNodeContentRequiredHeight(nodeSurface);
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

  const resizeBeatField = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element) return;

      element.style.height = "0px";
      element.style.height = `${Math.max(34, element.scrollHeight)}px`;

      scheduleNodeInternalsUpdate();
    },
    [scheduleNodeInternalsUpdate]
  );

  useEffect(() => {
    beatRefs.current.forEach((element) => resizeBeatField(element));
    growNodeToFitContent();
  }, [data.beats, growNodeToFitContent, resizeBeatField]);

  useEffect(() => {
    growNodeToFitContent();
    scheduleNodeInternalsUpdate();
  }, [growNodeToFitContent, images.length, scheduleNodeInternalsUpdate]);

  useEffect(() => {
    if (editingBeatIndex === null) return;
    const textarea = beatRefs.current.get(editingBeatIndex);
    if (!textarea) return;
    textarea.focus();
    const length = textarea.value.length;
    textarea.setSelectionRange(length, length);
  }, [editingBeatIndex, data.beats]);

  useEffect(() => {
    scheduleNodeInternalsUpdate();
  }, [editingBeatIndex, scheduleNodeInternalsUpdate]);

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
      label: "Resize Node",
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
      zoom,
      minWidth: Math.min(MIN_NODE_WIDTH, width),
      minHeight: Math.min(readBeatTextMinimumHeight(nodeSurfaceRef.current), height)
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const session = resizeSessionRef.current;
      if (!session || moveEvent.pointerId !== session.pointerId) return;

      const dx = (moveEvent.clientX - session.startClientX) / session.zoom;
      const dy = (moveEvent.clientY - session.startClientY) / session.zoom;

      let nextWidth = session.startWidth;
      let nextHeight = Math.max(session.minHeight, session.startHeight + dy);
      let nextX = session.startNodeX;

      if (session.corner === "br") {
        nextWidth = Math.max(session.minWidth, session.startWidth + dx);
      } else {
        nextWidth = Math.max(session.minWidth, session.startWidth - dx);
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
    <div
      className={`story-node-shell ${isDragOver ? "is-drag-over" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragOver(false);
        void importImagePaths(extractDroppedPaths(event));
      }}
    >
      <div className="story-node" ref={nodeSurfaceRef}>
        <div className="story-node__resize-zone story-node__resize-zone--bl nodrag nopan" onPointerDown={(event) => startResize(event, "bl")} />
        <div className="story-node__resize-zone story-node__resize-zone--br nodrag nopan" onPointerDown={(event) => startResize(event, "br")} />
        <Handle className="story-handle story-handle--left" type="source" position={Position.Left} id="in" />

        <div className="story-node__beats">
          {data.beats.map((line, index) => (
            <div className="story-node__beat-row" key={`${id}-beat-${index}`}>
              {editingBeatIndex === index ? (
                <textarea
                  className="story-node__beat nodrag"
                  value={line}
                  onChange={(event) => updateBeatLine(id, index, event.target.value)}
                  onInput={(event) => {
                    resizeBeatField(event.currentTarget);
                    growNodeToFitContent();
                  }}
                  onBlur={() => setEditingBeatIndex((current) => (current === index ? null : current))}
                  onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingBeatIndex(null);
                    }
                  }}
                  placeholder={`Beat ${index + 1}`}
                  rows={1}
                  spellCheck={false}
                  ref={(element) => {
                    if (element) {
                      beatRefs.current.set(index, element);
                      resizeBeatField(element);
                    } else {
                      beatRefs.current.delete(index);
                    }
                  }}
                />
              ) : (
                <div
                  className={`story-node__beat story-node__beat--display ${line ? "" : "is-empty"}`}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    setEditingBeatIndex(index);
                  }}
                >
                  {line || `Beat ${index + 1}`}
                </div>
              )}
              <button
                className="story-node__icon-button nodrag"
                onClick={() => removeBeatLine(id, index)}
                type="button"
                title="Remove beat"
                disabled={data.beats.length <= 1}
              >
                x
              </button>
            </div>
          ))}
        </div>

        {images.length > 0 ? (
          <div className="story-node__images">
            {images.map((asset) => (
              <img
                key={asset.id}
                className="story-node__thumb"
                src={asset.uri}
                alt={asset.fileName}
                draggable={false}
                loading="lazy"
                decoding="async"
                onLoad={() => {
                  // Images can change node height dynamically, so we refresh internals after each load.
                  growNodeToFitContent();
                  scheduleNodeInternalsUpdate();
                }}
              />
            ))}
          </div>
        ) : null}

        <Handle className="story-handle story-handle--right" type="source" position={Position.Right} id="out" />
      </div>
      <button
        className="story-node__image-fab nodrag nopan"
        onClick={async () => {
          const filePaths = await window.storyBridge.pickImageFiles();
          await importImagePaths(filePaths);
        }}
        type="button"
        aria-label="Add image"
        title="Add image"
      >
        +
      </button>
    </div>
  );
});

StoryNode.displayName = "StoryNode";
