import React from 'react';
import { vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ isRole: () => true }) }));
vi.mock('../services/api', () => {
  const v = (id: string, kind: string, name: string, otd: number) => ({
    versionId: id, kind, name, status: 'Draft', savedAt: '2026-10-01T08:00:00Z', createdBy: 'gd',
    jobCount: 10, operationCount: 30, horizonStart: null, horizonEnd: null, basedOnId: null,
    metrics: { otdRate: otd, jobsTardy: 100 - otd, resourceUtilization: 70, violations: 1 },
  });
  return {
    apiErrorMessage: (_e: unknown, m: string) => m,
    scheduleService: { loadLatest: vi.fn(async () => ({ schedule: null })) },
    versionService: {
      list: vi.fn(async () => ({
        master: v('M', 'Master', 'Monday plan', 90),
        whatIfs: [v('W', 'WhatIf', 'Saturday overtime', 97)],
        history: [v('H', 'History', 'Last week', 80)],
      })),
      publishStatus: vi.fn(async () => ({
        jobs: [{ jobId: 'J1', state: 'Published' }, { jobId: 'J2', state: 'Error', lastError: 'No WipMaster row updated for job J2' }],
        counts: { Published: 1, Pending: 0, Error: 1 },
      })),
      get: vi.fn(async () => ({ schedule: { scheduleId: 'W', scheduledDate: '2026-10-01', planningHorizon: { startDate: '2026-10-01', endDate: '2026-10-08' }, jobSchedules: [], constraintViolations: [], metrics: {} } })),
    },
  };
});

import VersionsPanel from '../components/VersionsPanel';
import { useScheduleStore } from '../stores/scheduleStore';

describe('VersionsPanel', () => {
  it('lists master, what-ifs and history with the right actions', async () => {
    render(<VersionsPanel />);
    expect(await screen.findByText('Monday plan')).toBeInTheDocument();
    expect(screen.getByText('Saturday overtime')).toBeInTheDocument();
    expect(screen.getByText('Last week')).toBeInTheDocument();
    expect(screen.getByText('Commit to master')).toBeInTheDocument();
    expect(screen.getByText('Revert to this')).toBeInTheDocument();
    expect(await screen.findByText('1 error')).toBeInTheDocument();
    expect(screen.getByText(/No WipMaster row updated for job J2/)).toBeInTheDocument();
  });

  it('compares ticked versions and marks the best value', async () => {
    render(<VersionsPanel />);
    await screen.findByText('Monday plan');
    fireEvent.click(screen.getByLabelText('Compare Monday plan'));
    fireEvent.click(screen.getByLabelText('Compare Saturday overtime'));
    const best = await screen.findByText('97.0%', { selector: '.vp-best' });
    expect(best).toBeInTheDocument();
  });

  it('opening a what-if puts it on the board as the active version', async () => {
    render(<VersionsPanel />);
    await screen.findByText('Saturday overtime');
    const openButtons = screen.getAllByText('Open');
    fireEvent.click(openButtons[openButtons.length - 1]);
    await waitFor(() => expect(useScheduleStore.getState().activeVersion).toEqual({ versionId: 'W', name: 'Saturday overtime' }));
    expect(screen.getByRole('status')).toHaveTextContent('Working in what-if');
  });
});
