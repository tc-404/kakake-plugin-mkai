import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

// 光标一半尺寸（与 CSS 里 .mkai-cursor 的 width/height 保持一致），用于居中
const HALF = 16;
// 弹簧插值系数：越小跟随越“黏”/延迟，0~1
const SMOOTH = 0.2;

/** 判断目标是否交互元素（碰到就放大光标） */
function isInteractive(el: HTMLElement | null): boolean {
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(
    el.closest(
      'button, a, input, textarea, select, label, [role="button"], [role="switch"], .nav-btn',
    ),
  );
}

/**
 * 仅 PC 桌面端的自定义动态光标。
 * - 触屏设备直接不渲染、不注册事件（移动端用原生触摸）
 * - 作用域严格限制在 rootRef（.mkai-admin）内：只隐藏面板内的原生光标，
 *   指针移出面板即交还宿主控制台的系统光标
 * - mousemove 只更新目标坐标，DOM 修改全部在 requestAnimationFrame 里做
 * - translate3d GPU 合成，pointer-events:none 保证点击穿透表单/按钮
 */
export function CustomCursor({ rootRef }: { rootRef: RefObject<HTMLDivElement | null> }) {
  const isTouch =
    typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator?.maxTouchPoints ?? 0) > 0);

  const dotRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);
  const target = useRef({ x: -100, y: -100 });
  const current = useRef({ x: -100, y: -100 });
  const visible = useRef(false);

  useEffect(() => {
    if (isTouch) return;
    const root = rootRef.current;
    const dot = dotRef.current;
    if (!root || !dot) return;

    // 仅在本面板内隐藏原生光标（作用域化，不动宿主其它区域）
    root.classList.add('mkai-cursor-on');

    const show = () => {
      visible.current = true;
      dot.style.opacity = '1';
    };
    const hide = () => {
      visible.current = false;
      dot.style.opacity = '0';
    };

    const onMove = (e: MouseEvent) => {
      target.current.x = e.clientX;
      target.current.y = e.clientY;
      if (!visible.current) {
        // 首次/重新进入面板：直接吸附到当前位置，避免从屏外“飞入”
        current.current.x = e.clientX;
        current.current.y = e.clientY;
        show();
      }
    };
    const onOver = (e: MouseEvent) => {
      if (isInteractive(e.target as HTMLElement)) dot.classList.add('is-active');
    };
    const onOut = (e: MouseEvent) => {
      if (!isInteractive(e.relatedTarget as HTMLElement)) dot.classList.remove('is-active');
    };
    const onDown = () => dot.classList.add('is-press');
    const onUp = () => dot.classList.remove('is-press');
    const onLeave = () => hide();

    root.addEventListener('mousemove', onMove);
    root.addEventListener('mouseover', onOver);
    root.addEventListener('mouseout', onOut);
    root.addEventListener('mousedown', onDown);
    root.addEventListener('mouseup', onUp);
    root.addEventListener('mouseleave', onLeave);

    // 动画循环：只在这里改 transform（切后台时 rAF 自动暂停）
    const loop = () => {
      const t = target.current;
      const c = current.current;
      c.x += (t.x - c.x) * SMOOTH;
      c.y += (t.y - c.y) * SMOOTH;
      dot.style.transform = `translate3d(${c.x - HALF}px, ${c.y - HALF}px, 0)`;
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);

    // 卸载复原：停 rAF、摘监听、去掉隐藏原生光标的类
    return () => {
      cancelAnimationFrame(rafRef.current);
      root.classList.remove('mkai-cursor-on');
      root.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('mousedown', onDown);
      root.removeEventListener('mouseup', onUp);
      root.removeEventListener('mouseleave', onLeave);
    };
  }, [isTouch, rootRef]);

  // 移动端：不渲染任何 DOM
  if (isTouch) return null;

  return (
    <div ref={dotRef} className="mkai-cursor" aria-hidden style={{ opacity: 0 }}>
      {/* 纯 CSS 绘制：外环 + 中心点。想换素材时把下面两个 span 换成
          <img src={...} /> 或 Lottie 组件即可，容器尺寸对应 HALF*2 */}
      <span className="mkai-cursor__ring" />
      <span className="mkai-cursor__dot" />
    </div>
  );
}

export default CustomCursor;