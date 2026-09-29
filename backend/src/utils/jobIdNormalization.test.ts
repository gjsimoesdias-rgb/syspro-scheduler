/**
 * canonicalJobKey / resolveMasterLinks — master/sub link normalisation.
 *
 * The regression these guard against: SYSPRO returns the master link in a
 * different format than the job key (unpadded vs zero-padded, char-column
 * trailing spaces, view-trimmed), which silently disabled master/sub
 * precedence in both engines because they compare with string equality.
 */
import { canonicalJobKey, resolveMasterLinks } from './jobIdNormalization';
import { Job } from '../types';

const makeJob = (jobId: string, extra: Partial<Job> = {}): Job =>
  ({
    jobId,
    itemCode: 'ITEM-1',
    description: 'test',
    quantity: 1,
    dueDate: new Date('2026-08-01'),
    releaseDate: new Date('2026-07-01'),
    priority: 5,
    status: 'Released',
    operations: [],
    ...extra,
  } as unknown as Job);

describe('canonicalJobKey', () => {
  it('trims whitespace padding', () => {
    expect(canonicalJobKey('  JOB-1  ')).toBe('JOB-1');
  });

  it('strips leading zeros from purely numeric ids', () => {
    expect(canonicalJobKey('000000000012345')).toBe('12345');
    expect(canonicalJobKey('12345')).toBe('12345');
    expect(canonicalJobKey('0')).toBe('0');
  });

  it('keeps alphanumeric ids intact but case-insensitive', () => {
    expect(canonicalJobKey('00J-15')).toBe('00J-15');
    expect(canonicalJobKey('job-a')).toBe('JOB-A');
  });

  it('returns empty string for null/undefined/blank', () => {
    expect(canonicalJobKey(null)).toBe('');
    expect(canonicalJobKey(undefined)).toBe('');
    expect(canonicalJobKey('   ')).toBe('');
  });
});

describe('resolveMasterLinks', () => {
  it('rewrites an unpadded master link to the exact padded jobId', () => {
    const master = makeJob('000000000012345');
    const sub = makeJob('000000000067890', { masterJobId: '12345' } as any);
    const stats = resolveMasterLinks([master, sub]);

    expect((sub as any).masterJobId).toBe('000000000012345');
    expect((sub as any).isSubJob).toBe(true);
    expect((master as any).isMasterJob).toBe(true);
    expect(stats.resolved).toBe(1);
  });

  it('rewrites a space-padded master link (char column) to the exact jobId', () => {
    const master = makeJob('MST-1');
    const sub = makeJob('SUB-1', { masterJobId: 'MST-1   ' } as any);
    resolveMasterLinks([master, sub]);

    expect((sub as any).masterJobId).toBe('MST-1');
  });

  it('leaves exact matches untouched and reports zero rewrites', () => {
    const master = makeJob('MST-1', { isMasterJob: true } as any);
    const sub = makeJob('SUB-1', { masterJobId: 'MST-1', isSubJob: true } as any);
    const stats = resolveMasterLinks([master, sub]);

    expect((sub as any).masterJobId).toBe('MST-1');
    expect(stats.resolved).toBe(0);
    expect(stats.selfCleared).toBe(0);
    expect(stats.unresolved).toBe(0);
  });

  it('clears self-referencing links, including format-mismatched ones', () => {
    const direct = makeJob('JOB-1', { masterJobId: 'JOB-1' } as any);
    const padded = makeJob('000123', { masterJobId: '123' } as any);
    const stats = resolveMasterLinks([direct, padded]);

    expect((direct as any).masterJobId).toBeNull();
    expect((padded as any).masterJobId).toBeNull();
    expect(stats.selfCleared).toBe(2);
  });

  it('keeps (trimmed) links to masters outside the loaded set', () => {
    const sub = makeJob('SUB-1', { masterJobId: ' GHOST-99 ' } as any);
    const stats = resolveMasterLinks([sub]);

    expect((sub as any).masterJobId).toBe('GHOST-99');
    expect(stats.unresolved).toBe(1);
  });

  it('normalises empty/whitespace links to null', () => {
    const a = makeJob('A', { masterJobId: '' } as any);
    const b = makeJob('B', { masterJobId: '   ' } as any);
    resolveMasterLinks([a, b]);

    expect((a as any).masterJobId).toBeNull();
    expect((b as any).masterJobId).toBeNull();
  });

  it('resolves nested hierarchies (a sub that is itself a master)', () => {
    const top = makeJob('000000000000001');
    const mid = makeJob('000000000000002', { masterJobId: '1' } as any);
    const leaf = makeJob('000000000000003', { masterJobId: '2' } as any);
    resolveMasterLinks([top, mid, leaf]);

    expect((mid as any).masterJobId).toBe('000000000000001');
    expect((leaf as any).masterJobId).toBe('000000000000002');
    expect((mid as any).isMasterJob).toBe(true);
    expect((mid as any).isSubJob).toBe(true);
  });
});
