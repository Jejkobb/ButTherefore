import { useMemo, useRef, useState, type DragEvent, type ChangeEvent } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import type { StoryNodeData } from "@/shared/types";
import { useGraphStore } from "@/renderer/store/useGraphStore";

export function StoryNode({ id, data }: NodeProps<StoryNodeData>) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
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

  const importFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const paths = Array.from(files)
      .map((file) => (file as File & { path?: string }).path)
      .filter((path): path is string => Boolean(path));

    if (paths.length === 0) return;

    await attachImagesToNode(id, paths);
  };

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    await importFiles(event.dataTransfer.files);
  };

  const onFilePick = async (event: ChangeEvent<HTMLInputElement>) => {
    await importFiles(event.target.files);
    event.target.value = "";
  };

  return (
    <div
      className={`story-node ${isDragOver ? "is-drag-over" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={onDrop}
    >
      <Handle className="story-handle" type="target" position={Position.Left} id="in" />

      <div className="story-node__header">
        <input
          className="story-node__title nodrag"
          value={data.title}
          onChange={(event) => updateNodeTitle(id, event.target.value)}
          placeholder="Beat title"
        />
      </div>

      <div className="story-node__beats">
        {data.beats.map((line, index) => (
          <div className="story-node__beat-row" key={`${id}-beat-${index}`}>
            <input
              className="story-node__beat nodrag"
              value={line}
              onChange={(event) => updateBeatLine(id, index, event.target.value)}
              placeholder={`Beat ${index + 1}`}
            />
            <button
              className="story-node__icon-button nodrag"
              onClick={() => removeBeatLine(id, index)}
              type="button"
              title="Remove beat"
            >
              -
            </button>
          </div>
        ))}

        <button className="story-node__secondary nodrag" onClick={() => addBeatLine(id)} type="button">
          + Add beat
        </button>
      </div>

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

      <div className="story-node__footer">
        <button className="story-node__secondary nodrag" onClick={() => fileInputRef.current?.click()} type="button">
          Attach images
        </button>
        <span className="story-node__hint">Drop images on node</span>
      </div>

      <input
        className="visually-hidden"
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={onFilePick}
      />

      <Handle className="story-handle" type="source" position={Position.Right} id="out" />
    </div>
  );
}
