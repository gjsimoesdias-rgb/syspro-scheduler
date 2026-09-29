/**
 * GanttOperationBar — renders the segmented operation bar(s) for a single
 * scheduled operation inside a MachineGanttBoard lane.
 *
 * All time/position data is pre-computed by the parent so this component
 * only contains pure rendering logic. Includes the master/sub dependency
 * badge (M/S) driven by the depRole prop.
 */
import React from 'react';
import { format } from 'date-fns';
import { Lock, Unlock } from 'lucide-react';
import type { GanttSettingsState } from './GanttSettings';

export interface GanttOperationBarProps {
  // Keys / identifiers
  opKey: string;       // "jobId::opId"
  jobId: string;
  opId: string;
  sequence: number | string;
  workcentreId: string;

  // Flags
  isLocked: boolean;
  isHighlit: boolean;
  isViolated: boolean;
  isFocused: boolean;
  isSelected: boolean;
  isDraggable: boolean;

  // Visual
  opColor: string;
  jobStatus: string;
  rowIndex: number;
  prefs: GanttSettingsState;

  // Phase timestamps
  displayStart: Date;
  displayEnd: Date;
  setupStart: Date;
  setupEnd: Date;
  runStart: Date;
  runEnd: Date;

  // Phase durations (minutes)
  setupMin: number;
  runMin: number;
  queueMin: number;
  moveMin: number;
  durationH: number;

  // Job label metadata
  itemCode?: string;
  itemDesc?: string;
  qty?: string;

  /** Operation-level status from SYSPRO WipJobAllLab — drives the status strip colour */
  opStatus?: 'NotStarted' | 'InProgress' | 'Complete';

  /** Master/sub family role (SYSPRO WipMasterSub) — drives the M/S dependency badge */
  depRole?: 'master' | 'sub' | 'both' | null;
  /** The job's master job id (when it is a sub-job) — shown in badge tooltip */
  masterJobId?: string;

  // Segments — each segment is a continuous productive run-time slice
  displaySegments: Array<{ start: Date; end: Date }>;

  // Position helpers
  calculatePosition: (date: Date) => number;
  calculateWidth: (start: Date, end: Date) => number;

  // Event callbacks
  onDragStart: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Called with the pre-built tooltip content so parent can forward it to GanttTooltip. */
  onMouseEnter: (e: React.MouseEvent<HTMLDivElement>, content: React.ReactNode) => void;
  onMouseLeave: () => void;
  onToggleLock: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const overlapMs = (
  phaseStart: Date, phaseEnd: Date,
  segStart: Date, segEnd: Date,
): number =>
  Math.max(0,
    Math.min(phaseEnd.getTime(), segEnd.getTime()) -
    Math.max(phaseStart.getTime(), segStart.getTime())
  );

const safePct = (ms: number, totalMs: number): number =>
  totalMs > 0 ? Math.max(0, (ms / totalMs) * 100) : 0;

/** Lighten a #rrggbb hex toward white by `amt` (0–1). Used for the bar gradient. */
const lighten = (hex: string, amt: number): string => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  return `#${((1 << 24) + (mix(r) << 16) + (mix(g) << 8) + mix(b)).toString(16).slice(1)}`;
};

// ── Component ─────────────────────────────────────────────────────────────────

