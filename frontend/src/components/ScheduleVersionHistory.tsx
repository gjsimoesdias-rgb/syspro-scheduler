import React, { useState } from 'react';
import { Schedule } from '../types';
import './ScheduleVersionHistory.css';
import { History, RotateCcw } from 'lucide-react';

interface ScheduleVersion {
  versionId: string;
  timestamp: Date;
  description: string;
  metrics: any;
  jobsCount: number;
  isCurrent: boolean;
}

interface ScheduleVersionHistoryProps {
  versions: ScheduleVersion[];
  currentSchedule: Schedule | null;
  onLoadVersion?: (versionId: string, schedule: Schedule) => void;
}

const ScheduleVersionHistory: React.FC<ScheduleVersionHistoryProps> = ({
  versions,
  currentSchedule,
  onLoadVersion
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (!versions || versions.length === 0) {
    return <div className="version-history empty">No schedule versions saved yet</div>;
  }

  const sortedVersions = [...versions].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const handleRestore = (version: ScheduleVersion) => {
    if (onLoadVersion && currentSchedule) {
      onLoadVersion(version.versionId, currentSchedule);
    }
  };

  return (
    <div className="version-history">
      <h3><History size={13} className="ui-icon" aria-hidden="true" /> Schedule Version History</h3>

      <div className="versions-timeline">
        {sortedVersions.map((version, index) => (
          <div key={version.versionId} className={`version-item ${version.isCurrent ? 'current' : ''}`}>
            <div className="version-marker">
              {version.isCurrent && <div className="current-badge">CURRENT</div>}
              <div className="timeline-dot" />
              {index < sortedVersions.length - 1 && <div className="timeline-line" />}
            </div>

            <div
              className="version-content"
              onClick={() => setExpandedId(expandedId === version.versionId ? null : version.versionId)}
              role="button"
              tabIndex={0}
            >
              <div className="version-header">
                <span className="version-time">
                  {new Date(version.timestamp).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                  })}
                </span>
                <span className="version-desc">{version.description}</span>
                <span className="version-badge">{version.jobsCount} jobs</span>
              </div>

              {expandedId === version.versionId && (
                <div className="version-details">
                  <div className="details-grid">
                    <div className="detail-item">
                      <label>On-Time Jobs</label>
                      <span>{version.metrics?.jobsOnTime || 0}</span>
                    </div>
                    <div className="detail-item">
                      <label>Tardy Jobs</label>
                      <span>{version.metrics?.jobsTardy || 0}</span>
                    </div>
                    <div className="detail-item">
                      <label>Avg Tardiness</label>
                      <span>{(version.metrics?.averageTardiness || 0).toFixed(2)} days</span>
                    </div>
                    <div className="detail-item">
                      <label>Utilization</label>
                      <span>{(version.metrics?.resourceUtilization || 0).toFixed(1)}%</span>
                    </div>
                  </div>

                  {!version.isCurrent && (
                    <button className="restore-btn" onClick={() => handleRestore(version)}>
                      <RotateCcw size={13} className="ui-icon" aria-hidden="true" /> Restore This Version
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ScheduleVersionHistory;
