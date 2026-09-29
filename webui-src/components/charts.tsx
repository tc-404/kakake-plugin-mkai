/* =========================================================================
   MK_AI 概览图表基元（纯 SVG / 轻量 DOM，设备无关）
   仅做展示，不含数据请求；颜色走既有设计令牌（--mk-brand-* / --mk-accent 等）。
   桌面与手机概览页共用这套基元。
   ========================================================================= */
import { useCallback, useMemo, useState, type CSSProperties } from 'react';

const TRACK = 'rgba(148, 163, 184, 0.22)';

export interface DonutSegment {
  value: number;
  color: string;
  label?: string;
}

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/** 环形扇区路径（用于可点击分段） */
function donutSegmentPath(
  cx: number,
  cy: number,
  r: number,
  thickness: number,
  startDeg: number,
  endDeg: number,
): string {
  if (endDeg - startDeg >= 359.99) {
    endDeg = startDeg + 359.99;
  }
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const [x1, y1] = polar(cx, cy, r, startDeg);
  const [x2, y2] = polar(cx, cy, r, endDeg);
  const ri = r - thickness;
  const [x3, y3] = polar(cx, cy, ri, endDeg);
  const [x4, y4] = polar(cx, cy, ri, startDeg);
  return [
    `M ${x1} ${y1}`,
    `A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`,
    `L ${x3} ${y3}`,
    `A ${ri} ${ri} 0 ${large} 0 ${x4} ${y4}`,
    'Z',
  ].join(' ');
}

