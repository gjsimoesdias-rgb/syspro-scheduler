import React from 'react';
import { AlertCircle, AlertTriangle, CheckCircle, Search } from 'lucide-react';
import { ResourceLoad } from '../types';
import './BottleneckAnalysis.css';

interface BottleneckAnalysisProps {
  resourceLoads: ResourceLoad[];
}

const BottleneckAnalysis: React.FC<BottleneckAnalysisProps> = ({ resourceLoads }) => {
  if (!resourceLoads || resourceLoads.length === 0) {
    return <div className="bottleneck empty">No resource data available</div>;
  }

  // Calculate average utilization per resource
  const resourceUtilization = resourceLoads.reduce((acc, load) => {
    if (!acc[load.resourceId]) {
      acc[load.resourceId] = { total: 0, count: 0 };
    }
    acc[load.resourceId].total += load.utilizationRate;
    acc[load.resourceId].count += 1;
    return acc;
  }, {} as Record<string, { total: number; count: number }>);

  const avgUtilization = Object.entries(resourceUtilization).map(([resourceId, data]) => ({
    resourceId,
    avgUtilization: data.total / data.count,
    severity: (data.total / data.count) > 90 ? 'critical' : (data.total / data.count) > 70 ? 'high' : 'normal'
  }));

  const sorted = avgUtilization.sort((a, b) => b.avgUtilization - a.avgUtilization);
  const bottlenecks = sorted.filter((r) => r.severity !== 'normal');

  const getSeverityColor = (utilization: number): string => {
    if (utilization > 90) return '#dc2626';
    if (utilization > 70) return '#f97316';
    return '#10b981';
  };

  const getSeverityLabel = (utilization: number): string => {
    if (utilization > 90) return 'CRITICAL';
    if (utilization > 70) return 'HIGH';
    return 'NORMAL';
  };

  return (
    <div className="bottleneck-analysis">
      <h3><Search size={15} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 6 }} />Bottleneck Analysis</h3>

      {bottlenecks.length > 0 && (
        <div className="bottleneck-alert">
          <strong><AlertTriangle size={14} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 4 }} /> {bottlenecks.length} bottleneck(s) detected</strong>
          <p>Resources are over-utilized. Consider adding capacity or restructuring schedule.</p>
        </div>
      )}

      <div className="utilization-heatmap">
        <div className="heatmap-title">Resource Utilization Heatmap</div>
        <div className="heatmap-grid">
          {sorted.map((item) => (
            <div key={item.resourceId} className="heatmap-cell">
              <div
                className="heatmap-bar"
                style={{
                  backgroundColor: getSeverityColor(item.avgUtilization),
                  height: `${Math.min(item.avgUtilization, 100)}px`
                }}
              />
              <div className="heatmap-label">
                <div className="resource-id">{item.resourceId.slice(0, 10)}</div>
                <div className="utilization">{item.avgUtilization.toFixed(0)}%</div>
                <div className="severity">{getSeverityLabel(item.avgUtilization)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="bottleneck-recommendations">
        <h4>💡 Recommendations</h4>
        <ul>
          {bottlenecks.map((item) => (
            <li key={item.resourceId}>
              <strong>{item.resourceId}</strong> ({item.avgUtilization.toFixed(0)}%)
              {item.severity === 'critical' && (
                <span className="recommendation">
                  • Add parallel resource or redistribute load • Run extended shifts
                </span>
              )}
              {item.severity === 'high' && (
                <span className="recommendation">• Monitor closely • Consider contingency</span>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div className="resources-summary">
        <table>
          <thead>
            <tr>
              <th>Resource ID</th>
              <th>Avg Utilization</th>
              <th>Max Daily Hours</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 15).map((item) => (
              <tr key={item.resourceId} className={item.severity}>
                <td>{item.resourceId}</td>
                <td>
                  <div className="util-bar">
                    <div
                      className="util-fill"
                      style={{
                        width: `${Math.min(item.avgUtilization, 100)}%`,
                        backgroundColor: getSeverityColor(item.avgUtilization)
                      }}
                    />
                  </div>
                </td>
                <td>{(item.avgUtilization * 0.08).toFixed(1)}h</td>
                <td>{getSeverityLabel(item.avgUtilization)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default BottleneckAnalysis;
