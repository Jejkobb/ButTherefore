import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Eraser, PencilLine, Redo2, Undo2 } from "lucide-react";

const CANVAS_WIDTH = 1200;
const CANVAS_HEIGHT = 780;

type StrokeColor = "black" | "white";

interface CanvasPoint {
  x: number;
  y: number;
  time: number;
  pressure: number;
}

interface StrokeSettings {
  color: StrokeColor;
  size: number;
  opacity: number;
}

interface StrokeSession {
  pointerId: number;
  previousPoint: CanvasPoint;
  previousMidpoint: { x: number; y: number };
  settings: StrokeSettings;
}

interface SnapshotEntry {
  bitmap: HTMLCanvasElement;
  hasInk: boolean;
}

export interface DrawingComposerProps {
  open: boolean;
  busy?: boolean;
  initialImageSrc?: string | null;
  onClose: () => void;
  onSave: (dataUrl: string) => Promise<void> | void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function midpoint(a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2
  };
}

function rgbaColor(color: StrokeColor, opacity: number): string {
  return color === "black" ? `rgba(0, 0, 0, ${opacity})` : `rgba(255, 255, 255, ${opacity})`;
}

function readDisplayScale(canvas: HTMLCanvasElement): number {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0) return 1;
  return CANVAS_WIDTH / rect.width;
}

function pointerToCanvasPoint(event: ReactPointerEvent<HTMLCanvasElement>): CanvasPoint | null {
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  return {
    x: ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    time: performance.now(),
    pressure: event.pointerType === "mouse" ? 0.5 : clamp(event.pressure || 0.5, 0.05, 1)
  };
}

function resetCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.imageSmoothingEnabled = true;
  return ctx;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load drawing."));
    image.src = src;
  });
}

function cloneCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const snapshot = document.createElement("canvas");
  snapshot.width = CANVAS_WIDTH;
  snapshot.height = CANVAS_HEIGHT;
  const snapshotCtx = snapshot.getContext("2d");
  if (snapshotCtx) {
    snapshotCtx.drawImage(source, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  }
  return snapshot;
}

