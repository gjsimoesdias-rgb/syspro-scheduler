/**
 * Unit tests for AppStateStore.
 *
 * Use a hand-rolled DatabaseConnection stub that captures every call,
 * so we can assert on parameterised SQL contracts without spinning
 * up SQL Server. Tests cover:
 *   - ensureTable() runs the IF NOT EXISTS CREATE
 *   - get() returns parsed JSON
 *   - get() returns undefined on missing row / malformed JSON / query error
 *   - set() upserts with the right parameter shape
 *   - clear() deletes by key
 *   - hydrateAppLocals() bulk-restores into the supplied object
 */

import AppStateStore from '../AppStateStore';

// ---------------------------------------------------------------------------
// Test double for DatabaseConnection
// ---------------------------------------------------------------------------

type Recordset = Array<Record<string, any>>;

interface CapturedCall {
  kind: 'query' | 'queryWithParams' | 'execute';
  sql: string;
  params?: Record<string, any>;
}

/**
 * A tiny in-memory store keyed by SQL signature → recordset. Either
 * pre-load responses with `setRecordset(matcher, rows)` or rely on the
 * default `[]`.
 */
class FakeDb {
  calls: CapturedCall[] = [];
  /** Most-recent-first list of [matcher, recordset]. */
  private responses: Array<[(sql: string) => boolean, Recordset]> = [];
  /** SQL patterns that should throw. */
  private failures: Array<(sql: string) => boolean> = [];

  whenSql(matcher: (sql: string) => boolean, recordset: Recordset): this {
    this.responses.unshift([matcher, recordset]);
    return this;
  }

  failWhenSql(matcher: (sql: string) => boolean): this {
    this.failures.push(matcher);
    return this;
  }

  private lookup(sql: string): Recordset {
    for (const [match] of this.failures.map((f) => [f] as const)) {
      if (match(sql)) throw new Error('Simulated DB failure');
    }
    for (const [match, rows] of this.responses) {
      if (match(sql)) return rows;
    }
    return [];
  }

  async query(sql: string): Promise<{ recordset: Recordset }> {
    this.calls.push({ kind: 'query', sql });
    return { recordset: this.lookup(sql) };
  }

  async queryWithParams(
    sql: string,
    params: Record<string, any>
  ): Promise<{ recordset: Recordset }> {
    this.calls.push({ kind: 'queryWithParams', sql, params });
    return { recordset: this.lookup(sql) };
  }

  // execute() unused by AppStateStore; defined to satisfy the type.
  async execute(procedure: string, params: Record<string, any> = {}): Promise<any> {
    this.calls.push({ kind: 'execute', sql: procedure, params });
    return { recordset: [] };
  }
}

const newStore = () => {
  const db = new FakeDb();
  // AppStateStore expects a DatabaseConnection; FakeDb is structurally
  // compatible because every consumer only ever calls query /
  // queryWithParams. The `as any` cast is intentional and confined here.
  return { db, store: new AppStateStore(db as any) };
};

// ---------------------------------------------------------------------------
// ensureTable
// ---------------------------------------------------------------------------

