import { describe, it, expect } from 'vitest';
import { scoreCommand } from '../CommandPalette';

describe('scoreCommand', () => {
  const machines = { label: 'Machines', group: 'Analyse', keywords: 'workunit load utilisation' };
  it('matches words in any order across label, group and keywords', () => {
    expect(scoreCommand(machines, 'analyse mach')).toBeGreaterThan(0);
    expect(scoreCommand(machines, 'workunit')).toBeGreaterThan(0);
    expect(scoreCommand(machines, 'gantt')).toBe(0);
  });
  it('ranks a label-prefix match above a keyword match', () => {
    expect(scoreCommand({ label: 'Markers', group: 'Manage' }, 'mar'))
      .toBeGreaterThan(scoreCommand({ label: 'Sales orders', group: 'Promise', keywords: 'market' }, 'mar'));
  });
});
