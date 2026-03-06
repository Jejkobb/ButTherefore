import { memo, useCallback, useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
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
const MIN_NODE_HEIGHT = 68;

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

interface ImageFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ImageLayoutRect {
  x: number;
  y: number;
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

  const nodeStyles = window.getComputedStyle(nodeSurface);
  const paddingTop = parsePixels(nodeStyles.paddingTop);
  const paddingBottom = parsePixels(nodeStyles.paddingBottom);

  const beatsHeight = beatsContainer ? beatsContainer.scrollHeight : 0;

  return Math.ceil(Math.max(MIN_NODE_HEIGHT, beatsHeight + paddingTop + paddingBottom));
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

function readImageFrameRect(nodeSurface: HTMLDivElement | null, nodeSize: { width: number; height: number }): ImageFrameRect {
  if (!nodeSurface) {
    return { x: 0, y: 0, width: nodeSize.width, height: nodeSize.height };
  }

  const beatsContainer = nodeSurface.querySelector<HTMLElement>(".story-node__beats");
  const nodeStyles = window.getComputedStyle(nodeSurface);
  const paddingTop = parsePixels(nodeStyles.paddingTop);
  const paddingRight = parsePixels(nodeStyles.paddingRight);
  const paddingBottom = parsePixels(nodeStyles.paddingBottom);
  const paddingLeft = parsePixels(nodeStyles.paddingLeft);
  const rowGap = parsePixels(nodeStyles.rowGap || nodeStyles.gap);
  const beatsHeight = beatsContainer ? beatsContainer.scrollHeight : 0;
  const hasBeats = beatsHeight > 0;
  const top = paddingTop + beatsHeight + (hasBeats ? rowGap : 0);

  return {
    x: paddingLeft,
    y: top,
    width: Math.max(1, nodeSize.width - paddingLeft - paddingRight),
    height: Math.max(1, nodeSize.height - top - paddingBottom)
  };
}

function readAttachedImageIds(nodes: Array<{ id: string; type?: string; parentId?: string }>, parentId: string): string[] {
  return nodes
    .filter((node) => node.type === "imageNode" && node.parentId === parentId)
    .map((node) => node.id);
}

function pickBestGrid(count: number, frameWidth: number, frameHeight: number): { cols: number; rows: number } {
  let bestCols = 1;
  let bestRows = count;
  let bestArea = -1;
  let bestMinEdge = -1;

  for (let cols = 1; cols <= count; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cellWidth = frameWidth / cols;
    const cellHeight = frameHeight / rows;
    const area = cellWidth * cellHeight;
    const minEdge = Math.min(cellWidth, cellHeight);

    if (area > bestArea || (area === bestArea && minEdge > bestMinEdge)) {
      bestArea = area;
      bestMinEdge = minEdge;
      bestCols = cols;
      bestRows = rows;
    }
  }

  return { cols: bestCols, rows: bestRows };
}

function computeAttachedImageLayouts(imageIds: string[], frame: ImageFrameRect): Map<string, ImageLayoutRect> {
  const layouts = new Map<string, ImageLayoutRect>();
  if (imageIds.length === 0) return layouts;

  if (imageIds.length === 1) {
    layouts.set(imageIds[0], {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: frame.height
    });
    return layouts;
  }

  const { cols, rows } = pickBestGrid(imageIds.length, frame.width, frame.height);
  const desiredGap = 6;
  const gapX = cols > 1 ? Math.max(0, Math.min(desiredGap, (frame.width - cols) / (cols - 1))) : 0;
  const gapY = rows > 1 ? Math.max(0, Math.min(desiredGap, (frame.height - rows) / (rows - 1))) : 0;
  const cellWidth = Math.max(1, (frame.width - gapX * (cols - 1)) / cols);
  const cellHeight = Math.max(1, (frame.height - gapY * (rows - 1)) / rows);

  imageIds.forEach((imageId, index) => {
    const row = Math.floor(index / cols);
    const col = index % cols;
    layouts.set(imageId, {
      x: frame.x + col * (cellWidth + gapX),
      y: frame.y + row * (cellHeight + gapY),
      width: cellWidth,
      height: cellHeight
    });
  });

  return layouts;
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

  const updateBeatLine = useGraphStore((state) => state.updateBeatLine);
  const attachImagesToNode = useGraphStore((state) => state.attachImagesToNode);
  const attachedImageCount = useGraphStore(
    (state) => state.doc.nodes.filter((node) => node.type === "imageNode" && node.parentId === id).length
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

  const syncAttachedImagesToFrame = useCallback(
    (nodeSizeOverride?: { width: number; height: number }) => {
      const nodeSurface = nodeSurfaceRef.current;
      const state = useGraphStore.getState();
      const node = state.doc.nodes.find((candidate) => candidate.id === id);
      if (!node) return;

      const nodeSize = nodeSizeOverride ?? readNodeSize(node);
      const frame = readImageFrameRect(nodeSurface, nodeSize);
      const attachedImageIds = readAttachedImageIds(state.doc.nodes, id);
      const layouts = computeAttachedImageLayouts(attachedImageIds, frame);
      let changed = false;

      const nextNodes = state.doc.nodes.map((candidate) => {
        const layout = layouts.get(candidate.id);
        if (!layout) return candidate;
        const currentSize = readNodeSize(candidate);
        if (
          candidate.position.x === layout.x &&
          candidate.position.y === layout.y &&
          currentSize.width === layout.width &&
          currentSize.height === layout.height &&
          candidate.draggable === false
        ) {
          return candidate;
        }

        changed = true;
        return {
          ...candidate,
          position: { x: layout.x, y: layout.y },
          draggable: false,
          style: {
            ...(candidate.style ?? {}),
            width: layout.width,
            height: layout.height
          }
        };
      });

      if (!changed) return;

      useGraphStore.setState({
        doc: {
          ...state.doc,
          nodes: nextNodes
        }
      });
    },
    [id]
  );

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
    syncAttachedImagesToFrame();
  }, [data.beats, growNodeToFitContent, resizeBeatField, syncAttachedImagesToFrame]);

  useEffect(() => {
    syncAttachedImagesToFrame();
  }, [attachedImageCount, syncAttachedImagesToFrame]);

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
    syncAttachedImagesToFrame();
  }, [editingBeatIndex, scheduleNodeInternalsUpdate, syncAttachedImagesToFrame]);

  useEffect(() => {
    return () => {
      if (pendingInternalsFrame.current !== null) {
        cancelAnimationFrame(pendingInternalsFrame.current);
      }
    };
  }, []);

  const applyLiveResize = useCallback((next: NodeRectSnapshot) => {
    const frame = readImageFrameRect(nodeSurfaceRef.current, { width: next.width, height: next.height });
    useGraphStore.setState((state) => {
      const attachedImageIds = readAttachedImageIds(state.doc.nodes, id);
      const layouts = computeAttachedImageLayouts(attachedImageIds, frame);

      return {
        doc: {
          ...state.doc,
          nodes: state.doc.nodes.map((node) => {
            if (node.id === id) {
              return {
                ...node,
                position: { ...node.position, x: next.x },
                style: {
                  ...(node.style ?? {}),
                  width: next.width,
                  height: next.height
                }
              };
            }

            const layout = layouts.get(node.id);
            if (layout) {
              return {
                ...node,
                position: { x: layout.x, y: layout.y },
                draggable: false,
                style: {
                  ...(node.style ?? {}),
                  width: layout.width,
                  height: layout.height
                }
              };
            }

            return node;
          })
        }
      };
    });
  }, [id]);

  const commitResize = useCallback((previous: NodeRectSnapshot, next: NodeRectSnapshot) => {
    if (previous.x === next.x && previous.width === next.width && previous.height === next.height) {
      return;
    }
    const previousFrame = readImageFrameRect(nodeSurfaceRef.current, { width: previous.width, height: previous.height });
    const nextFrame = readImageFrameRect(nodeSurfaceRef.current, { width: next.width, height: next.height });

    useGraphStore.getState().executeCommand({
      label: "Resize Node",
      redo: (doc) => ({
        ...doc,
        nodes: (() => {
          const layouts = computeAttachedImageLayouts(readAttachedImageIds(doc.nodes, id), nextFrame);
          return doc.nodes.map((node) => {
            if (node.id === id) {
              return {
                ...node,
                position: { ...node.position, x: next.x },
                style: {
                  ...(node.style ?? {}),
                  width: next.width,
                  height: next.height
                }
              };
            }

            const layout = layouts.get(node.id);
            if (layout) {
              return {
                ...node,
                position: { x: layout.x, y: layout.y },
                draggable: false,
                style: {
                  ...(node.style ?? {}),
                  width: layout.width,
                  height: layout.height
                }
              };
            }

            return node;
          });
        })()
      }),
      undo: (doc) => ({
        ...doc,
        nodes: (() => {
          const layouts = computeAttachedImageLayouts(readAttachedImageIds(doc.nodes, id), previousFrame);
          return doc.nodes.map((node) => {
            if (node.id === id) {
              return {
                ...node,
                position: { ...node.position, x: previous.x },
                style: {
                  ...(node.style ?? {}),
                  width: previous.width,
                  height: previous.height
                }
              };
            }

            const layout = layouts.get(node.id);
            if (layout) {
              return {
                ...node,
                position: { x: layout.x, y: layout.y },
                draggable: false,
                style: {
                  ...(node.style ?? {}),
                  width: layout.width,
                  height: layout.height
                }
              };
            }

            return node;
          });
        })()
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
    const beatMinimumHeight = readBeatTextMinimumHeight(nodeSurfaceRef.current);

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
      minHeight: Math.min(beatMinimumHeight, height)
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
            </div>
          ))}
        </div>
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
