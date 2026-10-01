import React, { useState } from 'react';
import { OperationSchedule, Schedule } from '../types';
import './DraggableGantt.css';
import { Pin } from 'lucide-react';

interface DraggableGanttProps {
  schedule: Schedule | null;
  onJobMoved?: (opId: string, newStartDate: Date, newEndDate: Date) => void;
}

const DraggableGantt: React.FC<DraggableGanttProps> = ({ schedule, onJobMoved }) => {
  const [draggedOp, setDraggedOp] = useState<OperationSchedule | null>(null);

  if (!schedule?.jobSchedules.length) {
    return <div className="draggable-gantt empty">No schedule to drag</div>;
  }

  const minDate = new Date(schedule.planningHorizon.startDate);
  const maxDate = new Date(schedule.planningHorizon.endDate);
  const totalDays = Math.ceil((maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24));

  const calculatePosition = (date: Date): number => {
    const days = (date.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24);
    return (days / totalDays) * 100;
  };

  const calculateWidth = (startDate: Date, endDate: Date): number => {
    const days = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
    return (days / totalDays) * 100;
  };

  const dateFromPosition = (percentage: number): Date => {
    const days = (percentage / 100) * totalDays;
    const newDate = new Date(minDate);
    newDate.setDate(newDate.getDate() + days);
    return newDate;
  };

  const handleMouseDown = (op: OperationSchedule, e: React.MouseEvent) => {
    setDraggedOp(op);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!draggedOp) return;

    const container = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pixelPosition = e.clientX - container.left;
    const percentage = (pixelPosition / container.width) * 100;
    dateFromPosition(percentage);

    // Update Gantt bar position (visual feedback)
    // Actual update on drop
  };

  const handleMouseUp = (op: OperationSchedule, e: React.MouseEvent) => {
    if (!draggedOp) return;

    const container = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pixelPosition = e.clientX - container.left;
    const percentage = (pixelPosition / container.width) * 100;
    const newStartDate = dateFromPosition(percentage);
    const duration = (op.plannedEndDate.getTime() - op.plannedStartDate.getTime()) / 1000;
    const newEndDate = new Date(newStartDate.getTime() + duration * 1000);

    if (onJobMoved) {
      onJobMoved(op.opId, newStartDate, newEndDate);
    }

    setDraggedOp(null);
  };

  return (
    <div className="draggable-gantt">
      <h3><Pin size={13} className="ui-icon" aria-hidden="true" /> Draggable Schedule (Drag jobs to reschedule)</h3>
      <div className="gantt-timeline" onMouseMove={handleMouseMove}>
        <div className="timeline-header">
          <div className="timeline-labels">
            {Array.from({ length: 8 }).map((_, i) => {
              const date = new Date(minDate);
              date.setDate(date.getDate() + (i * totalDays) / 8);
              return (
                <div key={i} className="timeline-label">
                  {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="gantt-bars">
          {schedule.jobSchedules.flatMap((jobSchedule) =>
            jobSchedule.operationSchedules.map((op) => (
              <div key={op.opId} className="op-row">
                <div className="op-label">{op.opId.slice(0, 12)}</div>
                <div className="op-bar-container">
                  <div
                    className={`op-bar ${draggedOp?.opId === op.opId ? 'dragging' : ''}`}
                    style={{
                      left: `${calculatePosition(op.plannedStartDate)}%`,
                      width: `${calculateWidth(op.plannedStartDate, op.plannedEndDate)}%`,
                      backgroundColor: draggedOp?.opId === op.opId ? 'var(--accent)' : 'var(--status-ok)'
                    }}
                    onMouseDown={(e) => handleMouseDown(op, e)}
                    onMouseUp={(e) => handleMouseUp(op, e)}
                    title={`Drag to reschedule`}
                    role="button"
                    tabIndex={0}
                  >
                    {op.plannedStartDate.toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric'
                    })}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default DraggableGantt;
