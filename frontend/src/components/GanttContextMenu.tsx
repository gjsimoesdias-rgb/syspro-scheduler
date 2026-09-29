/**
 * GanttContextMenu — right-click context menu for MachineGanttBoard.
 * Extracted from MachineGanttBoard.tsx (#43).
 */
import React from 'react';
import { Package, Crosshair, Lock, Unlock } from 'lucide-react';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  jobId: string;
  opId: string;
  isLocked: boolean;
}

interface Props {
  contextMenu: ContextMenuState | null;
  highlightJobId: string | null | undefined;
  onClose: () => void;
  onShowMaterials: (jobId: string) => void;
  onHighlightJob: (jobId: string | null) => void;
  onToggleLock: (jobId: string, opId: string) => void;
}

const GanttContextMenu: React.FC<Props> = ({
  contextMenu,
  highlightJobId,
  onClose,
  onShowMaterials,
  onHighlightJob,
  onToggleLock,
}) => {
  if (!contextMenu?.visible) return null;

  return (
    <div
      className="gantt-context-menu"
      role="menu"
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="gantt-context-menu__header">
        Job <strong>{contextMenu.jobId}</strong>
      </div>
      <button
        type="button"
        role="menuitem"
        className="gantt-context-menu__item"
        onClick={() => {
          const id = contextMenu.jobId;
          onClose();
          onShowMaterials(id);
        }}
      >
        <Package size={14} className="gantt-context-menu__icon" aria-hidden="true" />
        View materials &amp; availability
      </button>
      <button
        type="button"
        role="menuitem"
        className="gantt-context-menu__item"
        onClick={() => {
          const id = contextMenu.jobId;
          onClose();
          onHighlightJob(highlightJobId === id ? null : id);
        }}
      >
        <Crosshair size={14} className="gantt-context-menu__icon" aria-hidden="true" />
        {highlightJobId === contextMenu.jobId ? 'Clear highlight' : 'Highlight job'}
      </button>
      <button
        type="button"
        role="menuitem"
        className="gantt-context-menu__item"
        onClick={() => {
          const { jobId, opId } = contextMenu;
          onClose();
          onToggleLock(jobId, opId);
        }}
      >
        {contextMenu.isLocked ? (
          <Unlock size={14} className="gantt-context-menu__icon" aria-hidden="true" />
        ) : (
          <Lock size={14} className="gantt-context-menu__icon" aria-hidden="true" />
        )}
        {contextMenu.isLocked ? 'Unlock operation' : 'Lock operation'}
      </button>
    </div>
  );
};

export default GanttContextMenu;
