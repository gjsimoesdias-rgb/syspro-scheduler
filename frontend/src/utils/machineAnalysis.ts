/**
 * Workunit (machine) analysis — LYNQ's machine dashboard. Per machine and day:
 * available time (shift calendar), setup, run (busy) and idle, and load %.
 * Planned time is clipped to the machine's working windows so a run that
 * spans a night with no shift isn't counted as busy.
 */
import type { Resource, Schedule } from '../types';
import { getProductiveWindowsForDate } from './calendarWindows';
import type { CalendarLike } from './calendarWindows';

export interface MachineDay { day: string; availMin: number; setupMin: number; runMin: number; idleMin: number; loadPct: number }
export interface MachineRow {
  machineId: string;
  name: string;
  lineId: string;
  days: MachineDay[];
  availMin: number; setupMin: number; runMin: number; idleMin: number;
  loadPct: number;
  ops: number;
}

const DAY = 86_400_000;
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
const ms = (v: unknown) => { const t = v ? new Date(v as string | number).getTime() : NaN; return Number.isFinite(t) ? t : NaN; };
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const r1 = (n: number) => Math.round(n * 10) / 10;

export function analyseMachines(schedule: Schedule | null, resources: Resource[], from: Date, days: number): MachineRow[] {
  const start = new Date(from); start.setHours(0, 0, 0, 0);
  const dayStarts = Array.from({ length: days }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });

  // Machines: the resources, plus any machine id the plan uses that isn't one.
  const meta = new Map<string, { name: string; lineId: string; calendar: CalendarLike | undefined }>();
  for (const r of resources) meta.set(r.resourceId, { name: r.name || r.resourceId, lineId: r.worcentreId, calendar: r.calendar });
  type Seg = { s0: number; s1: number; r0: number; r1: number };
  const segs = new Map<string, Seg[]>();
  for (const js of schedule?.jobSchedules || []) {
    if (js.status === 'Unschedulable') continue;
    for (const op of js.operationSchedules || []) {
      const id = op.resourceId || op.workcentreId;
      if (!id) continue;
      if (!meta.has(id)) {
        const line = resources.find((r) => r.worcentreId === op.workcentreId);
        meta.set(id, { name: id, lineId: op.workcentreId, calendar: line?.calendar });
      }
      const s0 = ms(op.setupStart), s1 = ms(op.setupEnd);
      const r0 = ms(op.runStart) || ms(op.plannedStartDate), r1v = ms(op.runEnd) || ms(op.plannedEndDate);
      const list = segs.get(id) ?? [];
      segs.set(id, list);
      list.push({
        s0: Number.isFinite(s0) ? s0 : 0, s1: Number.isFinite(s1) ? s1 : 0,
        r0: Number.isFinite(r0) ? r0 : 0, r1: Number.isFinite(r1v) ? r1v : 0,
      });
    }
  }

  const rows: MachineRow[] = [];
  meta.forEach((m, machineId) => {
    const list = segs.get(machineId) || [];
    const out: MachineDay[] = dayStarts.map((d) => {
      const d0 = d.getTime(), d1 = d0 + DAY;
      const windows = getProductiveWindowsForDate(m.calendar, d)
        .map((w) => ({ a: Math.max(d0, w.startMs), b: Math.min(d1, w.endMs) }))
        .filter((w) => w.b > w.a);
      let avail = 0, setup = 0, run = 0;
      for (const w of windows) {
        avail += w.b - w.a;
        for (const sg of list) {
          if (sg.s1 > sg.s0) setup += overlap(sg.s0, sg.s1, w.a, w.b);
          if (sg.r1 > sg.r0) run += overlap(sg.r0, sg.r1, w.a, w.b);
        }
      }
      const availMin = avail / 60000;
      const setupMin = Math.min(availMin, setup / 60000);
      const runMin = Math.min(availMin - setupMin, run / 60000);
      return {
        day: dayKey(d),
        availMin: r1(availMin), setupMin: r1(setupMin), runMin: r1(runMin),
        idleMin: r1(Math.max(0, availMin - setupMin - runMin)),
        loadPct: availMin > 0 ? Math.round(((setupMin + runMin) / availMin) * 100) : 0,
      };
    });
    const sum = (k: keyof MachineDay) => r1(out.reduce((t, x) => t + (x[k] as number), 0));
    const availMin = sum('availMin'), setupMin = sum('setupMin'), runMin = sum('runMin');
    rows.push({
      machineId, name: m.name, lineId: m.lineId, days: out,
      availMin, setupMin, runMin, idleMin: sum('idleMin'),
      loadPct: availMin > 0 ? Math.round(((setupMin + runMin) / availMin) * 100) : 0,
      ops: list.length,
    });
  });
  return rows.sort((a, b) => b.loadPct - a.loadPct || a.machineId.localeCompare(b.machineId));
}
