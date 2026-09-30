import { buildBomTree } from '../BomTreeService';

// Structure:  TOP → A (x2), B (x1);  A → C (x3);  B → C (x1);  C → (nothing)
const STRUCTURE: Record<string, Array<{ component: string; qtyPer: number }>> = {
  TOP: [{ component: 'A', qtyPer: 2 }, { component: 'B', qtyPer: 1 }],
  A: [{ component: 'C', qtyPer: 3 }],
  B: [{ component: 'C', qtyPer: 1 }],
};
const ROUTING: Record<string, Array<{ operation: string; workcentreId: string }>> = {
  TOP: [{ operation: '10', workcentreId: 'ASSY' }],
  A: [{ operation: '10', workcentreId: 'CUT' }],
};

const fakeDb = () => {
  const calls: string[] = [];
  return {
    calls,
    queryWithParams: jest.fn(async (sql: string, params: Record<string, string>) => {
      const codes = Object.values(params);
      if (sql.includes('FROM InvMaster WHERE StockCode')) { calls.push('desc'); return { recordset: [{ description: 'Top item' }] }; }
      if (sql.includes('BomStructure')) {
        calls.push(`structure:${codes.join(',')}`);
        return { recordset: codes.flatMap((p) => (STRUCTURE[p] || []).map((c) => ({ parent: `${p}   `, ...c, description: `${c.component} desc`, hasRouting: 0 }))) };
      }
      calls.push(`routing:${codes.join(',')}`);
      return { recordset: codes.flatMap((p) => (ROUTING[p] || []).map((o) => ({ stockCode: p, ...o, setupHours: 0.5, unitRunHours: 0.1 }))) };
    }),
  };
};

describe('buildBomTree (batched per level)', () => {
  it('builds the same tree with one structure + one routing query per level', async () => {
    const db = fakeDb();
    const { root, nodeCount, warnings } = await buildBomTree(db, 'TOP');

    expect(root.description).toBe('Top item');
    expect(root.operations).toEqual([{ operation: '10', workcentreId: 'ASSY', setupMinutes: 30, unitRunMinutes: 6 }]);
    expect(root.children.map((c) => [c.stockCode, c.qtyPer, c.level])).toEqual([['A', 2, 1], ['B', 1, 1]]);
    expect(root.children[0].children.map((c) => [c.stockCode, c.qtyPer])).toEqual([['C', 3]]);
    expect(root.children[1].children.map((c) => [c.stockCode, c.qtyPer])).toEqual([['C', 1]]);
    expect(nodeCount).toBe(5); // TOP, A, C, B, C
    expect(warnings).toEqual([]);

    // Levels: [TOP] → [A,B] → [C]; C is fetched once although it appears twice.
    expect(db.calls.filter((c) => c.startsWith('structure'))).toEqual(['structure:TOP', 'structure:A,B', 'structure:C']);
    expect(db.calls.filter((c) => c.startsWith('routing'))).toEqual(['routing:TOP', 'routing:A,B', 'routing:C']);
  });

  it('flags circular references instead of looping', async () => {
    STRUCTURE.C = [{ component: 'A', qtyPer: 1 }];
    try {
      const { warnings } = await buildBomTree(fakeDb(), 'TOP');
      expect(warnings.some((w) => w.includes('Circular structure reference at A'))).toBe(true);
    } finally {
      delete STRUCTURE.C;
    }
  });
});
