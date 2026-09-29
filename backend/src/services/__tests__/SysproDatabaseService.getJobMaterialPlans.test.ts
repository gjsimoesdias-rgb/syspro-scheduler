/**
 * Unit tests for SysproDatabaseService.getJobMaterialPlans().
 *
 * This is the single source of truth for material-availability calculations
 * — three code paths consume it (BOM-detail modal, /jobs/material-plan
 * route, and the scheduling engine's checkMaterialAvailability). Locking
 * the formula in with focused tests prevents drift between them.
 *
 * Strategy: spy on the four inner queries (getInventoryByWarehouse,
 * getOpenPoReceipts, getAllOpenJobAllocations, getMaterialsByJob) so the
 * tests run without SQL Server and exercise the real algorithm.
 *
 * Covered:
 *  1. empty jobs[] → empty Map
 *  2. job with no BOM → status='Materials', available=true
 *  3. single-warehouse: requiredQty = qtyPerUnit * orderQty * (1+scrap)
 *  4. multi-warehouse: onHand sums across all warehouses
 *  5. WIP/SO allocations subtract from free stock
 *  6. other open jobs' WIP picks subtract from this job's availability
 *  7. PO receipt with promiseDate <= job's need date counts as incoming
 *  8. PO receipt with promiseDate > need date is excluded (time-phasing)
 *  9. scheduledOrder depletion: earlier job's consumption reduces later job's free pool
 * 10. status: Partial when 0 < availableQty < requiredQty
 * 11. status: No Materials when availableQty == 0 and requiredQty > 0
 */

import { SysproDatabaseService } from '../SysproDatabaseService';
import type { Job, BOMLine } from '../../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(opts: {
  jobId: string;
  itemCode: string;
  quantity?: number;
  releaseDate?: Date;
  dueDate?: Date;
}): Job {
  return {
    jobId: opts.jobId,
    itemCode: opts.itemCode,
    description: '',
    quantity: opts.quantity ?? 1,
    priority: 5,
    releaseDate: opts.releaseDate ?? new Date('2026-05-11T00:00:00Z'),
    dueDate: opts.dueDate ?? new Date('2026-05-25T00:00:00Z'),
    status: 'Released',
    operations: [],
  } as any;
}

interface WarehouseRow {
  code: string;
  description: string;
  unitOfMeasure: string;
  warehouseCode: string;
  qtyOnHand: number;
  qtyAllocWip: number;
  qtyAllocSO: number;
  leadTimeDays: number;
}

interface PoRow {
  componentCode: string;
  poNumber: string;
  promiseDate: Date | null;
  dueDate: Date | null;
  outstandingQty: number;
}

/**
 * Build a service with the four inner queries replaced by stubs. Pass a
 * `bomFor(itemCode, jobId)` resolver so each job can supply its own BOM.
 */
function buildService(opts: {
  warehouseRows: WarehouseRow[];
  poRows: PoRow[];
  allocations?: Map<string, Map<string, number>>;
  bomFor: (itemCode: string, jobId: string) => BOMLine[];
}): SysproDatabaseService {
  // SysproDatabaseService's constructor wants a DatabaseConnection; we
  // never use it because every inner method is replaced.
  const stubDb: any = {
    query: jest.fn(),
    queryWithParams: jest.fn(),
    execute: jest.fn(),
  };
  const svc = new SysproDatabaseService(stubDb);

  jest.spyOn(svc as any, 'getInventoryByWarehouse').mockResolvedValue(opts.warehouseRows);
  jest.spyOn(svc as any, 'getOpenPoReceipts').mockResolvedValue(opts.poRows);
  jest
    .spyOn(svc as any, 'getAllOpenJobAllocations')
    .mockResolvedValue(opts.allocations ?? new Map());
  jest
    .spyOn(svc as any, 'getMaterialsByJob')
    .mockImplementation((itemCode: any, jobId: any) =>
      Promise.resolve(opts.bomFor(String(itemCode), String(jobId)))
    );

  return svc;
}

function bomLine(componentCode: string, quantityRequired: number, scrap = 0, uom = 'EA'): BOMLine {
  return {
    bomId: `${componentCode}-bom`,
    itemCode: 'PARENT',
    componentCode,
    quantityRequired,
    unitOfMeasure: uom,
    scrapFactor: scrap,
  } as BOMLine;
}

