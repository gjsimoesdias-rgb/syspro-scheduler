/**
 * S4.2 — scheduleStore
 *
 * Central Zustand store for schedule-domain state that was previously spread
 * across App.tsx useState calls. Non-persisted (schedules are loaded from the
 * backend on demand; version list and undo history are session-only).
 */

import { create } from 'zustand';
import type { Schedule } from '../../../shared/types';
import { createUndoRedoManager, UndoRedoManager } from '../services/undoRedoManager';
import type { PinnedOperationDto } from '../services/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleVersion {
  versionId: string;
  timestamp: Date;
  description: string;
  metrics: Schedule['metrics'];
  jobsCount: number;
  isCurrent: boolean;
  scheduleData: Schedule;
}

interface ScheduleStoreState {
  // Active schedule
  schedule: Schedule | null;
  setSchedule: (s: Schedule | null) => void;

  // Version history (loaded from backend)
  scheduleVersions: ScheduleVersion[];
  setScheduleVersions: (v: ScheduleVersion[]) => void;

  // Undo / redo
  undoRedoManager: UndoRedoManager;

  // Gantt highlight & pinning
  highlightJobId: string | null;
  setHighlightJobId: (id: string | null) => void;

  pinnedOps: Set<string>;
  setPinnedOps: (ops: Set<string>) => void;
  togglePinnedOp: (jobId: string, opId: string) => void;

  /** Full pin detail keyed by "jobId::opId". Populated via fetchPins(). */
  pinnedOpDetails: Map<string, PinnedOperationDto>;
  setPinnedOpDetails: (map: Map<string, PinnedOperationDto>) => void;

  // What-if scenario
  whatIfSchedule: Schedule | null;
  setWhatIfSchedule: (s: Schedule | null) => void;

  whatIfLabel: string;
  setWhatIfLabel: (v: string) => void;

  // Schedule generation progress
  isGeneratingSchedule: boolean;
  setIsGeneratingSchedule: (v: boolean) => void;

  generationProgress: number;
  setGenerationProgress: (v: number) => void;

  generationStatusText: string;
  setGenerationStatusText: (v: string) => void;

  // Source annotation (e.g. 'syspro', 'manual', 'restored')
  scheduleSource: string;
  setScheduleSource: (v: string) => void;

  /**
   * The what-if version open on the board (null = the master plan). While set,
   * generate runs into it and edits save into it — the master is untouched.
   */
  activeVersion: { versionId: string; name: string } | null;
  setActiveVersion: (v: { versionId: string; name: string } | null) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useScheduleStore = create<ScheduleStoreState>()((set, get) => ({
  schedule: null,
  setSchedule: (s) => set({ schedule: s }),

  scheduleVersions: [],
  setScheduleVersions: (v) => set({ scheduleVersions: v }),

  undoRedoManager: createUndoRedoManager(),

  highlightJobId: null,
  setHighlightJobId: (id) => set({ highlightJobId: id }),

  pinnedOps: new Set<string>(),
  setPinnedOps: (ops) => set({ pinnedOps: ops }),
  togglePinnedOp: (jobId, opId) => {
    const key = `${jobId}::${opId}`;
    const current = get().pinnedOps;
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    set({ pinnedOps: next });
  },

  pinnedOpDetails: new Map<string, PinnedOperationDto>(),
  setPinnedOpDetails: (map) => set({ pinnedOpDetails: map }),

  whatIfSchedule: null,
  setWhatIfSchedule: (s) => set({ whatIfSchedule: s }),

  whatIfLabel: '',
  setWhatIfLabel: (v) => set({ whatIfLabel: v }),

  isGeneratingSchedule: false,
  setIsGeneratingSchedule: (v) => set({ isGeneratingSchedule: v }),

  generationProgress: 0,
  setGenerationProgress: (v) => set({ generationProgress: v }),

  generationStatusText: 'Preparing scheduler...',
  setGenerationStatusText: (v) => set({ generationStatusText: v }),

  scheduleSource: '',
  setScheduleSource: (v) => set({ scheduleSource: v }),

  activeVersion: null,
  setActiveVersion: (v) => set({ activeVersion: v }),
}));
