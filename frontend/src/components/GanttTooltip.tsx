/**
 * GanttTooltip — floating tooltip overlay for MachineGanttBoard.
 * Extracted from MachineGanttBoard.tsx (#43).
 */
import React from 'react';

interface Props {
  visible: boolean;
  x: number;
  y: number;
  content: React.ReactNode;
}

const GanttTooltip: React.FC<Props> = ({ visible, x, y, content }) => {
  if (!visible) return null;
  return (
    <div className="gantt-tooltip" style={{ left: x, top: y }}>
      {content}
    </div>
  );
};

export default GanttTooltip;
