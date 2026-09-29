import React, { useState } from 'react';
import { BarChart2, TrendingUp, RefreshCw, Zap, ArrowRight } from 'lucide-react';
import { Schedule } from '../types';
import './ScheduleComparison.css';

interface ScheduleComparisonProps {
  currentSchedule: Schedule | null;
  previousSchedule?: Schedule | null;
}

const ScheduleComparison: React.FC<ScheduleComparisonProps> = ({ currentSchedule, previousSchedule }) => {
  const [selectedTab, setSelectedTab] = useState<'metrics' | 'changes' | 'conflicts'>('metrics');

  if (!currentSchedule) {
    return <div className="comparison empty">No schedule to compare</div>;
  }

  if (!previousSchedule) {
    return <div className="comparison empty">Load a previous schedule to compare</div>;
  }

  const metricsDiff = {
    jobsOnTime: currentSchedule.metrics.jobsOnTime - previousSchedule.metrics.jobsOnTime,
    jobsTardy: currentSchedule.metrics.jobsTardy - previousSchedule.metrics.jobsTardy,
    avgTardiness: currentSchedule.metrics.averageTardiness - previousSchedule.metrics.averageTardiness,
    utilization: currentSchedule.metrics.resourceUtilization - previousSchedule.metrics.resourceUtilization,
    overtime: currentSchedule.metrics.overtimeHours - previousSchedule.metrics.overtimeHours
  };

  const getChangeColor = (value: number, lowerIsBetter = false): string => {
    if (value > 0 && !lowerIsBetter) return '#10b981'; // green - improvement
    if (value < 0 && !lowerIsBetter) return '#ef4444'; // red - worse
    if (value < 0 && lowerIsBetter) return '#10b981'; // green - improvement
    if (value > 0 && lowerIsBetter) return '#ef4444'; // red - worse
    return '#6b7280';
  };

  return (
    <div className="schedule-comparison">
      <h3><BarChart2 size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} aria-hidden="true" />Schedule Comparison</h3>

      <div className="comparison-tabs">
        <button
          className={`tab-btn ${selectedTab === 'metrics' ? 'active' : ''}`}
          onClick={() => setSelectedTab('metrics')}
        >
          <TrendingUp size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden="true" />Metrics
        </button>
        <button
          className={`tab-btn ${selectedTab === 'changes' ? 'active' : ''}`}
          onClick={() => setSelectedTab('changes')}
        >
          <RefreshCw size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden="true" />Changes
        </button>
        <button
          className={`tab-btn ${selectedTab === 'conflicts' ? 'active' : ''}`}
          onClick={() => setSelectedTab('conflicts')}
        >
          <Zap size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} aria-hidden="true" />New Violations
        </button>
      </div>

      <div className="comparison-content">
        {selectedTab === 'metrics' && (
          <div className="metrics-grid">
            <div className="metric-card">
              <label>On-Time Jobs</label>
              <div className="comparison-values">
                <div className="previous">{previousSchedule.metrics.jobsOnTime}</div>
                <ArrowRight size={14} className="arrow" aria-hidden="true" />
                <div className="current" style={{ color: getChangeColor(metricsDiff.jobsOnTime) }}>
                  {currentSchedule.metrics.jobsOnTime}
                  <span className="change">
                    ({metricsDiff.jobsOnTime > 0 ? '+' : ''}{metricsDiff.jobsOnTime})
                  </span>
                </div>
              </div>
            </div>

            <div className="metric-card">
              <label>Tardy Jobs</label>
              <div className="comparison-values">
                <div className="previous">{previousSchedule.metrics.jobsTardy}</div>
                <ArrowRight size={14} className="arrow" aria-hidden="true" />
                <div className="current" style={{ color: getChangeColor(metricsDiff.jobsTardy, true) }}>
                  {currentSchedule.metrics.jobsTardy}
                  <span className="change">
                    ({metricsDiff.jobsTardy > 0 ? '+' : ''}{metricsDiff.jobsTardy})
                  </span>
                </div>
              </div>
            </div>

            <div className="metric-card">
              <label>Avg Tardiness (days)</label>
              <div className="comparison-values">
                <div className="previous">{previousSchedule.metrics.averageTardiness.toFixed(2)}</div>
                <ArrowRight size={14} className="arrow" aria-hidden="true" />
                <div className="current" style={{ color: getChangeColor(metricsDiff.avgTardiness, true) }}>
                  {currentSchedule.metrics.averageTardiness.toFixed(2)}
                  <span className="change">
                    ({metricsDiff.avgTardiness > 0 ? '+' : ''}{metricsDiff.avgTardiness.toFixed(2)})
                  </span>
                </div>
              </div>
            </div>

            <div className="metric-card">
              <label>Utilization (%)</label>
              <div className="comparison-values">
                <div className="previous">{previousSchedule.metrics.resourceUtilization.toFixed(1)}</div>
                <ArrowRight size={14} className="arrow" aria-hidden="true" />
                <div className="current" style={{ color: getChangeColor(metricsDiff.utilization) }}>
                  {currentSchedule.metrics.resourceUtilization.toFixed(1)}
                  <span className="change">
                    ({metricsDiff.utilization > 0 ? '+' : ''}{metricsDiff.utilization.toFixed(1)})
                  </span>
                </div>
              </div>
            </div>

            <div className="metric-card">
              <label>Overtime Hours</label>
              <div className="comparison-values">
                <div className="previous">{previousSchedule.metrics.overtimeHours.toFixed(1)}</div>
                <ArrowRight size={14} className="arrow" aria-hidden="true" />
                <div className="current" style={{ color: getChangeColor(metricsDiff.overtime, true) }}>
                  {currentSchedule.metrics.overtimeHours.toFixed(1)}
                  <span className="change">
                    ({metricsDiff.overtime > 0 ? '+' : ''}{metricsDiff.overtime.toFixed(1)})
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {selectedTab === 'changes' && (
          <div className="changes-list">
            <p className="info">
              {currentSchedule.jobSchedules.length} jobs in current vs {previousSchedule.jobSchedules.length} in previous
            </p>
            <table>
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Previous Start</th>
                  <th>Current Start</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {currentSchedule.jobSchedules
                  .filter((job) => {
                    const prevJob = previousSchedule.jobSchedules.find((j) => j.jobId === job.jobId);
                    return prevJob && prevJob.plannedStartDate !== job.plannedStartDate;
                  })
                  .slice(0, 10)
                  .map((job) => {
                    const prevJob = previousSchedule.jobSchedules.find((j) => j.jobId === job.jobId)!;
                    const daysChange =
                      (job.plannedStartDate.getTime() - prevJob.plannedStartDate.getTime()) /
                      (1000 * 60 * 60 * 24);
                    return (
                      <tr key={job.jobId}>
                        <td>{job.jobId}</td>
                        <td>{prevJob.plannedStartDate.toLocaleDateString()}</td>
                        <td>{job.plannedStartDate.toLocaleDateString()}</td>
                        <td style={{ color: daysChange > 0 ? '#ef4444' : '#10b981' }}>
                          {daysChange > 0 ? '+' : ''}{daysChange.toFixed(1)} days
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}

        {selectedTab === 'conflicts' && (
          <div className="violations-list">
            <p className="info">New violations in current schedule:</p>
            {currentSchedule.constraintViolations.length > 0 ? (
              currentSchedule.constraintViolations
                .filter(
                  (v) =>
                    !previousSchedule.constraintViolations.find(
                      (pv) => pv.affectedJobId === v.affectedJobId && pv.type === v.type
                    )
                )
                .map((v) => (
                  <div key={v.violationId} className={`violation-badge ${v.severity.toLowerCase()}`}>
                    <strong>{v.type}</strong>
                    <p>{v.description}</p>
                  </div>
                ))
            ) : (
              <p>No new violations</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ScheduleComparison;