/** 多段环形图：用于「提示 / 补全 token 占比」等构成类数据；interactive 时可点击分段查看占比 */
export function DonutChart({
  segments,
  size = 132,
  thickness = 16,
  centerNum,
  centerSub,
  interactive = false,
  formatValue = (n) => String(Math.round(n)),
  ariaLabel = '构成环形图，点击色块查看占比',
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerNum?: string;
  centerSub?: string;
  /** 点击色块才显示标签与占比；默认中心仅显示 centerNum / centerSub */
  interactive?: boolean;
  formatValue?: (n: number) => string;
  ariaLabel?: string;
}) {
  const [activeIdx, setActiveIdx] = useState<number | null>(null);

  const total = segments.reduce((s, x) => s + Math.max(0, x.value), 0);
  const r = (size - thickness) / 2;
  const c = size / 2;

  const arcs = useMemo(() => {
    let deg = -90;
    return segments.map((seg, i) => {
      const val = Math.max(0, seg.value);
      const sweep = total > 0 && val > 0 ? (val / total) * 360 : 0;
      const start = deg;
      const end = deg + sweep;
      deg = end;
      return { seg, i, start, end, sweep, val };
    });
  }, [segments, total]);

  const onSegClick = useCallback((idx: number) => {
    if (!interactive) return;
    setActiveIdx((prev) => (prev === idx ? null : idx));
  }, [interactive]);

  const active = activeIdx != null ? arcs[activeIdx] : null;
  const displayNum = interactive && active
    ? formatValue(active.val)
    : centerNum;
  const displaySub = interactive && active && active.seg.label
    ? `${active.seg.label} · ${total > 0 ? Math.round((active.val / total) * 100) : 0}%`
    : centerSub;

  const svgClass = `mk-chart mk-chart--donut${interactive ? ' mk-chart--donut-interactive' : ''}`;

  const svgStyle = { ['--mk-donut-px' as string]: size } as CSSProperties;

  if (interactive) {
    return (
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        className={svgClass}
        style={svgStyle}
        role="img"
        aria-label={ariaLabel}
      >
        <circle cx={c} cy={c} r={r} fill="none" stroke={TRACK} strokeWidth={thickness} />
        {total > 0 &&
          arcs.map(({ seg, i, start, end, sweep, val }) => {
            if (sweep <= 0) return null;
            const isActive = activeIdx === i;
            const isDim = activeIdx != null && !isActive;
            return (
              <path
                key={i}
                d={donutSegmentPath(c, c, r, thickness, start, end)}
                fill={seg.color}
                className={`mk-chart__seg${isActive ? ' is-active' : ''}${isDim ? ' is-dim' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={seg.label ? `${seg.label} ${formatValue(val)}` : undefined}
                onClick={() => onSegClick(i)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSegClick(i);
                  }
                }}
              />
            );
          })}
        {displayNum != null && displayNum !== '' && (
          <text x={c} y={c} className="mk-chart__num" textAnchor="middle" dominantBaseline="central" dy={displaySub ? '-0.15em' : '0'}>
            {displayNum}
          </text>
        )}
        {displaySub != null && displaySub !== '' && (
          <text x={c} y={c} className="mk-chart__sub" textAnchor="middle" dominantBaseline="central" dy="1.15em">
            {displaySub}
          </text>
        )}
      </svg>
    );
  }

  const circ = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className={svgClass}
      style={svgStyle}
      role="img"
    >
      <circle cx={c} cy={c} r={r} fill="none" stroke={TRACK} strokeWidth={thickness} />
      {total > 0 &&
        segments.map((seg, i) => {
          const len = (Math.max(0, seg.value) / total) * circ;
          const el = (
            <circle
              key={i}
              cx={c}
              cy={c}
              r={r}
              fill="none"
              stroke={seg.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${circ - len}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${c} ${c})`}
            />
          );
          offset += len;
          return el;
        })}
      {centerNum != null && (
        <text x={c} y={c} className="mk-chart__num" textAnchor="middle" dominantBaseline="central" dy="-0.15em">
          {centerNum}
        </text>
      )}
      {centerSub != null && (
        <text x={c} y={c} className="mk-chart__sub" textAnchor="middle" dominantBaseline="central" dy="1.15em">
          {centerSub}
        </text>
      )}
    </svg>
  );
}

/** 半环仪表盘：用于「余额占比 / 限速用量 / 缓存命中率」等 0-100% 数据 */
export function Gauge({
  value,
  max = 100,
  size = 148,
  thickness = 13,
  tone = 'var(--mk-accent)',
  centerNum,
  centerSub,
}: {
  value: number;
  max?: number;
  size?: number;
  thickness?: number;
  tone?: string;
  centerNum?: string;
  centerSub?: string;
}) {
  const frac = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const pt = (deg: number): [number, number] => {
    const rad = (deg * Math.PI) / 180;
    return [cx - r * Math.cos(rad), cy - r * Math.sin(rad)];
  };
  const [sx, sy] = pt(0);
  const [ex, ey] = pt(180);
  const [vx, vy] = pt(180 * frac);
  const height = Math.ceil(cy + thickness / 2 + 1);
  return (
    <svg viewBox={`0 0 ${size} ${height}`} width={size} height={height} className="mk-chart mk-chart--gauge" role="img">
      <path d={`M ${sx} ${sy} A ${r} ${r} 0 0 1 ${ex} ${ey}`} fill="none" stroke={TRACK} strokeWidth={thickness} strokeLinecap="round" />
      {frac > 0 && (
        <path d={`M ${sx} ${sy} A ${r} ${r} 0 0 1 ${vx} ${vy}`} fill="none" stroke={tone} strokeWidth={thickness} strokeLinecap="round" />
      )}
      {centerNum != null && (
        <text x={cx} y={cy} className="mk-chart__num" textAnchor="middle" dy="-0.35em">
          {centerNum}
        </text>
      )}
      {centerSub != null && (
        <text x={cx} y={cy} className="mk-chart__sub" textAnchor="middle" dy="0.7em">
          {centerSub}
        </text>
      )}
    </svg>
  );
}

export interface BarDatum {
  label: string;
  value: number;
  color?: string;
  hint?: string;
}

/** 横向条形：用于「开启覆盖率 / 能力分布 / 会话消息量 Top」等带标签的分类数据 */
export function MiniBar({
  data,
  max,
  barColor = 'var(--mk-accent)',
  format,
}: {
  data: BarDatum[];
  max?: number;
  barColor?: string;
  format?: (v: number) => string;
}) {
  const hi = max ?? Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="mk-minibar">
      {data.map((d, i) => (
        <div className="mk-minibar__row" key={i}>
          <span className="mk-minibar__label" title={d.hint || d.label}>
            {d.label}
          </span>
          <span className="mk-minibar__track">
            <span
              className="mk-minibar__fill"
              style={{ width: `${hi > 0 ? Math.max(0, Math.min(100, (d.value / hi) * 100)) : 0}%`, background: d.color || barColor } as CSSProperties}
            />
          </span>
          <span className="mk-minibar__val">{format ? format(d.value) : d.value}</span>
        </div>
      ))}
    </div>
  );
}

/** 迷你折线（面积）：用于会话消息量分布等序列型数据的紧凑呈现 */
export function Sparkline({
  points,
  width = 168,
  height = 46,
  stroke = 'var(--mk-accent)',
  fill = 'var(--mk-accent-soft)',
}: {
  points: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
}) {
  const n = points.length;
  if (n === 0) return <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="mk-chart mk-chart--spark" />;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const span = max - min || 1;
  const stepX = n > 1 ? width / (n - 1) : width;
  const coords = points.map((p, i): [number, number] => [i * stepX, height - ((p - min) / span) * (height - 6) - 3]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L ${width.toFixed(1)} ${height} L 0 ${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="mk-chart mk-chart--spark" role="img" preserveAspectRatio="none">
      <path d={area} fill={fill} stroke="none" opacity="0.55" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}