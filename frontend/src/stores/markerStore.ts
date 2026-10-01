/**
 * markerStore — LYNQ-style job markers: planner-defined coloured tags
 * (one per job), shared by the job grid, the Gantt and the filter.
 * Persisted on the server (GET/PUT /api/jobs/markers).
 */
import { create } from 'zustand';
import { markerService, type JobMarkers, type MarkerDef } from '../services/api';

interface MarkerState extends JobMarkers {
  loaded: boolean;
  /** Only show jobs with this marker ('' = all, '__none' = unmarked). */
  filter: string;
  load: () => Promise<void>;
  save: (next: JobMarkers) => Promise<void>;
  assign: (jobIds: string[], markerId: string | null) => Promise<void>;
  setFilter: (f: string) => void;
  markerFor: (jobId: string) => MarkerDef | undefined;
}

export const MARKER_COLOURS = ['#E5484D', '#F5A524', '#C5F23A', '#30A46C', '#3B8FDC', '#8E4EC6', '#E54D9E', '#8B8D98'];

export const useMarkerStore = create<MarkerState>((set, get) => ({
  definitions: [],
  assignments: {},
  loaded: false,
  filter: '',
  load: async () => {
    try {
      const m = await markerService.get();
      set({ definitions: m.definitions || [], assignments: m.assignments || {}, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  save: async (next) => {
    const prev = { definitions: get().definitions, assignments: get().assignments };
    set(next); // optimistic
    try {
      const saved = await markerService.save(next);
      set({ definitions: saved.definitions, assignments: saved.assignments });
    } catch (err) {
      set(prev);
      throw err;
    }
  },
  assign: async (jobIds, markerId) => {
    const assignments = { ...get().assignments };
    for (const id of jobIds) {
      if (markerId) assignments[id] = markerId;
      else delete assignments[id];
    }
    await get().save({ definitions: get().definitions, assignments });
  },
  setFilter: (filter) => set({ filter }),
  markerFor: (jobId) => {
    const id = get().assignments[jobId];
    return id ? get().definitions.find((d) => d.id === id) : undefined;
  },
}));

/** True when the job passes the current marker filter. */
export function passesMarkerFilter(filter: string, assignments: Record<string, string>, jobId: string): boolean {
  if (!filter) return true;
  if (filter === '__none') return !assignments[jobId];
  return assignments[jobId] === filter;
}
