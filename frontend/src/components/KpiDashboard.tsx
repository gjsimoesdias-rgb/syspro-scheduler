import React from 'react';
import {
  ListChecks,
  CheckCircle2,
  Clock,
  Factory,
  AlertTriangle,
  Moon,
  GitCommitHorizontal,
  Wrench,
} from 'lucide-react';
import { Schedule } from '../types';
import './KpiDashboard.css';

/** Map an emoji-free `icon` field to a lucide component. */
const KPI_ICONS = {
  scheduled: ListChecks,
  onTime: CheckCircle2,
  tardiness: Clock,
  utilization: Factory,
  violations: AlertTriangle,
  overtime: Moon,
  criticalPath: GitCommitHorizontal,
  setup: Wrench,
} as const;

interface KpiDashboardProps {
  schedule: Schedule | null;
  jobsTotal: number;
}

const KpiDashboard: React.FC<KpiDashboardProps> = ({ schedule, jobsTotal }) => {
  if (!schedule) {
    return (
      <div className="kpi-dashboard empty">
        <p>Generate a schedule to view KPIs.</p>
      </div>
    );
  }

  const {
    totalJobsScheduled,
    jobsOnTime,
    jobsTardy,
    averageTardiness,
    resourceUtilization,
    overtimeHours,
    criticalPathLength,
    totalSetupTime,
    operatingHours,
    busyHours,
    productivePct,
    directDowntimePct,
    idlePct,
    avgLeadTimeDays,
  } = schedule.metrics;
  const hasTimeModel = typeof operatingHours === 'number' && operatingHours > 0;

  const onTimePct = totalJobsScheduled > 0 ? Math.round((jobsOnTime / totalJobsScheduled) * 100) : 0;
  const schedCoverage = jobsTotal > 0 ? Math.round((totalJobsScheduled / jobsTotal) * 100) : 0;
  const violations = schedule.constraintViolations.length;
  const criticalCount = schedule.constraintViolations.filter(v => v.severity === 'Critical').length;
  // totalSetupTime is already in hours (was divided by 60 again, showing 1/60th).
  const setupHours = Math.round((totalSetupTime || 0) * 10) / 10;
  const utilPct = Math.round(resourceUtilization || 0);

  // Color tokens — defer to CSS vars so dark/light themes stay consistent.
  const COLOR_OK = 'var(--status-ok)';
  const COLOR_WARN = 'var(--status-warn)';
  const COLOR_BAD = 'var(--status-bad)';
  const COLOR_INFO = 'var(--accent)';

  const tiles: Array<{
    label: string;
    value: string | number;
    sub: string;
    color: string;
    iconKey: keyof typeof KPI_ICONS;
  }> = [
    {
      label: 'Scheduled Jobs',
      value: totalJobsScheduled,
      sub: `${schedCoverage}% of ${jobsTotal} total`,
      color: schedCoverage >= 80 ? COLOR_OK : COLOR_WARN,
      iconKey: 'scheduled',
    },
    {
      label: 'On-Time Delivery',
      value: `${onTimePct}%`,
      sub: `${jobsOnTime} on time, ${jobsTardy} tardy`,
      color: onTimePct >= 80 ? COLOR_OK : onTimePct >= 60 ? COLOR_WARN : COLOR_BAD,
      iconKey: 'onTime',
    },
    {
      label: 'Avg Tardiness',
      value: `${averageTardiness.toFixed(1)}d`,
      sub: averageTardiness <= 0 ? 'No tardiness' : `${jobsTardy} jobs late`,
      color: averageTardiness <= 0 ? COLOR_OK : averageTardiness <= 2 ? COLOR_WARN : COLOR_BAD,
      iconKey: 'tardiness',
    },
    {
      label: 'Resource Utilization',
      value: `${utilPct}%`,
      sub: hasTimeModel
        ? `${Math.round(busyHours || 0)}h booked of ${Math.round(operatingHours || 0)}h shift time`
        : utilPct >= 85
        ? 'High load — check bottlenecks'
        : utilPct >= 60
        ? 'Good balance'
        : 'Capacity available',
      color: utilPct >= 95 ? COLOR_BAD : utilPct >= 75 ? COLOR_WARN : COLOR_OK,
      iconKey: 'utilization',
    },
    {
      label: 'Constraint Violations',
      value: violations,
      sub: `${criticalCount} critical`,
      color: violations === 0 ? COLOR_OK : criticalCount > 0 ? COLOR_BAD : COLOR_WARN,
      iconKey: 'violations',
    },
    {
      label: 'Overtime Hours',
      value: `${Math.round(overtimeHours || 0)}h`,
      sub: overtimeHours > 0 ? 'Overtime used' : 'No overtime',
      color: overtimeHours <= 0 ? COLOR_OK : overtimeHours <= 8 ? COLOR_WARN : COLOR_BAD,
      iconKey: 'overtime',
    },
    {
      label: 'Critical Path',
      // criticalPathLength is in hours (the tile said days).
      value: `${Math.round(criticalPathLength || 0)}h`,
      sub: 'Longest job chain',
      color: COLOR_INFO,
      iconKey: 'criticalPath',
    },
    {
      label: 'Total Setup Time',
      value: `${setupHours}h`,
      sub: 'Setup / changeover',
      color: COLOR_INFO,
      iconKey: 'setup',
    },
    ...(typeof avgLeadTimeDays === 'number'
      ? [{
          label: 'Avg Lead Time',
          value: `${avgLeadTimeDays.toFixed(1)}d`,
          sub: 'Planned start → finish',
          color: COLOR_INFO,
          iconKey: 'criticalPath' as const,
        }]
      : []),
  ];

  return (
    <div className="kpi-dashboard">
      <div className="kpi-header">
        <h3>KPI Dashboard</h3>
        <span className="kpi-schedule-id">Schedule: {schedule.scheduleId} | {schedule.status}</span>
      </div>
      <div className="kpi-tiles">
        {tiles.map((tile) => {
          const Icon = KPI_ICONS[tile.iconKey];
          return (
            <div className="kpi-tile" key={tile.label} style={{ borderTopColor: tile.color }}>
              <div className="kpi-tile-icon" style={{ color: tile.color }}>
                <Icon size={18} aria-hidden="true" />
              </div>
              <div className="kpi-tile-value" style={{ color: tile.color }}>
                {tile.value}
              </div>
              <div className="kpi-tile-label">{tile.label}</div>
              <div className="kpi-tile-sub">{tile.sub}</div>
            </div>
          );
        })}
      </div>

      <div className="kpi-utilbar-section">
        <div className="kpi-util-label">Overall Utilization</div>
        <div className="kpi-util-track">
          <div
            className="kpi-util-fill"
            style={{
              width: `${utilPct}%`,
              background:
                utilPct >= 95 ? COLOR_BAD : utilPct >= 75 ? COLOR_WARN : COLOR_OK,
            }}
          />
          <span className="kpi-util-pct">{utilPct}%</span>
        </div>
      </div>

      {hasTimeModel && (
        <div className="kpi-utilbar-section">
          <div className="kpi-util-label">Line time over the horizon</div>
          <div className="kpi-util-track kpi-util-track--stacked" title="Share of shift (operating) time">
            <div className="kpi-util-fill" style={{ width: `${productivePct || 0}%`, background: COLOR_OK }} />
            <div className="kpi-util-fill" style={{ width: `${directDowntimePct || 0}%`, background: COLOR_WARN }} />
            <span className="kpi-util-pct">
              Run {Math.round(productivePct || 0)}% · Setup {Math.round(directDowntimePct || 0)}% · Idle {Math.round(idlePct || 0)}%
            </span>
          </div>
        </div>
      )}

      <div className="kpi-utilbar-section">
        <div className="kpi-util-label">Schedule Coverage</div>
        <div className="kpi-util-track">
          <div
            className="kpi-util-fill"
            style={{
              width: `${schedCoverage}%`,
              background: schedCoverage >= 80 ? COLOR_OK : COLOR_WARN,
            }}
          />
          <span className="kpi-util-pct">{schedCoverage}%</span>
        </div>
      </div>
    </div>
  );
};

export default KpiDashboard;
