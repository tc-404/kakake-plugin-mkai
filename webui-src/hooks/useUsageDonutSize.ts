import { useEffect, useState, type RefObject } from 'react';
import type { DeviceKind } from './useDeviceKind';

export interface DonutMetrics {
  size: number;
  thickness: number;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * 圆盘尺寸算法（两列并排，随容器实时缩放）
 *
 * 列宽 col = (gridWidth - gap) / 2
 *
 * 桌面：直径 = col × 0.78，clamp [100, 176]；环宽 = 直径 × 0.121，clamp [11, 18]
 * 手机：直径 = col × 0.82，clamp [68, 112]；环宽 = 直径 × 0.122，clamp [8, 13]
 */
export function computeUsageDonutMetrics(colWidth: number, kind: DeviceKind): DonutMetrics {
  const col = Math.max(0, colWidth);
  if (kind === 'mobile') {
    const size = Math.round(clamp(col * 0.82, 68, 112));
    const thickness = Math.round(clamp(size * 0.122, 8, 13));
    return { size, thickness };
  }
  const size = Math.round(clamp(col * 0.78, 100, 176));
  const thickness = Math.round(clamp(size * 0.121, 11, 18));
  return { size, thickness };
}

const GRID_GAP: Record<DeviceKind, number> = { desktop: 20, mobile: 12 };
const COLS = 2;

const FALLBACK: Record<DeviceKind, DonutMetrics> = {
  desktop: { size: 128, thickness: 15 },
  mobile: { size: 88, thickness: 11 },
};

/** 监听 Token/会话双列网格宽度，返回两盘共用的 size / thickness */
export function useUsageDonutSize(
  gridRef: RefObject<HTMLElement | null>,
  kind: DeviceKind,
): DonutMetrics {
  const [metrics, setMetrics] = useState<DonutMetrics>(() => FALLBACK[kind]);

  useEffect(() => {
    setMetrics(FALLBACK[kind]);
  }, [kind]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;

    const gap = GRID_GAP[kind];
    const measure = () => {
      const w = el.clientWidth;
      const colWidth = (w - gap * (COLS - 1)) / COLS;
      setMetrics(computeUsageDonutMetrics(colWidth, kind));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [gridRef, kind]);

  return metrics;
}