describe('AppStateStore.ensureTable', () => {
  it('runs an IF NOT EXISTS CREATE TABLE for sch_AppState', async () => {
    const { db, store } = newStore();
    await store.ensureTable();

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].kind).toBe('query');
    expect(db.calls[0].sql).toMatch(/IF NOT EXISTS/);
    expect(db.calls[0].sql).toMatch(/CREATE TABLE sch_AppState/);
    expect(db.calls[0].sql).toMatch(/stateKey\s+NVARCHAR\(100\)/);
    expect(db.calls[0].sql).toMatch(/payload\s+NVARCHAR\(MAX\)/);
  });

  it('logs but does not throw when the CREATE fails', async () => {
    const { db, store } = newStore();
    db.failWhenSql(() => true);
    await expect(store.ensureTable()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get
// ---------------------------------------------------------------------------

describe('AppStateStore.get', () => {
  it('returns parsed JSON for a present row', async () => {
    const { db, store } = newStore();
    db.whenSql(
      (sql) => sql.includes('SELECT payload FROM sch_AppState'),
      [{ payload: JSON.stringify({ hello: 'world', count: 7 }) }]
    );

    const value = await store.get<{ hello: string; count: number }>('importedJobs');
    expect(value).toEqual({ hello: 'world', count: 7 });

    expect(db.calls[0].kind).toBe('queryWithParams');
    expect(db.calls[0].params).toEqual({ key: 'importedJobs' });
  });

  it('returns undefined for a missing row', async () => {
    const { store } = newStore();
    const value = await store.get('shiftTemplates');
    expect(value).toBeUndefined();
  });

  it('returns undefined when the row holds malformed JSON', async () => {
    const { db, store } = newStore();
    db.whenSql(() => true, [{ payload: '{not valid json' }]);

    const value = await store.get('importedJobs');
    expect(value).toBeUndefined();
  });

  it('returns undefined and does not throw when the query itself fails', async () => {
    const { db, store } = newStore();
    db.failWhenSql(() => true);
    await expect(store.get('importedJobs')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// set
// ---------------------------------------------------------------------------

describe('AppStateStore.set', () => {
  it('upserts with the right parameter shape', async () => {
    const { db, store } = newStore();
    await store.set('importedJobs', [{ jobId: 'WO-1' }], 'user-42');

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toMatch(/MERGE sch_AppState/);
    expect(db.calls[0].sql).toMatch(/WITH \(HOLDLOCK\)/);
    expect(db.calls[0].params).toEqual({
      key: 'importedJobs',
      payload: JSON.stringify([{ jobId: 'WO-1' }]),
      updatedBy: 'user-42',
    });
  });

  it('serialises null/undefined as the JSON literal null', async () => {
    const { db, store } = newStore();
    await store.set('importedOperations', undefined as any);
    expect(db.calls[0].params!.payload).toBe('null');
  });

  it('defaults updatedBy to "system" when not supplied', async () => {
    const { db, store } = newStore();
    await store.set('importedJobs', []);
    expect(db.calls[0].params!.updatedBy).toBe('system');
  });

  it('does not throw when the underlying query fails', async () => {
    const { db, store } = newStore();
    db.failWhenSql(() => true);
    await expect(store.set('importedJobs', [])).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe('AppStateStore.clear', () => {
  it('issues a DELETE keyed by stateKey', async () => {
    const { db, store } = newStore();
    await store.clear('shiftTemplates');

    expect(db.calls[0].sql).toMatch(/DELETE FROM sch_AppState/);
    expect(db.calls[0].params).toEqual({ key: 'shiftTemplates' });
  });
});

// ---------------------------------------------------------------------------
// hydrateAppLocals
// ---------------------------------------------------------------------------

describe('AppStateStore.hydrateAppLocals', () => {
  it('restores every present key into the target object', async () => {
    const { db, store } = newStore();
    db.whenSql(() => true, []); // default to empty
    db.whenSql(
      (sql, /* … */) => sql.includes('SELECT payload'),
      [{ payload: JSON.stringify([{ id: 'imported-1' }]) }]
    );

    const locals: Record<string, any> = {};
    await store.hydrateAppLocals(locals);

    // Every known key is queried exactly once.
    const keysQueried = db.calls
      .filter((c) => c.kind === 'queryWithParams')
      .map((c) => c.params!.key);
    expect(new Set(keysQueried)).toEqual(
      new Set([
        'importedJobs',
        'importedOperations',
        'resourceDefinitions',
        'shiftTemplates',
        'constraintOverrides',
        'alternativeGroups',
        'pinnedOperations',
        'calendarExceptions',
      ])
    );

    // Every key the query returned a payload for is populated in locals.
    // (Our matcher always returns the same payload, so every key is set.)
    expect(locals.importedJobs).toEqual([{ id: 'imported-1' }]);
    expect(locals.constraintOverrides).toEqual([{ id: 'imported-1' }]);
  });

  it('leaves unmatched keys absent on the target object', async () => {
    const { db, store } = newStore();
    db.whenSql(
      (_sql) => false, // nothing matches → every get() returns undefined
      []
    );

    const locals: Record<string, any> = {};
    await store.hydrateAppLocals(locals);

    expect(Object.keys(locals)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Roundtrip — semantic check that set() then get() preserves the payload
// ---------------------------------------------------------------------------

describe('AppStateStore roundtrip', () => {
  it('returns from get() exactly what was passed to set()', async () => {
    // Build a fake "DB" that mirrors writes back to reads.
    const memory = new Map<string, string>();
    const db: any = {
      async query() {
        return { recordset: [] };
      },
      async queryWithParams(sql: string, params: Record<string, any>) {
        if (sql.includes('SELECT payload FROM sch_AppState')) {
          const row = memory.get(params.key);
          return { recordset: row !== undefined ? [{ payload: row }] : [] };
        }
        if (sql.includes('MERGE sch_AppState')) {
          memory.set(params.key, params.payload);
          return { recordset: [] };
        }
        if (sql.includes('DELETE FROM sch_AppState')) {
          memory.delete(params.key);
          return { recordset: [] };
        }
        return { recordset: [] };
      },
    };
    const store = new AppStateStore(db);

    const sample = { ts: '2026-05-11T00:00:00Z', items: ['a', 'b', 'c'] };
    await store.set('importedJobs', sample);

    expect(await store.get('importedJobs')).toEqual(sample);
    await store.clear('importedJobs');
    expect(await store.get('importedJobs')).toBeUndefined();
  });
});
