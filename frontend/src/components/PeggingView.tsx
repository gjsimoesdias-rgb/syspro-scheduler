import React, { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Schedule, Job } from '../types';
import './PeggingView.css';

interface PeggingViewProps {
  schedule: Schedule | null;
  jobs: Job[];
}

const PeggingView: React.FC<PeggingViewProps> = ({ schedule, jobs }) => {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((j) => j.jobId === selectedJobId) || null,
    [jobs, selectedJobId]
  );

  const jobSchedule = useMemo(
    () => schedule?.jobSchedules.find((j) => j.jobId === selectedJobId) || null,
    [schedule, selectedJobId]
  );

  if (!schedule) {
    return (
      <div className="pegging-view empty">
        <p>Generate a schedule first to explore job pegging.</p>
      </div>
    );
  }

  return (
    <div className="pegging-view">
      <div className="peg-header">
        <h3>Job Pegging — Trace Job → Operations → Resources</h3>
        <p>Select a scheduled job to trace its full production chain.</p>
      </div>

      <div className="peg-layout">
        {/* Job list */}
        <div className="peg-sidebar">
          <div className="peg-sidebar-title">Scheduled Jobs</div>
          <div className="peg-job-list">
            {schedule.jobSchedules.map((js) => {
              const job = jobs.find((j) => j.jobId === js.jobId);
              return (
                <button
                  key={js.jobId}
                  className={`peg-job-btn ${selectedJobId === js.jobId ? 'active' : ''} peg-status-${js.status.toLowerCase().replace(' ', '')}`}
                  onClick={() => setSelectedJobId(js.jobId)}
                >
                  <span className="peg-job-id">{js.jobId}</span>
                  <span className="peg-job-item">{job?.itemCode || ''}</span>
                  <span className="peg-job-status">{js.status}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Pegging trace */}
        <div className="peg-trace">
          {!selectedJobId ? (
            <div className="peg-select-hint">Select a job from the list to view its pegging trace.</div>
          ) : (
            <>
              {/* Job block */}
              <div className="peg-node peg-node-job">
                <div className="peg-node-header">📋 Job</div>
                <div className="peg-node-row"><span>Job ID</span><strong>{selectedJob?.jobId || selectedJobId}</strong></div>
                <div className="peg-node-row"><span>Item</span><strong>{selectedJob?.itemCode}</strong></div>
                <div className="peg-node-row"><span>Description</span><strong>{selectedJob?.description}</strong></div>
                <div className="peg-node-row"><span>Qty</span><strong>{selectedJob?.quantity}</strong></div>
                <div className="peg-node-row"><span>Due</span><strong>{selectedJob?.dueDate ? format(new Date(selectedJob.dueDate), 'dd/MM/yyyy') : '—'}</strong></div>
                <div className="peg-node-row"><span>Priority</span><strong>{selectedJob?.priority}</strong></div>
                <div className="peg-node-row"><span>Status</span><strong className={`peg-inline-status ${jobSchedule?.status.toLowerCase()}`}>{jobSchedule?.status}</strong></div>
                {jobSchedule && (
                  <>
                    <div className="peg-node-row"><span>Planned Start</span><strong>{format(new Date(jobSchedule.plannedStartDate), 'dd/MM HH:mm')}</strong></div>
                    <div className="peg-node-row"><span>Planned End</span><strong>{format(new Date(jobSchedule.plannedEndDate), 'dd/MM HH:mm')}</strong></div>
                    <div className="peg-node-row"><span>Tardiness</span><strong>{jobSchedule.estimatedTardiness}d</strong></div>
                  </>
                )}
              </div>

              <div className="peg-arrow">▼ Operations</div>

              {/* Operations */}
              {jobSchedule?.operationSchedules.map((op, idx) => {
                const sourceOp = selectedJob?.operations.find((o) => String(o.opId) === String(op.opId));
                return (
                  <React.Fragment key={op.opId}>
                    <div className="peg-node peg-node-op">
                      <div className="peg-node-header">⚙️ Op {idx + 1}</div>
                      <div className="peg-node-row"><span>Op ID</span><strong>{op.opId}</strong></div>
                      <div className="peg-node-row"><span>Workcentre</span><strong>{op.workcentreId}</strong></div>
                      {sourceOp && <div className="peg-node-row"><span>WC Name</span><strong>{sourceOp.workcentreName}</strong></div>}
                      <div className="peg-node-row"><span>Start</span><strong>{format(new Date(op.plannedStartDate), 'dd/MM HH:mm')}</strong></div>
                      <div className="peg-node-row"><span>End</span><strong>{format(new Date(op.plannedEndDate), 'dd/MM HH:mm')}</strong></div>
                      <div className="peg-node-row"><span>Duration</span><strong>{op.duration} min</strong></div>
                      {sourceOp && <div className="peg-node-row"><span>Setup</span><strong>{sourceOp.setupTime} min</strong></div>}
                      {sourceOp && <div className="peg-node-row"><span>Queue</span><strong>{sourceOp.queueTime} min</strong></div>}
                      {op.isOvertimeSlot && <div className="peg-overtime-flag">🌙 Overtime Slot</div>}
                    </div>

                    <div className="peg-arrow">▼ Resource</div>

                    <div className="peg-node peg-node-resource">
                      <div className="peg-node-header">🏭 Resource</div>
                      <div className="peg-node-row"><span>Resource ID</span><strong>{op.resourceId}</strong></div>
                      <div className="peg-node-row"><span>Workcentre</span><strong>{op.workcentreId}</strong></div>
                      <div className="peg-node-row"><span>Batch Size</span><strong>{op.batchSize}</strong></div>
                      <div className="peg-node-row"><span>Slack</span><strong>{op.slackTime} min</strong></div>
                    </div>

                    {idx < (jobSchedule?.operationSchedules.length ?? 0) - 1 && (
                      <div className="peg-arrow peg-arrow-seq">→ Next Operation</div>
                    )}
                  </React.Fragment>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PeggingView;
