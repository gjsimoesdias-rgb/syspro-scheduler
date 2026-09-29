/**
 * MaterialVisibility - Material-centric view with stockout projection
 * Groups by material, shows running balance and which job causes stockout
 */

import React, { useMemo, useState } from 'react';
import { JobSchedule } from '../types';
import './MaterialVisibility.css';

interface MaterialVisibilityProps {
  jobSchedules: JobSchedule[];
  planningHorizonStart: Date;
  planningHorizonEnd: Date;
  materialPlan?: Array<{
    jobId: string;
    itemCode: string;
    componentCode: string;
    description?: string;
    unitOfMeasure?: string;
    quantityRequired: number;
    stockOnHand: number;
    reservedQty: number;
    openPoQty: number;
    availableQty: number;
    status: 'Materials' | 'Partial' | 'No Materials';
  }>;
}

interface JobDemand {
  jobId: string;
  quantityRequired: number;
  scheduledDate: Date | null;
  runningBalance: number;
}

interface MaterialRow {
  code: string;
  description: string;
  uom: string;
  stockOnHand: number;
  openPoQty: number;
  totalDemand: number;
  finalBalance: number;
  stockoutJob: string | null;
  stockoutDate: Date | null;
  status: 'sufficient' | 'warning' | 'shortage';
  jobs: JobDemand[];
}

