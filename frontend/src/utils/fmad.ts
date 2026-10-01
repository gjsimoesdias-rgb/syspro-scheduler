import type { JobFmad } from '../services/api';

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
};

/** Grid text, tooltip and flag class for a job's FMAD. */
export function fmadText(f: JobFmad, dueDate?: string | Date | null): { label: string; tip: string; cls: string } {
  const lim = f.limiting ? ` (limited by ${f.limiting})` : '';
  switch (f.status) {
    case 'no-materials':
      return { label: '—', tip: 'No materials still to issue', cls: '' };
    case 'no-supply':
      return { label: 'No supply', tip: `Not enough stock or open POs and no lead time set${lim}`, cls: 'grid-flag-bad' };
    default: {
      const date = f.fmad ? new Date(f.fmad) : null;
      const due = dueDate ? new Date(dueDate) : null;
      const afterDue = !!(date && due && !Number.isNaN(due.getTime()) && date.getTime() > due.getTime());
      const why = f.status === 'in-stock' ? 'All materials in stock now'
        : f.status === 'on-order' ? `Waits for a PO receipt${lim}`
        : `Needs a new purchase — stock code lead time${lim}`;
      const label = f.status === 'in-stock' ? 'In stock' : f.fmad ? fmtDay(f.fmad) : '—';
      const cls = afterDue ? 'grid-flag-bad' : f.status === 'in-stock' ? 'grid-flag-ok' : 'grid-flag-warn';
      return { label, tip: `${why}${afterDue ? ' — after the due date' : ''}`, cls };
    }
  }
}
