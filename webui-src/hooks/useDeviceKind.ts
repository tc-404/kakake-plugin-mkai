import { useEffect, useState } from 'react';

export type DeviceKind = 'desktop' | 'mobile';

/** 与既有 styles.css 断点保持一致 */
const NARROW_QUERY = '(max-width: 760px)';
const COARSE_QUERY = '(pointer: coarse)';
const FINE_QUERY = '(pointer: fine)';

function canMatch(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function';
}

/** 窄屏，或纯触屏（粗指针且无精确指针）判定为手机体验，其余为桌面 */
export function detectDeviceKind(): DeviceKind {
  if (!canMatch()) return 'desktop';
  const narrow = window.matchMedia(NARROW_QUERY).matches;
  const coarse = window.matchMedia(COARSE_QUERY).matches;
  const fine = window.matchMedia(FINE_QUERY).matches;
  if (narrow) return 'mobile';
  if (coarse && !fine) return 'mobile';
  return 'desktop';
}

/** 响应式设备类型：随窗口尺寸 / 指针类型变化实时更新 */
export function useDeviceKind(): DeviceKind {
  const [kind, setKind] = useState<DeviceKind>(detectDeviceKind);

  useEffect(() => {
    if (!canMatch()) return;
    const mqls = [NARROW_QUERY, COARSE_QUERY, FINE_QUERY].map((q) => window.matchMedia(q));
    const onChange = () => setKind(detectDeviceKind());
    mqls.forEach((mql) => mql.addEventListener('change', onChange));
    onChange();
    return () => mqls.forEach((mql) => mql.removeEventListener('change', onChange));
  }, []);

  return kind;
}