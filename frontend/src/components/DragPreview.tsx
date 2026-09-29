/**
 * DragPreview — floating drag-preview card for MachineGanttBoard.
 * Extracted from MachineGanttBoard.tsx (#43).
 */
import React from 'react';
import { format } from 'date-fns';

export interface DragPreviewState {
  visible: boolean;
  x: number;
  y: number;
  date: Date | null;
  endDate: Date | null;
  jobId: string;
  jobType: string;
  opSeq: string;
  opDesc: string;
  stockCode: string;
  stockDesc: string;
  canDrop: boolean;
}

interface Props {
  dragPreview: DragPreviewState;
}

const DragPreview: React.FC<Props> = ({ dragPreview }) => {
  if (!dragPreview.visible || !dragPreview.date) return null;

  return (
    <div
      className={`drag-preview-card ${!dragPreview.canDrop ? 'no-drop' : ''}`}
      style={{ left: dragPreview.x, top: dragPreview.y }}
    >
      <div className="drag-preview-header">
        JOB: <strong>{dragPreview.jobId}</strong>
        {dragPreview.opSeq && <>&nbsp;&nbsp;OPERATION: <strong>{dragPreview.opSeq}</strong></>}
        {dragPreview.opDesc && <> - {dragPreview.opDesc}</>}
      </div>
      <div className="drag-preview-body">
        <div className="drag-preview-section">DETAILS</div>
        <div className="drag-preview-row">
          <span className="drag-preview-label">Job</span>
          <span className="drag-preview-value">{dragPreview.jobId}</span>
          <span className="drag-preview-label">Job Type</span>
          <span className="drag-preview-value">{dragPreview.jobType}</span>
        </div>
        <div className="drag-preview-row">
          <span className="drag-preview-label">Operation</span>
          <span className="drag-preview-value">{dragPreview.opSeq}</span>
          <span className="drag-preview-label">Description</span>
          <span className="drag-preview-value">{dragPreview.opDesc}</span>
        </div>
        <div className="drag-preview-row">
          <span className="drag-preview-label">Stock Code</span>
          <span className="drag-preview-value">{dragPreview.stockCode}</span>
          <span className="drag-preview-label">Description</span>
          <span className="drag-preview-value">{dragPreview.stockDesc}</span>
        </div>
        <div className="drag-preview-divider" />
        <div className="drag-preview-row">
          <span className="drag-preview-label">Start</span>
          <span className="drag-preview-value">
            {format(dragPreview.date, 'dd/MM/yyyy HH:mm:ss')}
          </span>
          {dragPreview.endDate && (
            <>
              <span className="drag-preview-label">End</span>
              <span className="drag-preview-value">
                {format(dragPreview.endDate, 'dd/MM/yyyy HH:mm:ss')}
              </span>
            </>
          )}
        </div>
      </div>
      {!dragPreview.canDrop && (
        <div className="drag-preview-error">Cannot move to this machine</div>
      )}
    </div>
  );
};

export default DragPreview;