const GanttOperationBar: React.FC<GanttOperationBarProps> = ({
  opKey,
  jobId,
  opId,
  sequence,
  isLocked,
  isHighlit,
  isViolated,
  isFocused,
  isSelected,
  isDraggable,
  opColor,
  jobStatus,
  rowIndex,
  prefs,
  displayStart,
  displayEnd,
  setupStart,
  setupEnd,
  runStart,
  runEnd,
  setupMin,
  runMin,
  queueMin,
  moveMin,
  durationH,
  itemCode,
  itemDesc,
  qty,
  opStatus,
  depRole,
  masterJobId,
  displaySegments,
  calculatePosition,
  calculateWidth,
  onDragStart,
  onDragEnd,
  onClick,
  onContextMenu,
  onMouseEnter,
  onMouseLeave,
  onToggleLock,
}) => {
  // Display the SYSPRO job number without its leading zeros (e.g. 000000000038443 → 38443).
  const jobLabel = jobId.replace(/^0+/, '') || jobId;

  // Glossy, line-coloured fills: a top-lit gradient for the run phase and a
  // striped, lighter gradient for the setup phase.
  const runFill = `linear-gradient(180deg, ${lighten(opColor, 0.30)} 0%, ${opColor} 72%)`;
  const setupFill = `repeating-linear-gradient(-45deg, rgba(255,255,255,0.30) 0 3px, transparent 3px 6px), linear-gradient(180deg, ${lighten(opColor, 0.42)}, ${lighten(opColor, 0.18)})`;

  const tooltipContent = (
    <div className="gantt-tooltip-content">
      <div className="gantt-tt-row"><span>Job</span><strong>{jobLabel}</strong></div>
      {itemCode && <div className="gantt-tt-row"><span>Item</span><strong>{itemCode} {qty}</strong></div>}
      {itemDesc && <div className="gantt-tt-row gantt-tt-desc"><span>Desc</span><span>{itemDesc}</span></div>}
      <div className="gantt-tt-row"><span>Op</span><strong>{opId} (Seq {sequence || '?'})</strong></div>
      {depRole && (
        <div className="gantt-tt-row">
          <span>Family</span>
          <strong>
            {depRole === 'master'
              ? 'Master job — starts after its sub-jobs'
              : depRole === 'sub'
                ? `Sub-job of ${masterJobId ?? 'master'}`
                : `Master job · sub of ${masterJobId ?? '?'}`}
          </strong>
        </div>
      )}
      <div className="gantt-tt-divider" />
      <div className="gantt-tt-row phase-setup"><span>⚙ Setup</span><strong>{setupMin}m</strong></div>
      <div className="gantt-tt-row phase-run"><span>▶ Run</span><strong>{runMin}m</strong></div>
      <div className="gantt-tt-row phase-queue"><span>Queue</span><strong>{queueMin}m</strong></div>
      <div className="gantt-tt-row phase-move"><span>Move</span><strong>{moveMin}m</strong></div>
      <div className="gantt-tt-divider" />
      <div className="gantt-tt-row"><span>Start</span><strong>{format(displayStart, 'dd/MM HH:mm')}</strong></div>
      <div className="gantt-tt-row"><span>End</span><strong>{format(displayEnd, 'dd/MM HH:mm')}</strong></div>
      <div className="gantt-tt-row"><span>Split</span><strong>{displaySegments.length} segment(s)</strong></div>
      <div className="gantt-tt-row"><span>Total</span><strong>{durationH}h</strong></div>
      {isLocked && <div className="gantt-tt-locked"><Lock size={11} aria-hidden="true" /> LOCKED</div>}
    </div>
  );

  const barClassName = [
    'machine-op-bar segmented',
    isLocked ? 'locked' : '',
    isHighlit ? 'highlighted' : '',
    isViolated ? 'gantt-bar--violation' : '',
    isFocused ? 'gantt-bar--violation-focus' : '',
    isSelected ? 'selected' : '',
  ].filter(Boolean).join(' ');

  return (
    <React.Fragment>
      {displaySegments.map((segment, segmentIndex) => {
        const segmentMs = Math.max(1, segment.end.getTime() - segment.start.getTime());
        const setupPct = safePct(overlapMs(setupStart, setupEnd, segment.start, segment.end), segmentMs);
        const runPct   = safePct(overlapMs(runStart,   runEnd,   segment.start, segment.end), segmentMs);
        const hasPhases = setupPct > 0;
        const barLeft   = calculatePosition(segment.start);
        const barWidth  = calculateWidth(segment.start, segment.end);
        const showLabel = segmentIndex === 0 && barWidth >= prefs.labelMinWidth;
        const showLock  = segmentIndex === 0;

        return (
          <div
            key={`${opKey}-${segmentIndex}`}
            data-op-id={segmentIndex === 0 ? opId : undefined}
            className={barClassName}
            draggable={isDraggable && !isLocked}
            onDragStart={isLocked ? (e) => e.preventDefault() : onDragStart}
            onDragEnd={onDragEnd}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onMouseEnter={(e) => onMouseEnter(e, tooltipContent)}
            onMouseLeave={onMouseLeave}
            style={{
              left: `${barLeft}px`,
              width: `${barWidth}px`,
              top: `${1 + rowIndex * prefs.rowHeight}px`,
              height: `${Math.max(22, prefs.rowHeight - 4)}px`,
              borderColor: isHighlit ? '#f59e0b' : opColor,
              opacity: isLocked ? Math.min(prefs.barOpacity, 0.75) : prefs.barOpacity,
              outline: isHighlit ? '3px solid #f59e0b' : undefined,
              background: 'transparent',
              borderRadius: prefs.opBarRadius,
            }}
            title={`${jobLabel} / Op ${opId} (Seq ${sequence || '?'})${displaySegments.length > 1 ? ` • Segment ${segmentIndex + 1}/${displaySegments.length}` : ''}${isLocked ? ' [LOCKED]' : ''}`}
          >
            <div className="op-phases">
              {prefs.barStyle === 'segmented' && setupPct > 0 && (
                <div
                  className="op-phase phase-setup"
                  style={{ width: `${setupPct}%`, background: setupFill }}
                  title={`Setup: ${setupMin}m`}
                />
              )}
              {prefs.barStyle === 'segmented' && runPct > 0 && (
                <div
                  className="op-phase phase-run"
                  style={{ width: `${runPct}%`, background: runFill }}
                  title={`Run: ${runMin}m`}
                />
              )}
              {(prefs.barStyle === 'solid' || (!hasPhases && runPct === 0)) && (
                <div
                  className="op-phase phase-run"
                  style={{ width: '100%', background: runFill }}
                />
              )}
            </div>

            {showLabel && (
              <span className="op-bar-label">
                <strong>{jobLabel}</strong>
                {itemCode && <small> · {itemCode}</small>}
                {prefs.showOperationSeq && <small> · Op{sequence || ''}</small>}
              </span>
            )}

            {segmentIndex === 0 && depRole && (
              <span
                className={`op-dep-badge op-dep-badge--${depRole}`}
                title={
                  depRole === 'master'
                    ? 'Master job — must start after all its sub-jobs finish'
                    : depRole === 'sub'
                      ? `Sub-job — must finish before master ${masterJobId ?? ''} starts`
                      : `Master job that also feeds ${masterJobId ?? 'another master'}`
                }
                aria-label={`Dependency role: ${depRole}`}
              >
                {depRole === 'master' ? 'M' : depRole === 'sub' ? 'S' : 'MS'}
              </span>
            )}

            {showLock && (
              <button
                className="op-lock-btn"
                onClick={(e) => { e.stopPropagation(); onToggleLock(); }}
                title={isLocked ? 'Unlock operation' : 'Lock operation'}
              >
                {isLocked ? <Lock size={11} aria-hidden="true" /> : <Unlock size={11} aria-hidden="true" />}
              </button>
            )}

            {/* Op-status strip — thin colored line at base of bar */}
            <span
              className={`op-status-strip op-status-strip--${
                jobStatus === 'ConstraintViolation' ? 'violation'
                : jobStatus === 'Unschedulable' ? 'unschedulable'
                : opStatus === 'Complete' ? 'complete'
                : opStatus === 'InProgress' ? 'in-progress'
                : 'ok'
              }`}
              title={opStatus ?? 'NotStarted'}
              aria-hidden="true"
            />
          </div>
        );
      })}
    </React.Fragment>
  );
};

export default React.memo(GanttOperationBar);
