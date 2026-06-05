import { useMemo, useRef } from "react";
import { useLanguage } from "../../contexts/LanguageContext";
import styles from "./ProfilePanel.module.css";

const W = 320;
const H = 160;
const PAD = { top: 8, right: 8, bottom: 18, left: 40 };

export default function ProfilePanel({
  samples,
  totalDistanceM,
  onClose,
  onHoverIndex,
  hoveredIndex,
}) {
  const { t } = useLanguage();
  const svgRef = useRef(null);

  const layout = useMemo(() => {
    if (!samples || samples.length === 0) return null;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;

    let minE = Infinity,
      maxE = -Infinity;
    for (const s of samples) {
      if (s.elevation < minE) minE = s.elevation;
      if (s.elevation > maxE) maxE = s.elevation;
    }
    if (maxE - minE < 1) maxE = minE + 1;

    const xFor = (i) => PAD.left + (i / (samples.length - 1)) * innerW;
    const yFor = (e) =>
      PAD.top + innerH - ((e - minE) / (maxE - minE)) * innerH;

    return { innerW, innerH, minE, maxE, xFor, yFor };
  }, [samples]);

  if (!samples || samples.length === 0 || !layout) return null;
  const { innerW, innerH, minE, maxE, xFor, yFor } = layout;

  let pathArea = `M ${xFor(0)} ${PAD.top + innerH}`;
  let pathLine = "";
  samples.forEach((s, i) => {
    const x = xFor(i);
    const y = yFor(s.elevation);
    pathArea += ` L ${x} ${y}`;
    pathLine += (i === 0 ? "M" : "L") + ` ${x} ${y}`;
  });
  pathArea += ` L ${xFor(samples.length - 1)} ${PAD.top + innerH} Z`;

  const distanceKm = totalDistanceM / 1000;
  const distanceLabel =
    distanceKm >= 1
      ? `${distanceKm.toFixed(2)} km`
      : `${Math.round(totalDistanceM)} m`;

  // Convert a client-X coordinate to a sample index within the chart's data area.
  const indexForClientX = (clientX) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    // The SVG renders with viewBox 0..W; scale clientX into that coordinate space.
    const svgX = ((clientX - rect.left) / rect.width) * W;
    const u = (svgX - PAD.left) / innerW;
    if (u < 0 || u > 1) return null;
    return Math.round(u * (samples.length - 1));
  };

  const handleMove = (e) => {
    if (!onHoverIndex) return;
    const idx = indexForClientX(e.clientX);
    onHoverIndex(idx);
  };
  const handleLeave = () => {
    if (!onHoverIndex) return;
    onHoverIndex(null);
  };

  const hovered =
    hoveredIndex != null && hoveredIndex >= 0 && hoveredIndex < samples.length
      ? samples[hoveredIndex]
      : null;
  const hoverX = hovered != null ? xFor(hoveredIndex) : null;
  const hoverY = hovered != null ? yFor(hovered.elevation) : null;

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.title}>{t.measureTool}</span>
        <button type="button" onClick={onClose} aria-label={t.close}>
          ×
        </button>
      </div>
      <div className={styles.distance}>
        {t.straightLineDistance} <strong>{distanceLabel}</strong>
      </div>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        onMouseMove={handleMove}
        onMouseLeave={handleLeave}
        className={styles.chart}
      >
        <path d={pathArea} className={styles.area} />
        <path d={pathLine} className={styles.line} />
        <line
          x1={PAD.left}
          y1={PAD.top + innerH}
          x2={PAD.left + innerW}
          y2={PAD.top + innerH}
          className={styles.axis}
        />
        <line
          x1={PAD.left}
          y1={PAD.top}
          x2={PAD.left}
          y2={PAD.top + innerH}
          className={styles.axis}
        />
        <text x={PAD.left} y={PAD.top - 1} className={styles.tick}>
          {Math.round(maxE)} m
        </text>
        <text x={PAD.left} y={PAD.top + innerH + 12} className={styles.tick}>
          {Math.round(minE)} m
        </text>
        <text
          x={PAD.left + innerW}
          y={H - 4}
          className={styles.tick}
          textAnchor="end"
        >
          {distanceLabel}
        </text>
        {hovered != null && (
          <g className={styles.hover}>
            <line
              x1={hoverX}
              y1={PAD.top}
              x2={hoverX}
              y2={PAD.top + innerH}
              className={styles.hoverLine}
            />
            <circle
              cx={hoverX}
              cy={hoverY}
              r={3.5}
              className={styles.hoverDot}
            />
            <text
              x={hoverX}
              y={PAD.top + 10}
              className={styles.hoverLabel}
              textAnchor={hoverX > PAD.left + innerW * 0.7 ? "end" : "start"}
              dx={hoverX > PAD.left + innerW * 0.7 ? -4 : 4}
            >
              {Math.round(hovered.elevation)} m
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}
