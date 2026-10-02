/**
 * ResourceLeveling - Optimizes resource utilization across schedule
 */

import React, { useMemo, useState } from 'react';
import { JobSchedule, OperationSchedule } from '../types';
import './ResourceLeveling.css';
import { AlertTriangle, Lightbulb } from 'lucide-react';

interface ResourceLevelingProps {
  jobSchedules: JobSchedule[];
  onLevel?: (optimizedSchedule: JobSchedule[]) => void;
}

interface ResourceStats {
  resourceId: string;
  utilizationPercent: number;
  peakHours: number;
  slackHours: number;
  costPerDay: number;
  operations: OperationSchedule[];
}

export default function ResourceLeveling(props: ResourceLevelingProps) {
  const { jobSchedules, onLevel } = props;
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [levelMode, setLevelMode] = useState<'minimize-cost' | 'balance-load' | 'minimize-makespan'>('balance-load');

  const resourceStats = useMemo(() => {
    const stats: Map<string, ResourceStats> = new Map();

    jobSchedules.forEach(job => {
      job.operationSchedules.forEach(op => {
        const stat: ResourceStats = stats.get(op.resourceId) ?? {
          resourceId: op.resourceId,
          utilizationPercent: 0,
          peakHours: 0,
          slackHours: 0,
          costPerDay: 0,
          operations: []
        };
        stats.set(op.resourceId, stat);
        stat.operations.push(op);
      });
    });

    // Calculate utilization metrics
    stats.forEach(stat => {
      const totalMinutes = stat.operations.reduce((sum, op) => sum + op.duration, 0);
      const availableMinutes = 8 * 60 * 20; // 8h/day * 20 days
      stat.utilizationPercent = Math.min(100, (totalMinutes / availableMinutes) * 100);
      stat.slackHours = Math.max(0, (availableMinutes - totalMinutes) / 60);

      // Find peak hours in a day
      const opsByDay: Map<string, number> = new Map();
      stat.operations.forEach(op => {
        const dayKey = op.plannedStartDate.toISOString().split('T')[0];
        const hours = op.duration / 60;
        opsByDay.set(dayKey, (opsByDay.get(dayKey) || 0) + hours);
      });
      stat.peakHours = Math.max(...Array.from(opsByDay.values()), 0);
    });

    return Array.from(stats.values()).sort((a, b) => b.utilizationPercent - a.utilizationPercent);
  }, [jobSchedules]);

  const handleOptimize = () => {
    setIsOptimizing(true);
    // Simulate optimization
    setTimeout(() => {
      const optimized = jobSchedules.map(job => ({
        ...job,
        operationSchedules: job.operationSchedules.map(op => ({
          ...op,
          // Optimization logic would go here
        }))
      }));
      onLevel?.(optimized);
      setIsOptimizing(false);
    }, 1500);
  };

  const avgUtilization = resourceStats.length > 0
    ? resourceStats.reduce((sum, r) => sum + r.utilizationPercent, 0) / resourceStats.length
    : 0;

  const overloadedResources = resourceStats.filter(r => r.utilizationPercent > 85);
  const underutilizedResources = resourceStats.filter(r => r.utilizationPercent < 40);

  return (
    <div className="resource-leveling">
      <div className="leveling-header">
        <h3>Resource Leveling Optimizer</h3>
        <p>Balance workload and optimize resource utilization</p>
      </div>

      <div className="leveling-metrics">
        <div className="metric-card">
          <span className="metric-label">Avg Utilization:</span>
          <span className="metric-value">{avgUtilization.toFixed(1)}%</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Overloaded:</span>
          <span className="metric-value critical">{overloadedResources.length}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Underutilized:</span>
          <span className="metric-value warning">{underutilizedResources.length}</span>
        </div>
        <div className="metric-card">
          <span className="metric-label">Resources:</span>
          <span className="metric-value">{resourceStats.length}</span>
        </div>
      </div>

      <div className="leveling-controls">
        <div className="control-group">
          <label>Optimization Mode:</label>
          <select value={levelMode} onChange={e => setLevelMode(e.target.value as typeof levelMode)}>
            <option value="balance-load">Balance Load</option>
            <option value="minimize-cost">Minimize Cost</option>
            <option value="minimize-makespan">Minimize Makespan</option>
          </select>
        </div>
        <button className="btn btn-primary" onClick={handleOptimize} disabled={isOptimizing}>
          {isOptimizing ? 'Optimizing...' : 'Run Optimizer'}
        </button>
      </div>

      <div className="resource-list">
        <div className="list-header">
          <span className="col-name">Resource</span>
          <span className="col-util">Utilization</span>
          <span className="col-peak">Peak/Day</span>
          <span className="col-slack">Slack</span>
          <span className="col-ops">Ops</span>
        </div>

        <div className="list-items">
          {resourceStats.map(resource => (
            <div key={resource.resourceId} className={`list-item util-${resource.utilizationPercent > 85 ? 'high' : resource.utilizationPercent < 40 ? 'low' : 'normal'}`}>
              <span className="col-name">{resource.resourceId}</span>
              <span className="col-util">
                <div className="util-bar">
                  <div className="util-fill" style={{ width: `${resource.utilizationPercent}%` }}></div>
                  <span className="util-label">{resource.utilizationPercent.toFixed(0)}%</span>
                </div>
              </span>
              <span className="col-peak">{resource.peakHours.toFixed(1)}h</span>
              <span className="col-slack">{resource.slackHours.toFixed(1)}h</span>
              <span className="col-ops">{resource.operations.length}</span>
            </div>
          ))}
        </div>
      </div>

      {overloadedResources.length > 0 && (
        <div className="leveling-suggestion">
          <strong><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> High Utilization:</strong> {overloadedResources.map(r => r.resourceId).join(', ')} are overloaded. Consider adding capacity or rescheduling.
        </div>
      )}

      {underutilizedResources.length > 0 && (
        <div className="leveling-suggestion info">
          <strong><Lightbulb size={13} className="ui-icon" aria-hidden="true" /> Opportunity:</strong> {underutilizedResources.map(r => r.resourceId).join(', ')} have available capacity.
        </div>
      )}
    </div>
  );
}
