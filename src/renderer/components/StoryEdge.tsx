import { memo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useGraphStore } from "@/renderer/store/useGraphStore";
import type { RelationType } from "@/shared/types";

export const StoryEdge = memo(function StoryEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data
}: EdgeProps<{ relation: RelationType }>) {
  const toggleEdgeRelation = useGraphStore((state) => state.toggleEdgeRelation);

  const relation = data?.relation ?? "THEREFORE";
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  });

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} className="story-edge" />
      <EdgeLabelRenderer>
        <button
          className={`edge-pill edge-pill--${relation.toLowerCase()}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleEdgeRelation(id);
          }}
          type="button"
        >
          {relation}
        </button>
      </EdgeLabelRenderer>
    </>
  );
});

StoryEdge.displayName = "StoryEdge";