function drawSnapshotToCanvas(canvas: HTMLCanvasElement, snapshot: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.drawImage(snapshot, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.imageSmoothingEnabled = true;
}

function drawTap(ctx: CanvasRenderingContext2D, point: CanvasPoint, settings: StrokeSettings): void {
  ctx.fillStyle = rgbaColor(settings.color, settings.opacity);
  ctx.beginPath();
  ctx.arc(point.x, point.y, Math.max(0.8, settings.size * 0.5), 0, Math.PI * 2);
  ctx.fill();
}

function drawSmoothSegment(
  ctx: CanvasRenderingContext2D,
  start: { x: number; y: number },
  control: CanvasPoint,
  end: { x: number; y: number },
  previousPoint: CanvasPoint,
  nextPoint: CanvasPoint,
  settings: StrokeSettings
): void {
  const dx = nextPoint.x - previousPoint.x;
  const dy = nextPoint.y - previousPoint.y;
  const distance = Math.hypot(dx, dy);
  const dt = Math.max(nextPoint.time - previousPoint.time, 1);
  const speed = distance / dt;
  const speedFactor = clamp(1.08 - speed * 0.34, 0.58, 1.06);
  const pressureFactor = clamp(0.72 + nextPoint.pressure * 0.42, 0.7, 1.15);
  const width = Math.max(0.8, settings.size * speedFactor * pressureFactor);
  const color = rgbaColor(settings.color, settings.opacity);
  const textureColor = rgbaColor(settings.color, settings.opacity * 0.25);

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.quadraticCurveTo(control.x, control.y, end.x, end.y);
  ctx.stroke();

  const length = Math.max(Math.hypot(end.x - start.x, end.y - start.y), 0.001);
  const nx = -(end.y - start.y) / length;
  const ny = (end.x - start.x) / length;
  const jitterMax = Math.min(3.4, width * 0.4);

  for (let index = 0; index < 2; index += 1) {
    const jitter = (Math.random() - 0.5) * 2 * jitterMax;
    ctx.strokeStyle = textureColor;
    ctx.lineWidth = Math.max(0.6, width * (0.42 + Math.random() * 0.2));
    ctx.beginPath();
    ctx.moveTo(start.x + nx * jitter, start.y + ny * jitter);
    ctx.quadraticCurveTo(
      control.x + nx * jitter * 0.76,
      control.y + ny * jitter * 0.76,
      end.x + nx * jitter,
      end.y + ny * jitter
    );
    ctx.stroke();
  }
}

export function DrawingComposer({ open, busy = false, initialImageSrc = null, onClose, onSave }: DrawingComposerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokeSessionRef = useRef<StrokeSession | null>(null);
  const historyRef = useRef<SnapshotEntry[]>([]);
  const historyIndexRef = useRef(-1);
  const [strokeColor, setStrokeColor] = useState<StrokeColor>("black");
  const [brushSize, setBrushSize] = useState(6);
  const [brushOpacity, setBrushOpacity] = useState(72);
  const [hasInk, setHasInk] = useState(false);
  const [, bumpHistoryVersion] = useState(0);
  const [isInitializing, setIsInitializing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const canUndo = historyIndexRef.current > 0;
  const canRedo = historyIndexRef.current >= 0 && historyIndexRef.current < historyRef.current.length - 1;
  const controlsBusy = busy || isInitializing;

  const pushHistorySnapshot = useCallback((nextHasInk: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const snapshot: SnapshotEntry = {
      bitmap: cloneCanvas(canvas),
      hasInk: nextHasInk
    };

    const retained = historyRef.current.slice(0, historyIndexRef.current + 1);
    const nextHistory = [...retained, snapshot];
    const limitedHistory = nextHistory.length > 60 ? nextHistory.slice(nextHistory.length - 60) : nextHistory;

    historyRef.current = limitedHistory;
    historyIndexRef.current = limitedHistory.length - 1;
    setHasInk(snapshot.hasInk);
    bumpHistoryVersion((value) => value + 1);
  }, []);

  const applyHistoryEntry = useCallback((entry: SnapshotEntry, nextIndex: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawSnapshotToCanvas(canvas, entry.bitmap);
    historyIndexRef.current = nextIndex;
    setHasInk(entry.hasInk);
    bumpHistoryVersion((value) => value + 1);
    setSaveError(null);
  }, []);

  const undoStroke = useCallback(() => {
    if (controlsBusy) return;
    if (historyIndexRef.current <= 0) return;

    const nextIndex = historyIndexRef.current - 1;
    const entry = historyRef.current[nextIndex];
    if (!entry) return;
    applyHistoryEntry(entry, nextIndex);
  }, [applyHistoryEntry, controlsBusy]);

  const redoStroke = useCallback(() => {
    if (controlsBusy) return;
    const nextIndex = historyIndexRef.current + 1;
    if (nextIndex >= historyRef.current.length) return;

    const entry = historyRef.current[nextIndex];
    if (!entry) return;
    applyHistoryEntry(entry, nextIndex);
  }, [applyHistoryEntry, controlsBusy]);

  const clearDrawing = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!resetCanvas(canvas)) return;
    strokeSessionRef.current = null;
    pushHistorySnapshot(false);
    setSaveError(null);
  }, [pushHistorySnapshot]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const initializeCanvas = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      setIsInitializing(true);
      strokeSessionRef.current = null;
      setSaveError(null);

      const ctx = resetCanvas(canvas);
      let initialHasInk = false;

      if (ctx && initialImageSrc) {
        try {
          const image = await loadImage(initialImageSrc);
          if (cancelled) return;
          ctx.drawImage(image, 0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
          initialHasInk = true;
        } catch {
          initialHasInk = false;
        }
      }

      if (cancelled) return;
      const initialEntry: SnapshotEntry = {
        bitmap: cloneCanvas(canvas),
        hasInk: initialHasInk
      };
      historyRef.current = [initialEntry];
      historyIndexRef.current = 0;
      setHasInk(initialHasInk);
      bumpHistoryVersion((value) => value + 1);
      setIsInitializing(false);
    };

    void initializeCanvas();

    return () => {
      cancelled = true;
      setIsInitializing(false);
    };
  }, [initialImageSrc, open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const modKey = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (event.key === "Escape" && !controlsBusy) {
        event.preventDefault();
        onClose();
        return;
      }

      if (modKey && key === "z") {
        event.preventDefault();
        if (event.shiftKey) {
          void redoStroke();
        } else {
          void undoStroke();
        }
        return;
      }

      if (modKey && key === "y") {
        event.preventDefault();
        void redoStroke();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controlsBusy, onClose, open, redoStroke, undoStroke]);

  const beginStroke = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (controlsBusy) return;
      if (event.button !== 0 && event.pointerType === "mouse") return;

      const point = pointerToCanvasPoint(event);
      const canvas = canvasRef.current;
      if (!point || !canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const scale = readDisplayScale(canvas);
      const settings: StrokeSettings = {
        color: strokeColor,
        size: brushSize * scale,
        opacity: brushOpacity / 100
      };

      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      drawTap(ctx, point, settings);
      strokeSessionRef.current = {
        pointerId: event.pointerId,
        previousPoint: point,
        previousMidpoint: { x: point.x, y: point.y },
        settings
      };
      setHasInk(true);
      setSaveError(null);
    },
    [brushOpacity, brushSize, controlsBusy, strokeColor]
  );

  const extendStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = strokeSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const point = pointerToCanvasPoint(event);
    if (!point) return;

    const distance = Math.hypot(point.x - session.previousPoint.x, point.y - session.previousPoint.y);
    if (distance < 0.6) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const nextMidpoint = midpoint(session.previousPoint, point);
    drawSmoothSegment(
      ctx,
      session.previousMidpoint,
      session.previousPoint,
      nextMidpoint,
      session.previousPoint,
      point,
      session.settings
    );

    session.previousPoint = point;
    session.previousMidpoint = nextMidpoint;
    setHasInk(true);
  }, []);

  const endStroke = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    const session = strokeSessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;

    extendStroke(event);

    const canvas = canvasRef.current;
    if (canvas?.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    strokeSessionRef.current = null;
    pushHistorySnapshot(true);
  }, [extendStroke, pushHistorySnapshot]);

  const handleSave = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || controlsBusy) return;

    setSaveError(null);

    try {
      const dataUrl = canvas.toDataURL("image/png");
      await onSave(dataUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save drawing.";
      setSaveError(message);
    }
  }, [controlsBusy, onSave]);

  if (!open) return null;

  return createPortal(
    <div className="drawing-composer" role="dialog" aria-modal="true" aria-label="Create drawing">
      <button
        className="drawing-composer__backdrop"
        type="button"
        aria-label="Close drawing editor"
        onClick={() => {
          if (!busy) {
            onClose();
          }
        }}
      />
      <div className="drawing-composer__panel nodrag nopan">
        <header className="drawing-composer__header">
          <h3>Draw</h3>
          <p>Sketch directly into this node</p>
        </header>

        <div className="drawing-composer__controls">
          <div className="drawing-composer__color-group" role="group" aria-label="Brush color">
            <button
              type="button"
              className={`drawing-composer__chip ${strokeColor === "black" ? "is-active" : ""}`}
              disabled={controlsBusy}
              onClick={() => setStrokeColor("black")}
            >
              <PencilLine size={14} aria-hidden="true" />
              <span>Black</span>
            </button>
            <button
              type="button"
              className={`drawing-composer__chip ${strokeColor === "white" ? "is-active" : ""}`}
              disabled={controlsBusy}
              onClick={() => setStrokeColor("white")}
            >
              <Eraser size={14} aria-hidden="true" />
              <span>White</span>
            </button>
          </div>

          <label className="drawing-composer__slider">
            <span>Thickness {brushSize}</span>
            <input
              type="range"
              min={1}
              max={24}
              value={brushSize}
              disabled={controlsBusy}
              onChange={(event) => setBrushSize(Number(event.target.value))}
            />
          </label>

          <label className="drawing-composer__slider">
            <span>Opacity {brushOpacity}%</span>
            <input
              type="range"
              min={8}
              max={100}
              value={brushOpacity}
              disabled={controlsBusy}
              onChange={(event) => setBrushOpacity(Number(event.target.value))}
            />
          </label>

          <div className="drawing-composer__history">
            <button type="button" onClick={() => void undoStroke()} disabled={controlsBusy || !canUndo} aria-label="Undo">
              <Undo2 size={14} aria-hidden="true" />
            </button>
            <button type="button" onClick={() => void redoStroke()} disabled={controlsBusy || !canRedo} aria-label="Redo">
              <Redo2 size={14} aria-hidden="true" />
            </button>
          </div>

          <button className="drawing-composer__clear" type="button" onClick={clearDrawing} disabled={controlsBusy || !hasInk}>
            Clear
          </button>
        </div>

        <div className="drawing-composer__canvas-frame">
          <canvas
            ref={canvasRef}
            className="drawing-composer__canvas"
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={beginStroke}
            onPointerMove={extendStroke}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
          />
        </div>

        <footer className="drawing-composer__footer">
          {saveError ? <p className="drawing-composer__error">{saveError}</p> : <span className="drawing-composer__hint">Tip: slow strokes look softer</span>}
          <div className="drawing-composer__actions">
            <button type="button" onClick={onClose} disabled={controlsBusy}>
              Cancel
            </button>
            <button className="drawing-composer__save" type="button" onClick={() => void handleSave()} disabled={controlsBusy}>
              {busy ? "Saving..." : "Save Drawing"}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body
  );
}
