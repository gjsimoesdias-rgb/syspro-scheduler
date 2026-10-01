import type { Job, JobSchedule } from '../types';

export interface PlanJob { jobId: string; itemCode?: string; quantity: number; start: string | null; end: string | null; dueDate?: string | null }

const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(v as any);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Open jobs with their planned dates (jobs the plan could not schedule get none). */
export function planJobsFrom(jobs: Job[], jobSchedules: JobSchedule[]): PlanJob[] {
  const byId = new Map(jobSchedules.map((s) => [s.jobId, s]));
  return jobs.map((j) => {
    const s = byId.get(j.jobId);
    const ok = !!s && s.status !== 'Unschedulable';
    return {
      jobId: j.jobId,
      itemCode: (j as any).itemCode,
      quantity: Number((j as any).quantity) || 0,
      start: ok ? iso(s!.plannedStartDate) : null,
      end: ok ? iso(s!.plannedEndDate) : null,
      dueDate: iso((j as any).dueDate) ?? undefined,
    };
  });
}

/** Stable key so views refetch only when the plan's dates change. */
export const planKeyOf = (jobs: PlanJob[]) => jobs.map((j) => `${j.jobId}|${j.start}|${j.end}`).join(';');