function fmtDate(d: Date | null): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return '—';
  const dd = String(dt.getDate()).padStart(2, '0');
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${dt.getFullYear()}`;
}

function fmtQty(n: number): string {
  return n % 1 === 0 ? String(n) : n.toFixed(2);
}

export default function MaterialVisibility(props: MaterialVisibilityProps) {
  const { jobSchedules, materialPlan = [] } = props;
  const [expandedMaterial, setExpandedMaterial] = useState<string | null>(null);

  // Build job start-date lookup from schedule
  const jobDateMap = useMemo(() => {
    const map = new Map<string, Date>();
    jobSchedules.forEach((js) => {
      const start = new Date(js.plannedStartDate);
      if (!isNaN(start.getTime())) map.set(js.jobId, start);
    });
    return map;
  }, [jobSchedules]);

  const materials = useMemo<MaterialRow[]>(() => {
    if (materialPlan.length === 0) return [];

    // Group rows by componentCode
    const grouped = new Map<string, { rows: typeof materialPlan; stockOnHand: number; openPoQty: number; desc: string; uom: string }>();
    materialPlan.forEach((row) => {
      const key = String(row.componentCode || '').trim() || 'UNKNOWN';
      if (!grouped.has(key)) {
        grouped.set(key, {
          rows: [],
          stockOnHand: Number(row.stockOnHand || 0),
          openPoQty: Number(row.openPoQty || 0),
          desc: row.description || '',
          uom: row.unitOfMeasure || ''
        });
      }
      const g = grouped.get(key)!;
      g.rows.push(row);
      g.stockOnHand = Math.max(g.stockOnHand, Number(row.stockOnHand || 0));
      g.openPoQty = Math.max(g.openPoQty, Number(row.openPoQty || 0));
      if (!g.desc && row.description) g.desc = row.description;
      if (!g.uom && row.unitOfMeasure) g.uom = row.unitOfMeasure;
    });

    const result: MaterialRow[] = [];

    grouped.forEach((grp, code) => {
      // Aggregate demand per job
      const jobDemandMap = new Map<string, number>();
      grp.rows.forEach((r) => {
        jobDemandMap.set(r.jobId, (jobDemandMap.get(r.jobId) || 0) + Number(r.quantityRequired || 0));
      });

      // Sort jobs by scheduled date (earliest first), unscheduled last
      const jobDemands: JobDemand[] = Array.from(jobDemandMap.entries())
        .map(([jobId, qty]) => ({
          jobId,
          quantityRequired: qty,
          scheduledDate: jobDateMap.get(jobId) || null,
          runningBalance: 0
        }))
        .sort((a, b) => {
          if (!a.scheduledDate && !b.scheduledDate) return a.jobId.localeCompare(b.jobId);
          if (!a.scheduledDate) return 1;
          if (!b.scheduledDate) return -1;
          return a.scheduledDate.getTime() - b.scheduledDate.getTime();
        });

      // Compute running balance
      const available = grp.stockOnHand + grp.openPoQty;
      let balance = available;
      let stockoutJob: string | null = null;
      let stockoutDate: Date | null = null;
      const totalDemand = jobDemands.reduce((sum, j) => sum + j.quantityRequired, 0);

      jobDemands.forEach((jd) => {
        balance -= jd.quantityRequired;
        jd.runningBalance = balance;
        if (balance < 0 && !stockoutJob) {
          stockoutJob = jd.jobId;
          stockoutDate = jd.scheduledDate;
        }
      });

      let status: 'sufficient' | 'warning' | 'shortage';
      if (stockoutJob) {
        status = balance < -available * 0.5 ? 'shortage' : 'warning';
      } else {
        status = 'sufficient';
      }

      result.push({
        code,
        description: grp.desc,
        uom: grp.uom,
        stockOnHand: grp.stockOnHand,
        openPoQty: grp.openPoQty,
        totalDemand,
        finalBalance: balance,
        stockoutJob,
        stockoutDate,
        status,
        jobs: jobDemands
      });
    });

    // Sort: stockout first, then warnings, then OK; within same status sort by code
    return result.sort((a, b) => {
      const order = { shortage: 0, warning: 1, sufficient: 2 };
      return order[a.status] - order[b.status] || a.code.localeCompare(b.code);
    });
  }, [materialPlan, jobDateMap]);

  const shortages = materials.filter((m) => m.status === 'shortage').length;
  const warnings = materials.filter((m) => m.status === 'warning').length;
  const ok = materials.filter((m) => m.status === 'sufficient').length;

  return (
    <div className="material-visibility">
      <div className="mat-header">
        <h3>Material Stockout Projection</h3>
        <div className="mat-stats">
          <span className="stat-item error">{shortages} Stockout</span>
          <span className="stat-item warning">{warnings} At Risk</span>
          <span className="stat-item success">{ok} OK</span>
          <span className="stat-item neutral">{materials.length} Materials</span>
        </div>
      </div>

      {materials.length === 0 && (
        <div className="material-alert">No material plan loaded. Generate a schedule and load material data first.</div>
      )}

      <div className="material-table">
        <div className="table-header mat-grid">
          <div>Material</div>
          <div>Description</div>
          <div className="text-right">Stock OH</div>
          <div className="text-right">Open PO</div>
          <div className="text-right">Total Demand</div>
          <div className="text-right">Balance</div>
          <div>Stockout Job</div>
          <div>Stockout Date</div>
        </div>

        <div className="table-body">
          {materials.map((mat) => (
            <React.Fragment key={mat.code}>
              <div
                className={`table-row mat-grid row-${mat.status} ${expandedMaterial === mat.code ? 'row-expanded' : ''}`}
                onClick={() => setExpandedMaterial(expandedMaterial === mat.code ? null : mat.code)}
                style={{ cursor: 'pointer' }}
              >
                <div className="col-code">
                  <span className="expand-icon">{expandedMaterial === mat.code ? '▾' : '▸'}</span>
                  {mat.code}
                </div>
                <div className="col-desc">{mat.description || '—'}</div>
                <div className="text-right col-num">{fmtQty(mat.stockOnHand)}</div>
                <div className="text-right col-num">{fmtQty(mat.openPoQty)}</div>
                <div className="text-right col-num">{fmtQty(mat.totalDemand)}</div>
                <div className={`text-right col-num ${mat.finalBalance < 0 ? 'col-negative' : ''}`}>
                  {fmtQty(mat.finalBalance)}
                </div>
                <div className="col-stockout-job">{mat.stockoutJob || '—'}</div>
                <div className="col-stockout-date">{mat.stockoutJob ? fmtDate(mat.stockoutDate) : '—'}</div>
              </div>

              {expandedMaterial === mat.code && (
                <div className="mat-detail">
                  <div className="mat-detail-header">
                    <div>Job</div>
                    <div>Scheduled</div>
                    <div className="text-right">Qty Required</div>
                    <div className="text-right">Running Balance</div>
                  </div>
                  {mat.jobs.map((jd) => (
                    <div key={jd.jobId} className={`mat-detail-row ${jd.runningBalance < 0 ? 'detail-negative' : ''}`}>
                      <div className="detail-job">{jd.jobId}</div>
                      <div className="detail-date">{fmtDate(jd.scheduledDate)}</div>
                      <div className="text-right">{fmtQty(jd.quantityRequired)}</div>
                      <div className={`text-right ${jd.runningBalance < 0 ? 'col-negative' : ''}`}>
                        {fmtQty(jd.runningBalance)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {shortages + warnings > 0 && (
        <div className="material-alert">
          <strong>⚠️ {shortages + warnings} material(s)</strong> will stock out before all jobs complete. Click a row to see which job causes the shortage.
        </div>
      )}
    </div>
  );
}
