import { sankey, sankeyLinkHorizontal } from 'd3-sankey';
import React from 'react';
import { formatDisplayValue, formatIndexedWealth } from '../shared/currency.js';
import type { CurrencyCode, HorizonProjectionPoint, PotRollupNode } from '../shared/types.js';

/**
 * 1. Editorial Cashflow Sankey Diagram (Overview Tab)
 * Inspired by clean muted ribbons showing where income comes from and where every % / £ goes.
 */
export const CashflowSankeyChart: React.FC<{
  nodes: Array<{ id: string; name: string; stage: number; color: string }>;
  links: Array<{ source: string; target: string; valueMinor: number }>;
  currency: CurrencyCode;
  privacyMode: boolean;
  referenceIncomeMinor: number;
}> = ({ nodes, links, currency, privacyMode, referenceIncomeMinor }) => {
  const validLinks = links.filter((l) => l.valueMinor > 0);
  if (nodes.length < 2 || validLinks.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-slate-400 font-mono-num">
        Add an income stream or pot budget to render cashflow routing.
      </div>
    );
  }

  const width = 820;
  const height = 270;

  const layout = sankey<
    { id: string; name: string; color: string },
    { source: string; target: string; value: number }
  >()
    .nodeId((d) => d.id)
    .nodeWidth(10)
    .nodePadding(16)
    .extent([
      [12, 14],
      [width - 175, height - 14],
    ]);

  const graph = layout({
    nodes: nodes.map((n) => ({ ...n })),
    links: validLinks.map((l) => ({
      source: l.source,
      target: l.target,
      value: l.valueMinor,
    })),
  });

  const pathGen = sankeyLinkHorizontal();
  const denom = referenceIncomeMinor > 0 ? referenceIncomeMinor : validLinks.reduce((s, l) => s + l.valueMinor, 0);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto overflow-visible select-none">
      <g fill="none">
        {graph.links.map((link, idx) => {
          const d = pathGen(link as never) || '';
          const srcNode = link.source as { color?: string };
          const tgtNode = link.target as { color?: string; name?: string };
          const strokeColor = tgtNode.color && tgtNode.color !== '#334155' ? tgtNode.color : srcNode.color || '#64748B';
          return (
            <path
              key={idx}
              d={d}
              stroke={strokeColor}
              strokeOpacity={0.26}
              strokeWidth={Math.max(2, link.width || 2)}
              className="transition-opacity hover:stroke-opacity-50"
            />
          );
        })}
      </g>
      <g>
        {graph.nodes.map((node) => {
          const x0 = node.x0 ?? 0;
          const x1 = node.x1 ?? 0;
          const y0 = node.y0 ?? 0;
          const y1 = node.y1 ?? 0;
          const val = node.value ?? 0;
          const pct = denom > 0 ? ((val / denom) * 100).toFixed(0) : '0';
          const isRight = x0 > width * 0.45;
          const labelValue = privacyMode
            ? `${pct}%`
            : `${formatDisplayValue(val, { currency, privacyMode: false, compact: true })} · ${pct}%`;

          return (
            <g key={node.id}>
              <rect
                x={x0}
                y={y0}
                width={Math.max(6, x1 - x0)}
                height={Math.max(4, y1 - y0)}
                rx={2}
                fill={node.color || '#334155'}
              />
              <text
                x={isRight ? x1 + 8 : x0 + 14}
                y={(y0 + y1) / 2 - 2}
                className="fill-slate-800 text-[11px] font-medium"
                dominantBaseline="middle"
              >
                {node.name}
              </text>
              <text
                x={isRight ? x1 + 8 : x0 + 14}
                y={(y0 + y1) / 2 + 11}
                className="fill-slate-500 text-[10px] font-mono-num"
                dominantBaseline="middle"
              >
                {labelValue}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
};

/**
 * 2. Compact 6-Month Income vs. Spend Context Chart (Overview Tab)
 */
export const SixMonthTrendChart: React.FC<{
  data: Array<{ yearMonth: string; incomeMinor: number; spendMinor: number }>;
  currency: CurrencyCode;
  privacyMode: boolean;
}> = ({ data, currency, privacyMode }) => {
  const maxVal = Math.max(1, ...data.flatMap((d) => [d.incomeMinor, d.spendMinor]));
  return (
    <div className="grid grid-cols-6 gap-3 items-end h-44 pt-4">
      {data.map((d) => {
        const incH = Math.max(4, Math.round((d.incomeMinor / maxVal) * 115));
        const spdH = Math.max(4, Math.round((d.spendMinor / maxVal) * 115));
        const spendPct = d.incomeMinor > 0 ? Math.round((d.spendMinor / d.incomeMinor) * 100) : 0;
        return (
          <div key={d.yearMonth} className="flex flex-col items-center gap-1.5">
            <div className="text-[10px] font-mono-num text-slate-500">
              {privacyMode
                ? `${spendPct}%`
                : formatDisplayValue(d.spendMinor, { currency, privacyMode: false, compact: true })}
            </div>
            <div className="w-full flex items-end justify-center gap-1.5 h-[118px] border-b border-slate-200 pb-1">
              <div
                title="Income"
                style={{ height: `${incH}px` }}
                className="w-3 rounded-t bg-teal-700/35 transition-all"
              />
              <div
                title="Spend & Preserved"
                style={{ height: `${spdH}px` }}
                className="w-3 rounded-t bg-slate-700/80 transition-all"
              />
            </div>
            <div className="text-[10px] font-mono-num text-slate-500">{d.yearMonth.slice(5)}</div>
          </div>
        );
      })}
    </div>
  );
};

/**
 * 3. Account Sufficiency Daily Runway Curve (Timeline Tab)
 */
export const DailyRunwayChart: React.FC<{
  curve: Array<{ day: number; balanceMinor: number; label?: string }>;
  currency: CurrencyCode;
  privacyMode: boolean;
}> = ({ curve, currency, privacyMode }) => {
  if (!curve.length) return null;
  const width = 760;
  const height = 150;
  const padX = 28;
  const padY = 18;

  const vals = curve.map((c) => c.balanceMinor);
  const minV = Math.min(0, ...vals);
  const maxV = Math.max(100, ...vals);
  const span = Math.max(1, maxV - minV);

  const toX = (idx: number) => padX + (idx / Math.max(1, curve.length - 1)) * (width - padX * 2);
  const toY = (v: number) => height - padY - ((v - minV) / span) * (height - padY * 2);
  const zeroY = toY(0);

  const linePoints = curve.map((pt, i) => `${toX(i).toFixed(1)},${toY(pt.balanceMinor).toFixed(1)}`).join(' ');
  const areaPoints = `${toX(0).toFixed(1)},${zeroY.toFixed(1)} ${linePoints} ${toX(curve.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
  const startRef = Math.max(1, Math.abs(curve[0]?.balanceMinor || maxV));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto">
      {/* Zero overdraft threshold line */}
      <line
        x1={padX}
        x2={width - padX}
        y1={zeroY}
        y2={zeroY}
        stroke="#EF4444"
        strokeDasharray="4 4"
        strokeOpacity={0.45}
      />
      <polygon points={areaPoints} fill="#0F766E" fillOpacity={0.1} />
      <polyline fill="none" stroke="#0F766E" strokeWidth={2} points={linePoints} />
      {curve.map((pt, idx) =>
        pt.label ? (
          <g key={pt.day}>
            <circle cx={toX(idx)} cy={toY(pt.balanceMinor)} r={3.5} fill="#0F766E" />
          </g>
        ) : null
      )}
      <text x={padX} y={12} className="fill-slate-500 text-[10px] font-mono-num">
        Day 1:{' '}
        {privacyMode
          ? '100%'
          : formatDisplayValue(curve[0].balanceMinor, { currency, privacyMode: false, compact: true })}
      </text>
      <text x={width - padX} y={12} textAnchor="end" className="fill-slate-600 text-[10px] font-mono-num">
        End of Month:{' '}
        {formatDisplayValue(curve[curve.length - 1].balanceMinor, {
          currency,
          privacyMode,
          referenceTotalMinor: startRef,
          compact: true,
        })}
      </text>
    </svg>
  );
};

/**
 * 4. Proportional Nested Pot Strip & Drilldown Visualization (Pots Tab)
 */
export const PotProportionStrip: React.FC<{
  nodes: PotRollupNode[];
  currency: CurrencyCode;
  privacyMode: boolean;
  selectedPotId: string | null;
  onSelectPot: (id: string | null) => void;
}> = ({ nodes, currency, privacyMode, selectedPotId, onSelectPot }) => {
  const active = nodes.filter((n) => n.effectiveTotalDisplayMinor > 0);
  const total = active.reduce((s, n) => s + n.effectiveTotalDisplayMinor, 0);
  if (!active.length || total <= 0) {
    return <div className="text-xs text-slate-400 font-mono-num">No pot allocations in this scope.</div>;
  }

  return (
    <div className="space-y-3">
      <div className="flex h-7 w-full overflow-hidden rounded-md border border-slate-200 bg-slate-100">
        {active.map((n) => {
          const pct = (n.effectiveTotalDisplayMinor / total) * 100;
          const isSel = selectedPotId === n.pot.id;
          return (
            <button
              key={n.pot.id}
              type="button"
              onClick={() => onSelectPot(isSel ? null : n.pot.id)}
              style={{ width: `${Math.max(2, pct)}%`, backgroundColor: n.pot.color || '#2E6F7E' }}
              className={`h-full transition-opacity hover:opacity-90 border-r border-white/40 ${
                selectedPotId && !isSel ? 'opacity-45' : 'opacity-90'
              }`}
              title={`${n.pot.name}: ${pct.toFixed(1)}%`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        {active.map((n) => {
          const isSel = selectedPotId === n.pot.id;
          return (
            <button
              key={n.pot.id}
              type="button"
              onClick={() => onSelectPot(isSel ? null : n.pot.id)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition ${
                isSel
                  ? 'border-slate-800 bg-slate-800 text-white'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: n.pot.color }} />
              <span>{n.pot.name}</span>
              <span className={`font-mono-num ${isSel ? 'text-slate-200' : 'text-slate-500'}`}>
                {formatDisplayValue(n.effectiveTotalDisplayMinor, {
                  currency,
                  privacyMode,
                  referenceTotalMinor: total,
                  compact: true,
                })}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
};

/**
 * 5. Long-Horizon Wealth & Belongings Forecast Chart (Wealth Tab)
 * Shows Historical Trajectory + Future 5..20Y Net Worth, Property Appreciation, Belongings Depreciation & Debt Paydown.
 */
export const WealthHorizonChart: React.FC<{
  history: Array<{ date: string; netWorthMinor: number }>;
  projection: HorizonProjectionPoint[];
  currency: CurrencyCode;
  privacyMode: boolean;
}> = ({ history, projection, currency, privacyMode }) => {
  if (!projection.length) return null;
  const width = 800;
  const height = 230;
  const padX = 36;
  const padY = 24;

  const histPoints = history.map((h) => ({
    year: Number(h.date.slice(0, 4)),
    netWorthMinor: h.netWorthMinor,
    propertyMinor: 0,
    liabilitiesMinor: 0,
    isHistory: true,
  }));

  const projPoints = projection.map((p) => ({
    year: p.year,
    netWorthMinor: p.netWorthMinor,
    totalAssetsMinor: p.totalAssetsMinor,
    propertyMinor: p.propertyMinor,
    liabilitiesMinor: p.totalLiabilitiesMinor,
    isHistory: false,
  }));

  const combined = [
    ...histPoints.filter((h) => h.year < projPoints[0].year),
    ...projPoints,
  ];

  const minYear = combined[0].year;
  const maxYear = combined[combined.length - 1].year;
  const yearSpan = Math.max(1, maxYear - minYear);

  const allVals = [
    0,
    ...combined.map((c) => c.netWorthMinor),
    ...projPoints.map((p) => p.totalAssetsMinor ?? p.netWorthMinor),
    ...projPoints.map((p) => -p.liabilitiesMinor),
  ];
  const minV = Math.min(0, ...allVals);
  const maxV = Math.max(100, ...allVals);
  const valSpan = Math.max(1, maxV - minV);

  const toX = (yr: number) => padX + ((yr - minYear) / yearSpan) * (width - padX * 2);
  const toY = (v: number) => height - padY - ((v - minV) / valSpan) * (height - padY * 2);
  const zeroY = toY(0);

  const nwLine = combined.map((c) => `${toX(c.year).toFixed(1)},${toY(c.netWorthMinor).toFixed(1)}`).join(' ');
  const nwArea = `${toX(combined[0].year).toFixed(1)},${zeroY.toFixed(1)} ${nwLine} ${toX(
    combined[combined.length - 1].year
  ).toFixed(1)},${zeroY.toFixed(1)}`;

  const debtLine = projPoints
    .map((p) => `${toX(p.year).toFixed(1)},${toY(-p.liabilitiesMinor).toFixed(1)}`)
    .join(' ');

  const baselineMinor = projPoints[0]?.netWorthMinor || 1;
  const nowX = toX(projPoints[0].year);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto select-none">
      {/* Zero axis */}
      <line x1={padX} x2={width - padX} y1={zeroY} y2={zeroY} stroke="#CBD5E1" strokeWidth={1} />
      {/* Today divider */}
      <line
        x1={nowX}
        x2={nowX}
        y1={padY - 6}
        y2={height - padY}
        stroke="#64748B"
        strokeDasharray="3 3"
        strokeOpacity={0.5}
      />
      <text x={nowX + 5} y={padY + 4} className="fill-slate-500 text-[10px] font-mono-num">
        Now ({projPoints[0].year})
      </text>

      {/* Net worth area & curve */}
      <polygon points={nwArea} fill="#1E5F74" fillOpacity={0.12} />
      <polyline fill="none" stroke="#1E5F74" strokeWidth={2.4} points={nwLine} />

      {/* Debt amortization curve below zero */}
      {projPoints.some((p) => p.liabilitiesMinor > 0) && (
        <polyline
          fill="none"
          stroke="#C2410C"
          strokeWidth={1.6}
          strokeDasharray="4 3"
          strokeOpacity={0.7}
          points={debtLine}
        />
      )}

      {/* Key milestone dots */}
      {[combined[0], projPoints[0], projPoints[projPoints.length - 1]].map((pt, i) => (
        <g key={`${pt.year}-${i}`}>
          <circle cx={toX(pt.year)} cy={toY(pt.netWorthMinor)} r={3.5} fill="#1E5F74" />
          <text
            x={toX(pt.year)}
            y={Math.max(12, toY(pt.netWorthMinor) - 8)}
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
            className="fill-slate-700 text-[10px] font-mono-num font-medium"
          >
            {pt.year}: {formatIndexedWealth(pt.netWorthMinor, baselineMinor, currency, privacyMode)}
          </text>
        </g>
      ))}
    </svg>
  );
};
