import React, { useMemo } from 'react';
import { addDays, format } from 'date-fns';
import { Schedule, Resource } from '../types';
import './CapacityHistogram.css';

interface CapacityHistogramProps {
  schedule: Schedule | null;
  resources: Resource[];
  horizonStart: string;
  horizonEnd: string;
}

const CapacityHistogram: React.FC<CapacityHistogramProps> = ({
  schedule,
  resources,
  horizonStart,
  horizonEnd,
}) => {
  const workcentres = useMemo(
    () => Array.from(new Set(resources.map((r) => r.worcentreId))).sort(),
    [resources]
  );

  const start = new Date(horizonStart);
  const end = new Date(horizonEnd);
  const totalDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24))
  );

  // Bucket granularity: if horizon > 14 days use weekly buckets, else daily
  const useDays = totalDays <= 21;
  const bucketDays = useDays ? 1 : 7;
  const buckets = Math.ceil(totalDays / bucketDays);

  // Build load per workcentre per bucket (hours)
  const loadData = useMemo(() => {
    const data: Record<string, number[]> = {};
    for (const wc of workcentres) {
      data[wc] = Array(buckets).fill(0);
    }
    if (!schedule) return data;

    for (const js of schedule.jobSchedules) {
      for (const op of js.operationSchedules) {
        const wc = op.workcentreId;
        if (!data[wc]) data[wc] = Array(buckets).fill(0);
        const opStartMs = new Date(op.plannedStartDate).getTime();
        const bucketIdx = Math.floor((opStartMs - start.getTime()) / (bucketDays * 24 * 3600 * 1000));
        if (bucketIdx >= 0 && bucketIdx < buckets) {
          data[wc][bucketIdx] += (Number(op.duration) || 0) / 60;
        }
      }
    }
    return data;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule, workcentres, buckets, bucketDays]);

  const bucketLabels = Array.from({ length: buckets }, (_, i) =>
    format(addDays(start, i * bucketDays), useDays ? 'dd MMM' : "'W'w")
  );

  const capacityPerBucket = bucketDays * 8; // 8h/day capacity baseline

  if (!schedule || workcentres.length === 0) {
    return (
      <div className="capacity-histogram empty">
        <p>Generate a schedule to view capacity histogram.</p>
      </div>
    );
  }

  return (
    <div className="capacity-histogram">
      <div className="cap-hist-header">
        <h3>Capacity Loading Histogram</h3>
        <p>Scheduled hours per {useDays ? 'day' : 'week'} vs 8h/day capacity baseline (dashed line)</p>
      </div>
      <div className="cap-hist-grid">
        {workcentres.map((wc) => {
          const maxLoad = Math.max(capacityPerBucket * 1.3, ...loadData[wc]);
          return (
            <div className="cap-wc-block" key={wc}>
              <div className="cap-wc-title">{wc}</div>
              <div className="cap-wc-chart">
                <div className="cap-chart-bars">
                  {loadData[wc].map((load, bi) => {
                    const pct = Math.min(100, (load / maxLoad) * 100);
                    const capPct = (capacityPerBucket / maxLoad) * 100;
                    const isOver = load > capacityPerBucket;
                    return (
                      <div className="cap-bar-col" key={bi} title={`${bucketLabels[bi]}: ${load.toFixed(1)}h loaded`}>
                        <div className="cap-bar-outer" style={{ height: 80 }}>
                          <div
                            className={`cap-bar-fill ${isOver ? 'over' : 'under'}`}
                            style={{ height: `${pct}%` }}
                          />
                          <div className="cap-capacity-line" style={{ bottom: `${capPct}%` }} />
                        </div>
                        <div className="cap-bar-label">{bucketLabels[bi]}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default CapacityHistogram;
