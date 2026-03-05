import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
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

export function StoryNode({ id, data }: NodeProps<StoryNodeData>) {
  const [isDragOver, setIsDragOver] = useState(false);
  const beatRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());
  const updateNodeInternals = useUpdateNodeInternals();

  const assets = useGraphStore((state) => state.doc.assets);
  const updateNodeTitle = useGraphStore((state) => state.updateNodeTitle);
  const updateBeatLine = useGraphStore((state) => state.updateBeatLine);
  const addBeatLine = useGraphStore((state) => state.addBeatLine);
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

  const resizeBeatField = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (!element) return;

      element.style.height = "0px";
      element.style.height = `${Math.max(34, element.scrollHeight)}px`;

      requestAnimationFrame(() => updateNodeInternals(id));
    },
    [id, updateNodeInternals]
  );

  useEffect(() => {
    beatRefs.current.forEach((element) => resizeBeatField(element));
  }, [data.beats, resizeBeatField]);

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
      <input
        className="story-node__title-floating nodrag"
        value={data.title}
        onChange={(event) => updateNodeTitle(id, event.target.value)}
        placeholder="Beat title"
        spellCheck={false}
      />

      <div className="story-node">
        <Handle className="story-handle" type="target" position={Position.Left} id="in" />

        <div className="story-node__beats">
          {data.beats.map((line, index) => (
            <div className="story-node__beat-row" key={`${id}-beat-${index}`}>
              <textarea
                className="story-node__beat nodrag"
                value={line}
                onChange={(event) => updateBeatLine(id, index, event.target.value)}
                onInput={(event) => resizeBeatField(event.currentTarget)}
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
                onLoad={() => {
                  // Images can change node height dynamically, so we refresh internals after each load.
                  requestAnimationFrame(() => updateNodeInternals(id));
                }}
              />
            ))}
          </div>
        ) : null}

        <div className="story-node__footer">
          <button className="story-node__secondary nodrag" onClick={() => addBeatLine(id)} type="button">
            + Beat
          </button>
          <button
            className="story-node__secondary nodrag"
            onClick={async () => {
              const filePaths = await window.storyBridge.pickImageFiles();
              await importImagePaths(filePaths);
            }}
            type="button"
          >
            + Image
          </button>
        </div>

        <Handle className="story-handle" type="source" position={Position.Right} id="out" />
      </div>
    </div>
  );
}
