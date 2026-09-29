/**
 * MasterJobTree — the "Job Tree" content tab.
 *
 * A READ-ONLY, job-level Gantt for master/sub-job families: one row per job
 * (master + its sub-jobs, hierarchy shown in the label column), one bar per
 * job on a shared timeline, with dependency arrows (sub end → master start),
 * due-date markers, a today line, family KPI cards, and bottleneck
 * detection. No scheduling happens here — bars cannot be dragged.
 *
 * Analysis logic lives in utils/familyAnalysis (pure, unit-tested); this
 * component is rendering + family selection only.
 */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Clock,
  Factory, Flame, GitBranch, Layers, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { Job, Schedule } from '../types';
import { buildParentMap, getMasterRootJobId } from '../utils/masterSub';
import { analyzeFamily, listFamilyRoots, type FamilyAnalysis, type JobNodeAnalysis } from '../utils/familyAnalysis';
import './MasterJobTree.css';

interface MasterJobTreeProps {
  jobs: Job[];
  schedule: Schedule | null;
  /** Currently highlighted job — used to auto-select its family. */
  highlightJobId?: string | null;
  /** Highlight a job and jump to the Gantt tab. */
  onShowOnGantt?: (jobId: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_H = 34;
const LABEL_W = 250;

// ── Formatting helpers ────────────────────────────────────────────────────────

const fmtDate = (ms: number | null): string =>
  ms === null ? '—' : format(new Date(ms), 'dd MMM HH:mm');

const fmtHours = (minutes: number): string => {
  const h = minutes / 60;
  return h >= 100 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
};

const fmtDays = (ms: number): string => {
  const days = ms / DAY_MS;
  const abs = Math.abs(days);
  if (abs >= 2) return `${Math.round(abs * 10) / 10}d`;
  const hours = Math.abs(ms) / (60 * 60 * 1000);
  return `${Math.round(hours * 10) / 10}h`;
};

// ── KPI header ────────────────────────────────────────────────────────────────

const FamilyKpis: React.FC<{ analysis: FamilyAnalysis }> = ({ analysis }) => {
  const {
    jobCount, scheduledCount, familyStartMs, familyEndMs, totalWorkMinutes,
    masterLatenessMs, bottleneckJobId, bottleneckSlackMs, bottleneckOp,
    topWorkcentre, violations,
  } = analysis;

  const makespan = familyStartMs !== null && familyEndMs !== null && familyEndMs > familyStartMs
    ? fmtDays(familyEndMs - familyStartMs)
    : '—';

  return (
    <div className="jobtree-kpis">
      <div className="jobtree-kpi">
        <span className="jobtree-kpi-label"><Layers size={12} aria-hidden="true" /> Jobs</span>
        <strong>{jobCount}</strong>
        <small>{scheduledCount} scheduled</small>
      </div>
      <div className="jobtree-kpi">
        <span className="jobtree-kpi-label"><CalendarClock size={12} aria-hidden="true" /> Family window</span>
        <strong>{makespan}</strong>
        <small>{fmtDate(familyStartMs)} → {fmtDate(familyEndMs)}</small>
      </div>
      <div className="jobtree-kpi">
        <span className="jobtree-kpi-label"><Clock size={12} aria-hidden="true" /> Total work</span>
        <strong>{fmtHours(totalWorkMinutes)}</strong>
        <small>setup + run, whole family</small>
      </div>
      <div className={`jobtree-kpi${masterLatenessMs !== null && masterLatenessMs > 0 ? ' jobtree-kpi--bad' : ''}`}>
        <span className="jobtree-kpi-label"><CalendarClock size={12} aria-hidden="true" /> Master due</span>
        <strong>
          {masterLatenessMs === null ? '—' : masterLatenessMs > 0 ? `Late ${fmtDays(masterLatenessMs)}` : `On time`}
        </strong>
        <small>{masterLatenessMs !== null && masterLatenessMs <= 0 ? `${fmtDays(-masterLatenessMs)} of slack` : 'vs SYSPRO delivery date'}</small>
      </div>
      <div className={`jobtree-kpi jobtree-kpi--hot${bottleneckSlackMs !== null && bottleneckSlackMs < 0 ? ' jobtree-kpi--bad' : ''}`}>
        <span className="jobtree-kpi-label"><Flame size={12} aria-hidden="true" /> Bottleneck job</span>
        <strong>{bottleneckJobId ?? '—'}</strong>
        <small>
          {bottleneckSlackMs === null
            ? 'gates the master start'
            : bottleneckSlackMs < 0
              ? `overruns master start by ${fmtDays(-bottleneckSlackMs)}`
              : `${fmtDays(bottleneckSlackMs)} gap to master start`}
        </small>
      </div>
      <div className="jobtree-kpi jobtree-kpi--hot">
        <span className="jobtree-kpi-label"><Flame size={12} aria-hidden="true" /> Bottleneck operation</span>
        <strong>{bottleneckOp ? `${bottleneckOp.opId}` : '—'}</strong>
        <small>{bottleneckOp ? `${bottleneckOp.workcentreId} · ${fmtHours(bottleneckOp.minutes)} · ${bottleneckOp.jobId}` : 'longest op on the critical chain'}</small>
      </div>
      <div className="jobtree-kpi">
        <span className="jobtree-kpi-label"><Factory size={12} aria-hidden="true" /> Top workcentre</span>
        <strong>{topWorkcentre?.workcentreId ?? '—'}</strong>
        <small>{topWorkcentre ? `${fmtHours(topWorkcentre.minutes)} of family work` : ''}</small>
      </div>
      <div className={`jobtree-kpi${violations.length ? ' jobtree-kpi--bad' : ''}`}>
        <span className="jobtree-kpi-label"><AlertTriangle size={12} aria-hidden="true" /> Precedence</span>
        <strong>{violations.length ? `${violations.length} violated` : 'OK'}</strong>
        <small>{violations.length ? violations.map((v) => v.subId).join(', ') : 'subs finish before masters start'}</small>
      </div>
    </div>
  );
};

// ── Timeline (read-only job-level Gantt) ──────────────────────────────────────

interface TimelineRow {
  node: JobNodeAnalysis;
  isRoot: boolean;
  hasChildren: boolean;
}

const FamilyTimeline: React.FC<{
  analysis: FamilyAnalysis;
  collapsed: Set<string>;
  onToggle: (jobId: string) => void;
  onShowOnGantt?: (jobId: string) => void;
}> = ({ analysis, collapsed, onToggle, onShowOnGantt }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState(800);
  /** null = fit the whole family window to the available width */
  const [pxPerDay, setPxPerDay] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      if (scrollRef.current) {
        setLaneWidth(Math.max(300, scrollRef.current.clientWidth - LABEL_W - 12));
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // Flatten the tree in hierarchy order, honouring collapsed branches.
  const rows = useMemo((): TimelineRow[] => {
    const out: TimelineRow[] = [];
    const walk = (node: JobNodeAnalysis, isRoot: boolean) => {
      out.push({ node, isRoot, hasChildren: node.children.length > 0 });
      if (!collapsed.has(node.jobId)) node.children.forEach((c) => walk(c, false));
    };
    walk(analysis.root, true);
    return out;
  }, [analysis, collapsed]);

  // Timeline domain: cover every bar and due marker, padded one day each side.
  const domain = useMemo(() => {
    let min: number | null = null;
    let max: number | null = null;
    const extend = (ms: number | null) => {
      if (ms === null) return;
      if (min === null || ms < min) min = ms;
      if (max === null || ms > max) max = ms;
    };
    for (const row of rows) {
      extend(row.node.startMs);
      extend(row.node.endMs);
      extend(row.node.dueMs);
    }
    const now = Date.now();
    const start = (min ?? now) - DAY_MS;
    const end = Math.max((max ?? now + 28 * DAY_MS) + DAY_MS, start + 2 * DAY_MS);
    return { start, end, days: Math.ceil((end - start) / DAY_MS) };
  }, [rows]);

  const fitPx = Math.max(4, (laneWidth - 8) / domain.days);
  const effPx = pxPerDay ?? fitPx;
  const timelineW = Math.ceil(domain.days * effPx);
  const xOf = (ms: number): number =>
    Math.max(0, Math.min(timelineW, ((ms - domain.start) / DAY_MS) * effPx));

  // Axis ticks roughly every 80px, snapped to whole days.
  const ticks = useMemo(() => {
    const stepDays = Math.max(1, Math.round(80 / effPx));
    const list: Array<{ x: number; label: string }> = [];
    const first = new Date(domain.start);
    first.setHours(0, 0, 0, 0);
    for (let ms = first.getTime(); ms <= domain.end; ms += stepDays * DAY_MS) {
      list.push({ x: xOf(ms), label: format(new Date(ms), stepDays >= 7 ? 'dd MMM' : 'EEE dd MMM') });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.start, domain.end, effPx, timelineW]);

  // Weekend shading (skip when it would mean too many DOM nodes).
  const weekendBands = useMemo(() => {
    if (domain.days > 370) return [];
    const bands: Array<{ x: number; w: number }> = [];
    const cursor = new Date(domain.start);
    cursor.setHours(0, 0, 0, 0);
    while (cursor.getTime() < domain.end) {
      const day = cursor.getDay();
      if (day === 0 || day === 6) {
        bands.push({ x: xOf(cursor.getTime()), w: Math.max(1, effPx) });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
    return bands;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain.start, domain.end, effPx, timelineW]);

  const nowX = Date.now() >= domain.start && Date.now() <= domain.end ? xOf(Date.now()) : null;

  // Dependency arrows: sub-job bar end → parent bar start (visible rows only).
  const rowIndexById = useMemo(() => {
    const map = new Map<string, number>();
    rows.forEach((row, i) => map.set(row.node.jobId, i));
    return map;
  }, [rows]);

  const arrows = useMemo(() => {
    const list: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; violated: boolean; title: string }> = [];
    const walk = (parent: JobNodeAnalysis) => {
      for (const child of parent.children) {
        const pi = rowIndexById.get(parent.jobId);
        const ci = rowIndexById.get(child.jobId);
        if (pi !== undefined && ci !== undefined && child.endMs !== null && parent.startMs !== null) {
          const violated = child.dateSource === 'scheduled' && parent.dateSource === 'scheduled' && child.endMs > parent.startMs;
          list.push({
            key: `${child.jobId}->${parent.jobId}`,
            x1: xOf(child.endMs),
            y1: ci * ROW_H + ROW_H / 2,
            x2: xOf(parent.startMs),
            y2: pi * ROW_H + ROW_H / 2,
            violated,
            title: `${child.jobId} must finish before ${parent.jobId} starts${violated ? ' — VIOLATED' : ''}`,
          });
        }
        walk(child);
      }
    };
    walk(analysis.root);
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, rowIndexById, effPx, timelineW, domain.start]);

  const bodyH = rows.length * ROW_H;

  return (
    <div className="jobtree-timeline">
      <div className="jobtree-tl-toolbar">
        <span className="jobtree-tl-hint">Read-only view — schedule changes happen on the Gantt tab.</span>
        <div className="jobtree-tl-zoom">
          <button className="jobtree-tl-btn" onClick={() => setPxPerDay(Math.max(4, (pxPerDay ?? fitPx) / 1.5))} title="Zoom out">
            <ZoomOut size={12} aria-hidden="true" />
          </button>
          <button className={`jobtree-tl-btn${pxPerDay === null ? ' active' : ''}`} onClick={() => setPxPerDay(null)} title="Fit the whole family window">
            Fit
          </button>
          <button className="jobtree-tl-btn" onClick={() => setPxPerDay(Math.min(400, (pxPerDay ?? fitPx) * 1.5))} title="Zoom in">
            <ZoomIn size={12} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="jobtree-tl-scroll" ref={scrollRef}>
        <div className="jobtree-tl-grid" style={{ minWidth: LABEL_W + timelineW }}>
          {/* Header */}
          <div className="jobtree-tl-header" style={{ height: 26 }}>
            <div className="jobtree-tl-label-col jobtree-tl-label-head" style={{ width: LABEL_W, minWidth: LABEL_W }}>
              Job
            </div>
            <div className="jobtree-tl-lane-head" style={{ width: timelineW }}>
              {ticks.map((t, i) => (
                <span key={i} className="jobtree-tl-tick" style={{ left: t.x }}>{t.label}</span>
              ))}
            </div>
          </div>

          {/* Rows */}
          <div className="jobtree-tl-body" style={{ height: bodyH }}>
            {/* Label column */}
            <div className="jobtree-tl-label-col" style={{ width: LABEL_W, minWidth: LABEL_W }}>
              {rows.map(({ node, isRoot, hasChildren }) => {
                const isBottleneck = node.jobId === analysis.bottleneckJobId;
                return (
                  <div
                    key={node.jobId}
                    className={`jobtree-tl-label${node.onCriticalChain ? ' critical' : ''}`}
                    style={{ height: ROW_H, paddingLeft: 6 + node.depth * 16 }}
                    title={node.job ? String(node.job.description || node.job.itemCode || '') : 'Not among the loaded open jobs (probably completed/closed)'}
                  >
                    {hasChildren ? (
                      <button
                        className="jobtree-toggle"
                        onClick={() => onToggle(node.jobId)}
                        title={collapsed.has(node.jobId) ? 'Expand sub-jobs' : 'Collapse sub-jobs'}
                        aria-label={collapsed.has(node.jobId) ? 'Expand' : 'Collapse'}
                      >
                        {collapsed.has(node.jobId) ? <ChevronRight size={12} aria-hidden="true" /> : <ChevronDown size={12} aria-hidden="true" />}
                      </button>
                    ) : (
                      <span className="jobtree-toggle jobtree-toggle--leaf" aria-hidden="true" />
                    )}
                    <span className={`jobtree-role ${isRoot ? 'jobtree-role--m' : 'jobtree-role--s'}`}>{isRoot ? 'M' : 'S'}</span>
                    <button className="jobtree-jobid" onClick={() => onShowOnGantt?.(node.jobId)} title="Highlight on the Gantt board">
                      {node.jobId}
                    </button>
                    {isBottleneck && <Flame size={12} className="jobtree-flame" aria-label="Bottleneck job" />}
                    {node.latenessMs !== null && node.latenessMs > 0 && (
                      <span className="jobtree-late-dot" title={`Late ${fmtDays(node.latenessMs)} vs due date`} />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Timeline lane */}
            <div className="jobtree-tl-lane" style={{ width: timelineW, height: bodyH }}>
              {/* Weekend shading */}
              {weekendBands.map((b, i) => (
                <div key={i} className="jobtree-tl-weekend" style={{ left: b.x, width: b.w }} />
              ))}
              {/* Row separators */}
              {rows.map((_, i) => (
                <div key={i} className="jobtree-tl-rowline" style={{ top: (i + 1) * ROW_H - 1 }} />
              ))}
              {/* Today line */}
              {nowX !== null && <div className="jobtree-tl-now" style={{ left: nowX }} title="Now" />}

              {/* Bars */}
              {rows.map(({ node, isRoot }, i) => {
                if (node.startMs === null || node.endMs === null) {
                  return (
                    <span key={node.jobId} className="jobtree-tl-nodates" style={{ top: i * ROW_H + ROW_H / 2 - 7 }}>
                      no dates
                    </span>
                  );
                }
                const left = xOf(node.startMs);
                const width = Math.max(6, xOf(node.endMs) - left);
                const isBottleneck = node.jobId === analysis.bottleneckJobId;
                const late = node.latenessMs !== null && node.latenessMs > 0;
                const cls = [
                  'jobtree-tl-bar',
                  isRoot ? 'jobtree-tl-bar--master' : '',
                  node.onCriticalChain && !isRoot ? 'jobtree-tl-bar--critical' : '',
                  isBottleneck ? 'jobtree-tl-bar--bottleneck' : '',
                  node.dateSource === 'syspro' ? 'jobtree-tl-bar--planned' : '',
                  late ? 'jobtree-tl-bar--late' : '',
                ].filter(Boolean).join(' ');
                const title = [
                  `${node.jobId}${isRoot ? ' (master)' : ''}${isBottleneck ? ' — BOTTLENECK' : node.onCriticalChain && !isRoot ? ' — critical chain' : ''}`,
                  `${fmtDate(node.startMs)} → ${fmtDate(node.endMs)}${node.dateSource === 'syspro' ? ' (SYSPRO planned, not scheduled)' : ''}`,
                  node.dueMs !== null ? `Due ${fmtDate(node.dueMs)}${node.latenessMs !== null ? ` · ${node.latenessMs > 0 ? `late ${fmtDays(node.latenessMs)}` : `on time (+${fmtDays(-node.latenessMs)})`}` : ''}` : '',
                  `${node.scheduled ? `Scheduled ${node.scheduledOpsCount}/${node.opsCount} ops` : `Unscheduled · ${node.opsCount} ops`} · work ${fmtHours(node.workMinutes)}`,
                  node.longestOp ? `Longest op: ${node.longestOp.opId} · ${node.longestOp.workcentreId} · ${fmtHours(node.longestOp.minutes)}` : '',
                ].filter(Boolean).join('\n');

                return (
                  <React.Fragment key={node.jobId}>
                    <div
                      className={cls}
                      style={{ left, width, top: i * ROW_H + 6, height: ROW_H - 12 }}
                      title={title}
                    >
                      {width > 90 && (
                        <span className="jobtree-tl-bar-label">
                          {format(new Date(node.startMs), 'dd/MM')}–{format(new Date(node.endMs), 'dd/MM')}
                          {` · ${fmtHours(node.workMinutes)}`}
                        </span>
                      )}
                      {isBottleneck && width > 24 && <Flame size={11} className="jobtree-tl-bar-flame" aria-hidden="true" />}
                    </div>
                    {/* Due-date marker */}
                    {node.dueMs !== null && (
                      <div
                        className={`jobtree-tl-due${late ? ' late' : ''}`}
                        style={{ left: xOf(node.dueMs), top: i * ROW_H + 3, height: ROW_H - 6 }}
                        title={`${node.jobId} due ${fmtDate(node.dueMs)}`}
                      />
                    )}
                  </React.Fragment>
                );
              })}

              {/* Dependency arrows */}
              {arrows.length > 0 && (
                <svg className="jobtree-tl-arrows" width={timelineW} height={bodyH} aria-hidden="true">
                  <defs>
                    <marker id="jobtree-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--accent, #4f8bff)" />
                    </marker>
                    <marker id="jobtree-arrow-bad" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--status-error, #ef4444)" />
                    </marker>
                  </defs>
                  {arrows.map((a) => {
                    const stroke = a.violated ? 'var(--status-error, #ef4444)' : 'var(--accent, #4f8bff)';
                    const midX = a.x1 + Math.max(10, (a.x2 - a.x1) / 2);
                    return (
                      <g key={a.key}>
                        <title>{a.title}</title>
                        <path
                          d={`M ${a.x1} ${a.y1} L ${midX} ${a.y1} L ${midX} ${a.y2} L ${a.x2} ${a.y2}`}
                          fill="none"
                          stroke={stroke}
                          strokeWidth={1.4}
                          strokeDasharray={a.violated ? '3 3' : '6 3'}
                          markerEnd={a.violated ? 'url(#jobtree-arrow-bad)' : 'url(#jobtree-arrow)'}
                          opacity={0.85}
                        />
                        <circle cx={a.x1} cy={a.y1} r={2.4} fill={stroke} />
                      </g>
                    );
                  })}
                </svg>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="jobtree-legend">
        <span><i className="jobtree-lg jobtree-lg--master" /> Master</span>
        <span><i className="jobtree-lg jobtree-lg--sub" /> Sub-job</span>
        <span><i className="jobtree-lg jobtree-lg--critical" /> Critical chain</span>
        <span><i className="jobtree-lg jobtree-lg--bottleneck" /> Bottleneck</span>
        <span><i className="jobtree-lg jobtree-lg--planned" /> SYSPRO planned (unscheduled)</span>
        <span><i className="jobtree-lg jobtree-lg--due" /> Due date</span>
        <span><i className="jobtree-lg jobtree-lg--arrow" /> Dependency (sub → master)</span>
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const MasterJobTree: React.FC<MasterJobTreeProps> = ({ jobs, schedule, highlightJobId, onShowOnGantt }) => {
  const parentMap = useMemo(() => buildParentMap(jobs), [jobs]);
  const familyRoots = useMemo(() => listFamilyRoots(jobs, parentMap), [jobs, parentMap]);

  const highlightRoot = useMemo(() => {
    if (!highlightJobId) return null;
    const root = getMasterRootJobId(highlightJobId, parentMap);
    return familyRoots.includes(root) ? root : null;
  }, [highlightJobId, parentMap, familyRoots]);

  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const activeRoot = selectedRoot && familyRoots.includes(selectedRoot)
    ? selectedRoot
    : highlightRoot ?? familyRoots[0] ?? null;

  const analysis = useMemo(
    () => (activeRoot ? analyzeFamily(activeRoot, jobs, parentMap, schedule) : null),
    [activeRoot, jobs, parentMap, schedule]
  );

  // Sidebar entries with a status dot per family (precomputed cheaply).
  const familySummaries = useMemo(() =>
    familyRoots.map((rootId) => {
      const fam = analyzeFamily(rootId, jobs, parentMap, schedule);
      const status: 'violated' | 'late' | 'ok' =
        fam.violations.length > 0 ? 'violated'
        : fam.masterLatenessMs !== null && fam.masterLatenessMs > 0 ? 'late'
        : 'ok';
      return { rootId, jobCount: fam.jobCount, scheduledCount: fam.scheduledCount, status };
    }),
  [familyRoots, jobs, parentMap, schedule]);

  const visibleFamilies = search.trim()
    ? familySummaries.filter((f) => f.rootId.toLowerCase().includes(search.trim().toLowerCase()))
    : familySummaries;

  const toggleCollapsed = (jobId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  };

  if (familyRoots.length === 0) {
    return (
      <div className="jobtree-empty">
        <GitBranch size={28} aria-hidden="true" />
        <h3>No master/sub-job families found</h3>
        <p>
          None of the loaded open jobs reference a master job (SYSPRO WipMasterSub).
          Once jobs with master/sub links are loaded, their hierarchy, dates, KPIs
          and bottlenecks will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="jobtree">
      <aside className="jobtree-sidebar">
        <div className="jobtree-sidebar-head">
          <h3><GitBranch size={13} aria-hidden="true" /> Master jobs</h3>
          <input
            className="jobtree-search"
            placeholder="Filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <ul className="jobtree-family-list">
          {visibleFamilies.map((fam) => (
            <li key={fam.rootId}>
              <button
                className={`jobtree-family${fam.rootId === activeRoot ? ' active' : ''}`}
                onClick={() => setSelectedRoot(fam.rootId)}
                title={`${fam.jobCount} jobs · ${fam.scheduledCount} scheduled`}
              >
                <span className={`jobtree-dot jobtree-dot--${fam.status}`} aria-hidden="true" />
                <span className="jobtree-family-id">{fam.rootId}</span>
                <span className="jobtree-family-count">{fam.jobCount - 1} subs</span>
              </button>
            </li>
          ))}
          {visibleFamilies.length === 0 && (
            <li className="jobtree-family-none">No families match “{search}”</li>
          )}
        </ul>
      </aside>

      <section className="jobtree-main">
        {analysis && (
          <>
            <FamilyKpis analysis={analysis} />
            <FamilyTimeline
              analysis={analysis}
              collapsed={collapsed}
              onToggle={toggleCollapsed}
              onShowOnGantt={onShowOnGantt}
            />
            <p className="jobtree-footnote">
              Rule: every sub-job must finish before its master starts. The <strong>bottleneck job</strong> is
              the sub-job whose end date gates the master; the <strong>critical chain</strong> is the path of
              gating jobs; the <strong>bottleneck operation</strong> is the longest operation on that chain.
              Click a job number to highlight it on the Gantt board.
            </p>
          </>
        )}
      </section>
    </div>
  );
};

export default MasterJobTree;