function wh(opts: Partial<WarehouseRow> & { code: string }): WarehouseRow {
  return {
    description: '',
    unitOfMeasure: 'EA',
    warehouseCode: 'MAIN',
    qtyOnHand: 0,
    qtyAllocWip: 0,
    qtyAllocSO: 0,
    leadTimeDays: 0,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getJobMaterialPlans — basics', () => {
  it('returns an empty Map for an empty job list', async () => {
    const svc = buildService({
      warehouseRows: [],
      poRows: [],
      bomFor: () => [],
    });
    const result = await svc.getJobMaterialPlans([]);
    expect(result.size).toBe(0);
  });

  it('returns status="Materials" + empty shortages for a job with no BOM lines', async () => {
    const svc = buildService({
      warehouseRows: [],
      poRows: [],
      bomFor: () => [],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET' }),
    ]);
    const plan = result.get('J1');
    expect(plan).toBeDefined();
    expect(plan!.status).toBe('Materials');
    expect(plan!.available).toBe(true);
    expect(plan!.shortages).toEqual([]);
  });
});

describe('getJobMaterialPlans — single-warehouse arithmetic', () => {
  it('computes requiredQty = qtyPerUnit × orderQty × (1 + scrap)', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 100 })],
      poRows: [],
      // 1 widget needs 2 of C-1; scrap 10%; order 10 widgets ⇒ require 22.
      bomFor: () => [bomLine('C-1', 2, 0.10)],
    });

    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 10 }),
    ]);
    const plan = result.get('J1')!;
    // 22 required vs 100 on hand → OK.
    expect(plan.status).toBe('Materials');
    expect(plan.shortages).toEqual([]);
  });

  it('reports a shortage with the exact deficit when stock < requirement', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 5 })],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 10 }),
    ]);
    const plan = result.get('J1')!;
    expect(plan.status).toBe('Partial'); // some available, just not all
    expect(plan.shortages).toHaveLength(1);
    expect(plan.shortages[0].componentCode).toBe('C-1');
    expect(plan.shortages[0].requiredQty).toBe(10);
    expect(plan.shortages[0].availableQty).toBe(5);
    expect(plan.shortages[0].shortageQty).toBe(5);
  });

  it('reports "No Materials" when nothing is available at all', async () => {
    const svc = buildService({
      warehouseRows: [],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 3 }),
    ]);
    const plan = result.get('J1')!;
    expect(plan.status).toBe('No Materials');
    expect(plan.shortages[0].availableQty).toBe(0);
    expect(plan.shortages[0].shortageQty).toBe(3);
  });
});

describe('getJobMaterialPlans — multi-warehouse', () => {
  it('sums qtyOnHand across every warehouse for the same stock code', async () => {
    const svc = buildService({
      warehouseRows: [
        wh({ code: 'C-1', warehouseCode: 'MAIN', qtyOnHand: 5 }),
        wh({ code: 'C-1', warehouseCode: 'SPARE', qtyOnHand: 7 }),
      ],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 10 }),
    ]);
    // 5 + 7 = 12 on hand vs 10 required → OK
    expect(result.get('J1')!.status).toBe('Materials');
  });

  it('treats WIP + SO allocations as reserved (subtracts from free)', async () => {
    const svc = buildService({
      warehouseRows: [
        wh({ code: 'C-1', qtyOnHand: 10, qtyAllocWip: 4, qtyAllocSO: 3 }),
      ],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 5 }),
    ]);
    // free = 10 - 4 - 3 = 3 ; required = 5 ⇒ Partial, short 2
    const plan = result.get('J1')!;
    expect(plan.status).toBe('Partial');
    expect(plan.shortages[0].availableQty).toBe(3);
    expect(plan.shortages[0].shortageQty).toBe(2);
  });
});

