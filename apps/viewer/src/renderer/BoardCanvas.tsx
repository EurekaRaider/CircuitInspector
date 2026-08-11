import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BoardRenderer, fitView, type ViewState } from "./board-renderer";
import type { BoundsNm, TestPointCandidate, TilePayload, Violation } from "./types";

export interface BoardCanvasHandle {
  fit(): void;
  focus(xNm: number, yNm: number, zoom?: number, refreshTile?: boolean): void;
  viewport(): { bounds: BoundsNm; zoom: number } | null;
}

interface Props {
  bounds: BoundsNm;
  tile: TilePayload | null;
  activeViolation: Violation | null;
  activeTestPoint: TestPointCandidate | null;
  mirrored: boolean;
  measureMode: boolean;
  onViewportChange(viewport: BoundsNm, zoom: number): void;
  onPointerWorld(point: { xMm: number; yMm: number; zoom: number }): void;
  onMeasure(distanceMm: number | null): void;
  onPick(point: { xMm: number; yMm: number }): void;
}

const BoardCanvasComponent = forwardRef<BoardCanvasHandle, Props>(function BoardCanvas(
  { bounds, tile, activeViolation, activeTestPoint, mirrored, measureMode, onViewportChange, onPointerWorld, onMeasure, onPick },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | undefined>(undefined);
  const viewRef = useRef<ViewState>({ centerX: 0, centerY: 0, zoom: 20 });
  const dragRef = useRef<{ x: number; y: number; centerX: number; centerY: number } | undefined>(undefined);
  const measureRef = useRef<Array<{ x: number; y: number }>>([]);
  const viewFrameRef = useRef<number | undefined>(undefined);
  const viewportTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingPointerRef = useRef<{ xMm: number; yMm: number; zoom: number } | undefined>(undefined);
  const [measure, setMeasure] = useState<[number, number, number, number] | undefined>(undefined);

  useImperativeHandle(ref, () => ({
    fit: () => fit(),
    focus: (xNm, yNm, zoom, refreshTile = true) => {
      const targetZoom = zoom == null ? Math.max(viewRef.current.zoom, 80) : zoom;
      viewRef.current = { ...viewRef.current, centerX: xNm / 1_000_000, centerY: yNm / 1_000_000, zoom: targetZoom };
      applyView(refreshTile);
    },
    viewport: () => currentViewport()
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new BoardRenderer(canvas);
    rendererRef.current = renderer;
    let hasVisibleSize = false;
    const observer = new ResizeObserver(() => {
      renderer.resize();
      if (!hasVisibleSize && canvas.clientWidth > 0 && canvas.clientHeight > 0) {
        hasVisibleSize = true;
        fit();
      } else {
        applyView(false);
      }
    });
    observer.observe(canvas);
    renderer.resize();
    if (canvas.clientWidth > 0 && canvas.clientHeight > 0) {
      hasVisibleSize = true;
      fit();
    }
    return () => {
      observer.disconnect();
      if (viewFrameRef.current != null) cancelAnimationFrame(viewFrameRef.current);
      if (viewportTimerRef.current != null) clearTimeout(viewportTimerRef.current);
      if (pointerTimerRef.current != null) clearTimeout(pointerTimerRef.current);
      renderer.dispose();
      rendererRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setTile(tile);
  }, [tile]);

  useEffect(() => {
    rendererRef.current?.setMirrored(mirrored);
  }, [mirrored]);

  useEffect(() => {
    rendererRef.current?.setOverlay(activeViolation, activeTestPoint, measure);
  }, [activeTestPoint, activeViolation, measure]);

  useEffect(() => {
    measureRef.current = [];
    setMeasure(undefined);
    onMeasure(null);
  }, [measureMode, onMeasure]);

  function fit() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewRef.current = fitView(bounds, canvas.clientWidth, canvas.clientHeight);
    applyView(true);
  }

  function applyView(notify: boolean) {
    scheduleViewRender();
    if (notify) notifyViewportChange();
  }

  function scheduleViewRender() {
    if (viewFrameRef.current != null) return;
    viewFrameRef.current = requestAnimationFrame(() => {
      viewFrameRef.current = undefined;
      rendererRef.current?.setView(viewRef.current);
    });
  }

  function notifyViewportChange() {
    if (viewportTimerRef.current != null) {
      clearTimeout(viewportTimerRef.current);
      viewportTimerRef.current = undefined;
    }
    const current = currentViewport();
    if (!current) return;
    onViewportChange(current.bounds, current.zoom);
  }

  function currentViewport() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const halfWidthMm = canvas.clientWidth / viewRef.current.zoom / 2;
    const halfHeightMm = canvas.clientHeight / viewRef.current.zoom / 2;
    return {
      bounds: {
        min_x: Math.round((viewRef.current.centerX - halfWidthMm) * 1_000_000),
        min_y: Math.round((viewRef.current.centerY - halfHeightMm) * 1_000_000),
        max_x: Math.round((viewRef.current.centerX + halfWidthMm) * 1_000_000),
        max_y: Math.round((viewRef.current.centerY + halfHeightMm) * 1_000_000)
      },
      zoom: viewRef.current.zoom
    };
  }

  function scheduleViewportChange() {
    if (viewportTimerRef.current != null) clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = setTimeout(() => {
      viewportTimerRef.current = undefined;
      notifyViewportChange();
    }, 120);
  }

  function schedulePointerWorld(point: { xMm: number; yMm: number; zoom: number }) {
    pendingPointerRef.current = point;
    if (pointerTimerRef.current != null) return;
    pointerTimerRef.current = setTimeout(() => {
      pointerTimerRef.current = undefined;
      const pending = pendingPointerRef.current;
      pendingPointerRef.current = undefined;
      if (pending) onPointerWorld(pending);
    }, 50);
  }

  function worldPoint(clientX: number, clientY: number) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: viewRef.current.centerX + (clientX - rect.left - rect.width / 2) / viewRef.current.zoom * (mirrored ? -1 : 1),
      y: viewRef.current.centerY - (clientY - rect.top - rect.height / 2) / viewRef.current.zoom
    };
  }

  return (
    <canvas
      ref={canvasRef}
      className={`block size-full touch-none outline-none ${measureMode ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"}`}
      tabIndex={0}
      aria-label="PCB 矢量视图。滚轮缩放，按住拖拽平移。"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        if (measureMode) {
          const point = worldPoint(event.clientX, event.clientY);
          const points = [...measureRef.current, point].slice(-2);
          measureRef.current = points;
          if (points.length === 2) {
            const line: [number, number, number, number] = [points[0]!.x, points[0]!.y, points[1]!.x, points[1]!.y];
            setMeasure(line);
            onMeasure(Math.hypot(points[1]!.x - points[0]!.x, points[1]!.y - points[0]!.y));
          }
          return;
        }
        dragRef.current = { x: event.clientX, y: event.clientY, centerX: viewRef.current.centerX, centerY: viewRef.current.centerY };
      }}
      onPointerMove={(event) => {
        const point = worldPoint(event.clientX, event.clientY);
        schedulePointerWorld({ xMm: point.x, yMm: point.y, zoom: viewRef.current.zoom });
        if (!dragRef.current) return;
        const deltaX = event.clientX - dragRef.current.x;
        const deltaY = event.clientY - dragRef.current.y;
        viewRef.current = {
          ...viewRef.current,
          centerX: dragRef.current.centerX - deltaX / viewRef.current.zoom * (mirrored ? -1 : 1),
          centerY: dragRef.current.centerY + deltaY / viewRef.current.zoom
        };
        applyView(false);
      }}
      onPointerUp={() => {
        if (dragRef.current) {
          const moved = Math.hypot(
            viewRef.current.centerX - dragRef.current.centerX,
            viewRef.current.centerY - dragRef.current.centerY
          ) * viewRef.current.zoom;
          if (moved < 3) {
            const point = worldPoint(dragRef.current.x, dragRef.current.y);
            onPick({ xMm: point.x, yMm: point.y });
          }
          applyView(true);
        }
        dragRef.current = undefined;
      }}
      onPointerCancel={() => {
        if (dragRef.current) applyView(true);
        dragRef.current = undefined;
      }}
      onWheel={(event) => {
        event.preventDefault();
        const before = worldPoint(event.clientX, event.clientY);
        const factor = Math.exp(-event.deltaY * 0.0014);
        viewRef.current = { ...viewRef.current, zoom: Math.min(8000, Math.max(0.02, viewRef.current.zoom * factor)) };
        const after = worldPoint(event.clientX, event.clientY);
        viewRef.current.centerX += before.x - after.x;
        viewRef.current.centerY += before.y - after.y;
        schedulePointerWorld({ xMm: before.x, yMm: before.y, zoom: viewRef.current.zoom });
        applyView(false);
        scheduleViewportChange();
      }}
    />
  );
});

export const BoardCanvas = memo(BoardCanvasComponent);
BoardCanvas.displayName = "BoardCanvas";
