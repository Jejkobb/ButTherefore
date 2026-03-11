import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useReactFlow, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { PencilLine, X } from "lucide-react";
import type { ImageNodeData } from "@/shared/types";
import { DrawingComposer } from "@/renderer/components/DrawingComposer";
import { useGraphStore } from "@/renderer/store/useGraphStore";

const MIN_IMAGE_WIDTH = 92;
const MIN_IMAGE_HEIGHT = 62;

type ResizeCorner = "bl" | "br";

interface ResizeSession {
  pointerId: number;
  corner: ResizeCorner;
  startClientX: number;
  startClientY: number;
  startNodeX: number;
  startWidth: number;
  zoom: number;
  aspectRatio: number;
}

interface NodeRectSnapshot {
  x: number;
  width: number;
  height: number;
}

function readNodeSize(node: { width?: number; height?: number; style?: Record<string, unknown> }): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === "number" ? node.style.width : null;
  const styleHeight = typeof node.style?.height === "number" ? node.style.height : null;
  return {
    width: styleWidth ?? (typeof node.width === "number" ? node.width : MIN_IMAGE_WIDTH),
    height: styleHeight ?? (typeof node.height === "number" ? node.height : MIN_IMAGE_HEIGHT)
  };
}

export const ImageNode = memo(function ImageNode({ id, data, parentId }: NodeProps<ImageNodeData>) {
  const asset = useGraphStore((state) => state.doc.assets[data.assetId]);
  const imageNode = useGraphStore((state) => state.doc.nodes.find((candidate) => candidate.id === id));
  const removeImageNode = useGraphStore((state) => state.removeImageNode);
  const replaceImageNodeDrawing = useGraphStore((state) => state.replaceImageNodeDrawing);
  const hoveredStoryNodeId = useGraphStore((state) => state.hoveredStoryNodeId);
  const flow = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const pendingInternalsFrame = useRef<number | null>(null);
  const resizeSessionRef = useRef<ResizeSession | null>(null);
  const naturalAspectRatioRef = useRef<number | null>(null);
  const [naturalAspectRatio, setNaturalAspectRatio] = useState<number | null>(null);
  const [isDeleteHovered, setIsDeleteHovered] = useState(false);
  const [isEditHovered, setIsEditHovered] = useState(false);
  const [isDrawingEditorOpen, setIsDrawingEditorOpen] = useState(false);
  const [isSavingDrawingEdit, setIsSavingDrawingEdit] = useState(false);
  const [editorSeedSrc, setEditorSeedSrc] = useState<string | null>(null);
  const parentStoryId = parentId ?? imageNode?.parentId ?? null;
  const isParented = Boolean(parentStoryId);
  const isDrawing = Boolean(asset && asset.fileName.toLowerCase().startsWith("drawing-"));
  const nodeSize = imageNode ? readNodeSize(imageNode) : { width: MIN_IMAGE_WIDTH, height: MIN_IMAGE_HEIGHT };
  const showActions = isParented && (hoveredStoryNodeId === parentStoryId || isDeleteHovered || isEditHovered || isDrawingEditorOpen);

  const actionInsetStyle = useMemo<CSSProperties | undefined>(() => {
    if (!isParented) return undefined;
    const ratio = naturalAspectRatio ?? naturalAspectRatioRef.current;
    if (!ratio || nodeSize.width <= 0 || nodeSize.height <= 0) return undefined;

    const frameRatio = nodeSize.width / nodeSize.height;
    let insetX = 0;
    let insetY = 0;

    if (ratio > frameRatio) {
      const renderedHeight = nodeSize.width / ratio;
      insetY = Math.max(0, (nodeSize.height - renderedHeight) / 2);
    } else {
      const renderedWidth = nodeSize.height * ratio;
      insetX = Math.max(0, (nodeSize.width - renderedWidth) / 2);
    }

    return {
      top: insetY + 5,
      right: insetX + 5
    };
  }, [isParented, naturalAspectRatio, nodeSize.height, nodeSize.width]);

  const deleteButtonStyle = actionInsetStyle;
  const editButtonStyle = useMemo<CSSProperties | undefined>(() => {
    if (!actionInsetStyle) return undefined;
    const right = typeof actionInsetStyle.right === "number" ? actionInsetStyle.right + 24 : undefined;
    return {
      ...actionInsetStyle,
      right
    };
  }, [actionInsetStyle]);

  const scheduleNodeInternalsUpdate = useCallback(() => {
    if (pendingInternalsFrame.current !== null) return;

    pendingInternalsFrame.current = requestAnimationFrame(() => {
      pendingInternalsFrame.current = null;
      updateNodeInternals(id);
    });
  }, [id, updateNodeInternals]);

  useEffect(() => {
    naturalAspectRatioRef.current = null;
    setNaturalAspectRatio(null);
  }, [asset?.id]);

  useEffect(() => {
    return () => {
      if (pendingInternalsFrame.current !== null) {
        cancelAnimationFrame(pendingInternalsFrame.current);
      }
    };
  }, []);

  const openDrawingEditor = useCallback(() => {
    if (!isDrawing || !asset) return;
    setEditorSeedSrc(asset.uri);
    setIsDrawingEditorOpen(true);
  }, [asset, isDrawing]);

  const saveDrawingEdit = useCallback(async (dataUrl: string) => {
    setIsSavingDrawingEdit(true);
    try {
      await replaceImageNodeDrawing(id, dataUrl);
      setIsDrawingEditorOpen(false);
      setEditorSeedSrc(null);
    } finally {
      setIsSavingDrawingEdit(false);
    }
  }, [id, replaceImageNodeDrawing]);

  const applyLiveResize = useCallback((next: NodeRectSnapshot) => {
    useGraphStore.setState((state) => {
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

      useGraphStore.getState().executeCommand({
        label: "Resize Image",
        redo: (doc) => ({
          ...doc,
          nodes: doc.nodes.map((node) => {
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

            return node;
          })
        }),
        undo: (doc) => ({
          ...doc,
          nodes: doc.nodes.map((node) => {
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

            return node;
          })
        })
      });
    },
    [id]
  );

  const startResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, corner: ResizeCorner) => {
      event.preventDefault();
      event.stopPropagation();

      const state = useGraphStore.getState();
      const node = state.doc.nodes.find((candidate) => candidate.id === id);
      if (!node) return;
      if (node.parentId) return;

      const nodeSize = readNodeSize(node);
      const zoom = Math.max(flow.getZoom(), 0.01);
      const aspectRatio = naturalAspectRatioRef.current ?? (nodeSize.width / Math.max(nodeSize.height, 1));

      const start: NodeRectSnapshot = {
        x: node.position.x,
        width: nodeSize.width,
        height: nodeSize.height
      };

      resizeSessionRef.current = {
        pointerId: event.pointerId,
        corner,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startNodeX: start.x,
        startWidth: start.width,
        zoom,
        aspectRatio
      };

      const onPointerMove = (moveEvent: PointerEvent) => {
        const session = resizeSessionRef.current;
        if (!session || moveEvent.pointerId !== session.pointerId) return;

        const currentState = useGraphStore.getState();
        const currentNode = currentState.doc.nodes.find((candidate) => candidate.id === id);
        if (!currentNode) return;

        const dx = (moveEvent.clientX - session.startClientX) / session.zoom;
        const dy = (moveEvent.clientY - session.startClientY) / session.zoom;
        const widthFromX = session.corner === "br" ? session.startWidth + dx : session.startWidth - dx;
        const widthFromY = session.startWidth + dy * session.aspectRatio;
        const deltaX = Math.abs(widthFromX - session.startWidth);
        const deltaY = Math.abs(widthFromY - session.startWidth);
        const proposedWidth = deltaX >= deltaY ? widthFromX : widthFromY;
        let nextWidth = Math.max(MIN_IMAGE_WIDTH, proposedWidth);
        let nextHeight = Math.max(MIN_IMAGE_HEIGHT, nextWidth / Math.max(session.aspectRatio, 0.01));
        nextWidth = Math.max(nextWidth, nextHeight * session.aspectRatio);
        let nextX = session.startNodeX;

        if (session.corner === "bl") {
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

        const currentState = useGraphStore.getState();
        const currentNode = currentState.doc.nodes.find((candidate) => candidate.id === id);
        if (currentNode) {
          const currentSize = readNodeSize(currentNode);
          const next: NodeRectSnapshot = {
            x: currentNode.position.x,
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
    },
    [applyLiveResize, commitResize, flow, id, scheduleNodeInternalsUpdate]
  );

  return (
    <div className="image-node-shell" data-parent-story-id={parentStoryId ?? undefined}>
      <div className={`image-node ${isParented ? "is-parented" : ""}`}>
        {!isParented ? (
          <>
            <div className="image-node__resize-zone image-node__resize-zone--bl nodrag nopan" onPointerDown={(event) => startResize(event, "bl")} />
            <div className="image-node__resize-zone image-node__resize-zone--br nodrag nopan" onPointerDown={(event) => startResize(event, "br")} />
          </>
        ) : null}
        {asset ? (
          <img
            className="image-node__img"
            src={asset.uri}
            alt={asset.fileName}
            draggable={false}
            loading="lazy"
            decoding="async"
            onLoad={(event) => {
              const width = event.currentTarget.naturalWidth;
              const height = event.currentTarget.naturalHeight;
              if (width > 0 && height > 0) {
                const ratio = width / height;
                naturalAspectRatioRef.current = ratio;
                setNaturalAspectRatio(ratio);
              }
              scheduleNodeInternalsUpdate();
            }}
          />
        ) : (
          <div className="image-node__missing">Missing image</div>
        )}
        {isParented && isDrawing ? (
          <button
            className={`image-node__edit nodrag nopan ${showActions ? "is-visible" : ""}`}
            style={editButtonStyle}
            type="button"
            data-parent-story-id={parentStoryId ?? undefined}
            aria-label="Edit drawing"
            title="Edit drawing"
            onPointerEnter={() => setIsEditHovered(true)}
            onPointerLeave={() => setIsEditHovered(false)}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openDrawingEditor();
            }}
          >
            <PencilLine size={11} aria-hidden="true" />
          </button>
        ) : null}
        {isParented ? (
          <button
            className={`image-node__delete nodrag nopan ${showActions ? "is-visible" : ""}`}
            style={deleteButtonStyle}
            type="button"
            data-parent-story-id={parentStoryId ?? undefined}
            aria-label="Delete image"
            title="Delete image"
            onPointerEnter={() => setIsDeleteHovered(true)}
            onPointerLeave={() => setIsDeleteHovered(false)}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void removeImageNode(id);
            }}
          >
            <X size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <DrawingComposer
        open={isDrawingEditorOpen}
        busy={isSavingDrawingEdit}
        initialImageSrc={editorSeedSrc}
        onClose={() => {
          if (!isSavingDrawingEdit) {
            setIsDrawingEditorOpen(false);
            setEditorSeedSrc(null);
          }
        }}
        onSave={saveDrawingEdit}
      />
    </div>
  );
});

ImageNode.displayName = "ImageNode";