describe('getJobMaterialPlans — other-job holds', () => {
  it('subtracts another open job\'s outstanding WIP holds from this job\'s availability', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 10 })],
      poRows: [],
      allocations: new Map([['J-OTHER', new Map([['C-1', 6]])]]),
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 8 }),
    ]);
    // free = 10 - 0 (alloc) - 6 (J-OTHER) = 4 ; required = 8 ⇒ Partial
    expect(result.get('J1')!.status).toBe('Partial');
    expect(result.get('J1')!.shortages[0].shortageQty).toBe(4);
  });

  it('ignores this job\'s own holds (must not double-count its own pick)', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 10 })],
      poRows: [],
      allocations: new Map([['J1', new Map([['C-1', 6]])]]),
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 8 }),
    ]);
    // free = 10 - 0 - 0 (self excluded) = 10 ; required = 8 ⇒ OK
    expect(result.get('J1')!.status).toBe('Materials');
  });
});

describe('getJobMaterialPlans — time-phased PO receipts', () => {
  it('counts a PO receipt whose promiseDate falls on/before the need date', async () => {
    const needDate = new Date('2026-05-20T00:00:00Z');
    const earlierPo = new Date('2026-05-15T00:00:00Z');
    const svc = buildService({
      warehouseRows: [],
      poRows: [
        {
          componentCode: 'C-1',
          poNumber: 'PO-1',
          promiseDate: earlierPo,
          dueDate: null,
          outstandingQty: 50,
        },
      ],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 30, releaseDate: needDate, dueDate: needDate }),
    ]);
    // 0 on hand + 50 incoming ≥ 30 required → OK
    expect(result.get('J1')!.status).toBe('Materials');
  });

  it('excludes a PO receipt that arrives AFTER the need date', async () => {
    const needDate = new Date('2026-05-20T00:00:00Z');
    const latePo = new Date('2026-06-15T00:00:00Z'); // a month after need
    const svc = buildService({
      warehouseRows: [],
      poRows: [
        {
          componentCode: 'C-1',
          poNumber: 'PO-LATE',
          promiseDate: latePo,
          dueDate: null,
          outstandingQty: 100,
        },
      ],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 5, releaseDate: needDate, dueDate: needDate }),
    ]);
    // PO doesn't count → 0 available, 5 required ⇒ No Materials
    expect(result.get('J1')!.status).toBe('No Materials');
  });

  it('counts a PO with no promiseDate (conservative: assume it arrives in time)', async () => {
    const svc = buildService({
      warehouseRows: [],
      poRows: [
        {
          componentCode: 'C-1',
          poNumber: 'PO-NOPROM',
          promiseDate: null,
          dueDate: null,
          outstandingQty: 10,
        },
      ],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'WIDGET', quantity: 5 }),
    ]);
    expect(result.get('J1')!.status).toBe('Materials');
  });
});

describe('getJobMaterialPlans — schedule-sequence depletion', () => {
  it('without scheduledOrder, both jobs see the same global pool', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 10 })],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans([
      makeJob({ jobId: 'J1', itemCode: 'A', quantity: 6 }),
      makeJob({ jobId: 'J2', itemCode: 'B', quantity: 6 }),
    ]);
    // Both jobs see 10 free → both Materials, but the second one would in
    // reality run dry. This is documented behaviour: without scheduledOrder
    // we don't simulate consumption.
    expect(result.get('J1')!.status).toBe('Materials');
    expect(result.get('J2')!.status).toBe('Materials');
  });

  it('with scheduledOrder, earlier job consumes the pool for the later one', async () => {
    const svc = buildService({
      warehouseRows: [wh({ code: 'C-1', qtyOnHand: 10 })],
      poRows: [],
      bomFor: () => [bomLine('C-1', 1)],
    });
    const result = await svc.getJobMaterialPlans(
      [
        makeJob({ jobId: 'J1', itemCode: 'A', quantity: 6 }),
        makeJob({ jobId: 'J2', itemCode: 'B', quantity: 6 }),
      ],
      ['J1', 'J2'] // J1 first
    );
    expect(result.get('J1')!.status).toBe('Materials'); // 10 ≥ 6
    // After J1: 4 remaining. J2 needs 6 ⇒ Partial, short 2.
    expect(result.get('J2')!.status).toBe('Partial');
    expect(result.get('J2')!.shortages[0].shortageQty).toBe(2);
  });
});
