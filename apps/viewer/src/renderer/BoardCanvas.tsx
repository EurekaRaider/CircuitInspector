import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { BoardRenderer, fitView, type ViewState } from "./board-renderer";
import type { BoundsNm, TilePayload, Violation } from "./types";

export interface BoardCanvasHandle {
  fit(): void;
  focus(xNm: number, yNm: number): void;
}

interface Props {
  bounds: BoundsNm;
  tile: TilePayload | null;
  activeViolation: Violation | null;
  mirrored: boolean;
  measureMode: boolean;
  onViewportChange(viewport: BoundsNm, zoom: number): void;
  onPointerWorld(point: { xMm: number; yMm: number; zoom: number }): void;
  onMeasure(distanceMm: number | null): void;
  onPick(point: { xMm: number; yMm: number }): void;
}

export const BoardCanvas = forwardRef<BoardCanvasHandle, Props>(function BoardCanvas(
  { bounds, tile, activeViolation, mirrored, measureMode, onViewportChange, onPointerWorld, onMeasure, onPick },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<BoardRenderer | undefined>(undefined);
  const viewRef = useRef<ViewState>({ centerX: 0, centerY: 0, zoom: 20 });
  const dragRef = useRef<{ x: number; y: number; centerX: number; centerY: number } | undefined>(undefined);
  const measureRef = useRef<Array<{ x: number; y: number }>>([]);
  const [measure, setMeasure] = useState<[number, number, number, number] | undefined>(undefined);

  useImperativeHandle(ref, () => ({
    fit: () => fit(),
    focus: (xNm, yNm) => {
      viewRef.current = { ...viewRef.current, centerX: xNm / 1_000_000, centerY: yNm / 1_000_000, zoom: Math.max(viewRef.current.zoom, 80) };
      applyView(true);
    }
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = new BoardRenderer(canvas);
    rendererRef.current = renderer;
    const observer = new ResizeObserver(() => {
      renderer.resize();
      applyView(false);
    });
    observer.observe(canvas);
    renderer.resize();
    fit();
    return () => {
      observer.disconnect();
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
    rendererRef.current?.setOverlay(activeViolation, measure);
  }, [activeViolation, measure]);

  useEffect(() => {
    measureRef.current = [];
    setMeasure(undefined);
    onMeasure(null);
  }, [measureMode]);

  function fit() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    viewRef.current = fitView(bounds, canvas.clientWidth, canvas.clientHeight);
    applyView(true);
  }

  function applyView(notify: boolean) {
    rendererRef.current?.setView(viewRef.current);
    rendererRef.current?.setOverlay(activeViolation, measure);
    if (!notify) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const halfWidthMm = canvas.clientWidth / viewRef.current.zoom / 2;
    const halfHeightMm = canvas.clientHeight / viewRef.current.zoom / 2;
    onViewportChange(
      {
        min_x: Math.round((viewRef.current.centerX - halfWidthMm) * 1_000_000),
        min_y: Math.round((viewRef.current.centerY - halfHeightMm) * 1_000_000),
        max_x: Math.round((viewRef.current.centerX + halfWidthMm) * 1_000_000),
        max_y: Math.round((viewRef.current.centerY + halfHeightMm) * 1_000_000)
      },
      viewRef.current.zoom
    );
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
      className="block size-full touch-none outline-none"
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
        onPointerWorld({ xMm: point.x, yMm: point.y, zoom: viewRef.current.zoom });
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
        applyView(true);
      }}
    />
  );
});
