/**
 * Inventory API routes
 * Provides Stock On Hand and Open Purchase Orders from Syspro.
 */

import { Router, Request, Response } from 'express';
import DatabaseConnection from '../../database/connection';
import { sysproServiceFor } from '../sysproServiceFor';
import { errorMessage } from '../../utils/errors';
import { asObj } from '../../utils/loose';
import type { DbParams } from '../../database/connection';

const router = Router();

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getDb(req: Request): DatabaseConnection | null {
  return req.app.locals.sysproDb || null;
}

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/stock
// Returns stock on hand across all warehouses, joined to InvMaster.
// Query params: warehouse, stockCode, lowStock (boolean)
// ─────────────────────────────────────────────────────────────
router.get('/stock', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', items: [] });
  }

  try {
    const { warehouse, stockCode, lowStock } = req.query;

    let sql = `
      SELECT
        w.StockCode,
        m.Description,
        m.ProductClass,
        m.Supplier           AS PreferredSupplier,
        m.LeadTime,
        m.StockUom           AS UnitOfMeasure,
        w.Warehouse,
        w.QtyOnHand,
        w.QtyAllocated,
        w.QtyAllocatedWip,
        w.QtyOnOrder,
        w.QtyInTransit,
        w.QtyInInspection,
        w.SafetyStockQty,
        w.ReOrderQty,
        w.MinimumQty,
        w.MaximumQty,
        w.UnitCost,
        w.DateLastSale,
        w.DateLastStockMove,
        w.DateLastPurchase,
        (w.QtyOnHand - w.QtyAllocated - w.QtyAllocatedWip) AS FreeOnHand
      FROM InvWarehouse w
      INNER JOIN InvMaster m ON m.StockCode = w.StockCode
      WHERE 1=1
    `;

    const params: DbParams = {};

    if (warehouse) {
      sql += ` AND w.Warehouse = @warehouse`;
      params.warehouse = String(warehouse);
    }
    if (stockCode) {
      sql += ` AND w.StockCode LIKE @stockCode`;
      params.stockCode = `%${String(stockCode)}%`;
    }
    if (lowStock === 'true') {
      sql += ` AND w.QtyOnHand <= w.SafetyStockQty AND w.SafetyStockQty > 0`;
    }

    sql += ` ORDER BY w.StockCode, w.Warehouse`;

    const result = await db.queryWithParams(sql, params);

    return res.json({
      items: result.recordset,
      count: result.recordset.length
    });
  } catch (err) {
    req.log.error({ err }, 'Stock on hand query failed');
    return res.status(500).json({ error: errorMessage(err), items: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/stock/:stockCode
// Returns per-warehouse stock detail for a single item.
// ─────────────────────────────────────────────────────────────
router.get('/stock/:stockCode', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', item: null });
  }

  try {
    const { stockCode } = req.params;

    const result = await db.queryWithParams(
      `SELECT
        w.StockCode,
        m.Description,
        m.ProductClass,
        m.Supplier           AS PreferredSupplier,
        m.LeadTime,
        m.StockUom           AS UnitOfMeasure,
        m.AbcClass,
        w.Warehouse,
        w.QtyOnHand,
        w.QtyAllocated,
        w.QtyAllocatedWip,
        w.QtyOnOrder,
        w.QtyInTransit,
        w.QtyInInspection,
        w.SafetyStockQty,
        w.ReOrderQty,
        w.MinimumQty,
        w.MaximumQty,
        w.UnitCost,
        w.DateLastSale,
        w.DateLastStockMove,
        w.DateLastPurchase,
        (w.QtyOnHand - w.QtyAllocated - w.QtyAllocatedWip) AS FreeOnHand
      FROM InvWarehouse w
      INNER JOIN InvMaster m ON m.StockCode = w.StockCode
      WHERE w.StockCode = @stockCode
      ORDER BY w.Warehouse`,
      { stockCode }
    );

    if (!result.recordset.length) {
      return res.status(404).json({ error: 'Stock code not found', item: null });
    }

    const master = result.recordset[0];
    const totalOnHand = result.recordset.reduce((s: number, r) => s + (Number(r.QtyOnHand) || 0), 0);
    const totalFree = result.recordset.reduce((s: number, r) => s + (Number(r.FreeOnHand) || 0), 0);

    return res.json({
      stockCode: master.StockCode,
      description: master.Description,
      productClass: master.ProductClass,
      unitOfMeasure: master.UnitOfMeasure,
      leadTime: master.LeadTime,
      abcClass: master.AbcClass,
      totalOnHand,
      totalFreeOnHand: totalFree,
      warehouses: result.recordset
    });
  } catch (err) {
    req.log.error({ err }, 'Stock detail query failed');
    return res.status(500).json({ error: errorMessage(err), item: null });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/purchase-orders
// Returns open PO header + lines joined together.
// Query params: supplier, stockCode, status (1=Ordered,4=Partial,...)
// ─────────────────────────────────────────────────────────────
router.get('/purchase-orders', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', items: [] });
  }

  try {
    const { supplier, stockCode, status: statusFilter } = req.query;

    // Status codes: 1=Ordered, 4=PartiallyReceived, 2=Print, 3=Reprint, 5=LCT
    // 6=Complete, 7=Cancelled, 9=Archived — exclude completed/cancelled
    const excludedStatuses = "'6','7','9'";

    let sql = `
      SELECT
        h.PurchaseOrder,
        h.OrderStatus,
        CASE h.OrderStatus
          WHEN '1' THEN 'Ordered'
          WHEN '2' THEN 'Print'
          WHEN '3' THEN 'Reprint'
          WHEN '4' THEN 'Partial'
          WHEN '5' THEN 'LCT'
          ELSE h.OrderStatus
        END AS OrderStatusLabel,
        h.Supplier,
        h.OrderEntryDate,
        h.OrderDueDate,
        h.Warehouse,
        d.Line,
        d.MStockCode      AS StockCode,
        d.MStockDes       AS StockDescription,
        d.MWarehouse      AS LineWarehouse,
        d.MOrderUom       AS OrderUom,
        d.MOrderQty       AS OrderedQty,
        d.MReceivedQty    AS ReceivedQty,
        (d.MOrderQty - d.MReceivedQty) AS OutstandingQty,
        d.MLatestDueDate  AS LineDueDate,
        d.MPrice          AS UnitPrice,
        (d.MOrderQty - d.MReceivedQty) * d.MPrice AS OutstandingValue,
        d.MCompleteFlag   AS LineComplete
      FROM PorMasterHdr h
      INNER JOIN PorMasterDetail d ON d.PurchaseOrder = h.PurchaseOrder
      WHERE h.OrderStatus NOT IN (${excludedStatuses})
        AND d.MCompleteFlag = 'N'
        AND d.LineType = 1
    `;

    const params: DbParams = {};

    if (supplier) {
      sql += ` AND h.Supplier = @supplier`;
      params.supplier = String(supplier);
    }
    if (stockCode) {
      sql += ` AND d.MStockCode LIKE @stockCode`;
      params.stockCode = `%${String(stockCode)}%`;
    }
    if (statusFilter) {
      sql += ` AND h.OrderStatus = @statusFilter`;
      params.statusFilter = String(statusFilter);
    }

    sql += ` ORDER BY h.OrderDueDate ASC, h.PurchaseOrder, d.Line`;

    const result = await db.queryWithParams(sql, params);

    return res.json({
      items: result.recordset,
      count: result.recordset.length
    });
  } catch (err) {
    req.log.error({ err }, 'Open PO query failed');
    return res.status(500).json({ error: errorMessage(err), items: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/purchase-orders/:stockCode
// Returns all open PO lines for a specific stock code.
// ─────────────────────────────────────────────────────────────
router.get('/purchase-orders/:stockCode', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', items: [] });
  }

  try {
    const { stockCode } = req.params;

    const result = await db.queryWithParams(
      `SELECT
        h.PurchaseOrder,
        h.OrderStatus,
        CASE h.OrderStatus
          WHEN '1' THEN 'Ordered'
          WHEN '2' THEN 'Print'
          WHEN '3' THEN 'Reprint'
          WHEN '4' THEN 'Partial'
          WHEN '5' THEN 'LCT'
          ELSE h.OrderStatus
        END AS OrderStatusLabel,
        h.Supplier,
        h.OrderEntryDate,
        h.OrderDueDate,
        d.Line,
        d.MStockCode          AS StockCode,
        d.MStockDes           AS StockDescription,
        d.MWarehouse          AS Warehouse,
        d.MOrderUom           AS OrderUom,
        d.MOrderQty           AS OrderedQty,
        d.MReceivedQty        AS ReceivedQty,
        (d.MOrderQty - d.MReceivedQty) AS OutstandingQty,
        d.MLatestDueDate      AS LineDueDate,
        d.MPrice              AS UnitPrice
      FROM PorMasterHdr h
      INNER JOIN PorMasterDetail d ON d.PurchaseOrder = h.PurchaseOrder
      WHERE h.OrderStatus NOT IN ('6','7','9')
        AND d.MCompleteFlag = 'N'
        AND d.LineType = 1
        AND d.MStockCode = @stockCode
      ORDER BY d.MLatestDueDate ASC`,
      { stockCode }
    );

    return res.json({
      stockCode,
      items: result.recordset,
      count: result.recordset.length,
      totalOutstanding: result.recordset.reduce((s: number, r) => s + (Number(r.OutstandingQty) || 0), 0)
    });
  } catch (err) {
    req.log.error({ err }, 'PO by stock code query failed');
    return res.status(500).json({ error: errorMessage(err), items: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/shortages
// Cross-references BOM requirements vs stock on hand + open POs
// to find material shortages across all open WIP jobs.
// ─────────────────────────────────────────────────────────────
router.get('/shortages', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', items: [] });
  }

  try {
    // Use WipJobAllMat — the actual WIP material allocations table.
    // QtyTotRequired = total qty needed (incl. scrap), QtyIssued = already issued,
    // QtyOutstanding = still to be issued.
    const result = await db.query(`
      SELECT
        m.Job,
        wm.StockCode                                                       AS JobStockCode,
        m.StockCode                                                        AS ComponentCode,
        m.StockDescription                                                 AS ComponentDesc,
        m.Uom                                                              AS UnitOfMeasure,
        m.QtyTotRequired                                                   AS TotalRequired,
        m.QtyIssued,
        m.QtyOutstanding,
        ISNULL(iw.QtyOnHand, 0)                                           AS OnHand,
        ISNULL(iw.QtyAllocated, 0) + ISNULL(iw.QtyAllocatedWip, 0)       AS Allocated,
        ISNULL(iw.QtyOnHand, 0)
          - ISNULL(iw.QtyAllocated, 0)
          - ISNULL(iw.QtyAllocatedWip, 0)                                 AS FreeOnHand,
        ISNULL((
          SELECT SUM(d.MOrderQty - d.MReceivedQty)
          FROM PorMasterDetail d
          JOIN PorMasterHdr h ON h.PurchaseOrder = d.PurchaseOrder
          WHERE d.MStockCode = m.StockCode
            AND d.MCompleteFlag = 'N'
            AND h.OrderStatus NOT IN ('6','7','9')
        ), 0)                                                              AS OpenPoQty,
        im.Supplier                                                        AS PreferredSupplier,
        im.LeadTime,
        im.AbcClass,
        im.ProductClass
      FROM WipJobAllMat m
      JOIN WipMaster wm
        ON wm.Job = m.Job
      LEFT JOIN InvWarehouse iw
        ON iw.StockCode = m.StockCode
        AND iw.Warehouse = m.Warehouse
      LEFT JOIN InvMaster im
        ON im.StockCode = m.StockCode
      WHERE wm.Complete IN ('0', ' ', '')
        AND m.AllocCompleted <> 'Y'
        AND m.QtyOutstanding > 0
      ORDER BY m.Job, m.StockCode
    `);

    // Filter to actual shortages: outstanding qty > FreeOnHand + OpenPoQty
    const shortages = result.recordset.map((r) => {
      const outstanding = Number(r.QtyOutstanding) || 0;
      const freeOnHand  = Number(r.FreeOnHand)     || 0;
      const openPoQty   = Number(r.OpenPoQty)      || 0;
      return {
        job:               r.Job,
        jobStockCode:      r.JobStockCode,
        componentCode:     r.ComponentCode,
        componentDesc:     r.ComponentDesc,
        totalRequired:     Number(r.TotalRequired) || 0,
        qtyIssued:         Number(r.QtyIssued)     || 0,
        qtyOutstanding:    outstanding,
        onHand:            Number(r.OnHand)        || 0,
        freeOnHand,
        openPoQty,
        netAvailable:      freeOnHand + openPoQty,
        shortage:          Math.max(0, outstanding - freeOnHand - openPoQty),
        unitOfMeasure:     r.UnitOfMeasure,
        preferredSupplier: r.PreferredSupplier || '',
        leadTime:          r.LeadTime         || 0,
        abcClass:          r.AbcClass         || '',
        productClass:      r.ProductClass     || ''
      };
    }).filter((r) => r.shortage > 0);

    return res.json({
      items: shortages,
      count: shortages.length,
      affectedJobs: [...new Set(shortages.map((s) => s.job))].length
    });
  } catch (err) {
    req.log.error({ err }, 'PO by stock code query failed');
    return res.status(500).json({ error: errorMessage(err), items: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/inventory/projection
// Projected inventory by day for the components the plan uses.
// Body: { jobs: [{ jobId, itemCode, quantity, start, end }] } — the planned
// dates from the current schedule (jobs without dates count as unscheduled).
// ─────────────────────────────────────────────────────────────
/** Planned jobs from the request body: [{ jobId, itemCode, quantity, start, end }]. */
function planJobsFrom(req: Request) {
  const raw: unknown[] | null = Array.isArray(req.body?.jobs) ? req.body.jobs : null;
  if (!raw || raw.length > 20000) return null;
  return raw
    .map((item) => {
      const j = asObj(item);
      return {
        jobId: String(j.jobId ?? '').trim(),
        itemCode: String(j.itemCode ?? '').trim(),
        quantity: Number(j.quantity) || 0,
        start: (j.start ?? null) as string | null,
        end: (j.end ?? null) as string | null,
        dueDate: (j.dueDate ?? null) as string | null,
      };
    })
    .filter((j) => j.jobId);
}

router.post('/projection', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) return res.status(503).json({ error: 'Database not connected', components: [] });
  const jobs = planJobsFrom(req);
  if (!jobs) return res.status(400).json({ error: 'jobs must be an array (max 20000)' });
  try {
    const components = await (await sysproServiceFor(req, db)).getInventoryProjection(jobs);
    return res.json({
      generatedAt: new Date().toISOString(),
      count: components.length,
      shortCount: components.filter((c) => c.status === 'short').length,
      components,
    });
  } catch (err) {
    req.log.error({ err }, 'Inventory projection failed');
    return res.status(500).json({ error: errorMessage(err), components: [] });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/inventory/fmad
// First material availability date per job (grid FMAD column). Body as
// /projection (jobs with planned start / due date set the claim order).
// ─────────────────────────────────────────────────────────────
router.post('/fmad', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) return res.status(503).json({ error: 'Database not connected', jobs: {} });
  const jobs = planJobsFrom(req);
  if (!jobs) return res.status(400).json({ error: 'jobs must be an array (max 20000)' });
  try {
    const result = await (await sysproServiceFor(req, db)).getFirstMaterialAvailability(jobs);
    return res.json({ generatedAt: new Date().toISOString(), jobs: result });
  } catch (err) {
    req.log.error({ err }, 'FMAD failed');
    return res.status(500).json({ error: errorMessage(err), jobs: {} });
  }
});

// ─────────────────────────────────────────────────────────────
// POST /api/inventory/pegging
// Open sales-order lines pegged to stock and planned jobs, with on-time /
// late / short status. Body as /projection.
// ─────────────────────────────────────────────────────────────
router.post('/pegging', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) return res.status(503).json({ error: 'Database not connected', lines: [], byJob: {} });
  const jobs = planJobsFrom(req);
  if (!jobs) return res.status(400).json({ error: 'jobs must be an array (max 20000)' });
  try {
    const result = await (await sysproServiceFor(req, db)).getSalesOrderPegging(jobs);
    const count = (s: string) => result.lines.filter((l) => l.status === s).length;
    return res.json({
      generatedAt: new Date().toISOString(),
      counts: { lines: result.lines.length, onTime: count('on-time'), late: count('late'), pastDue: count('past-due'), short: count('short'), unscheduled: count('unscheduled') },
      ...result,
    });
  } catch (err) {
    req.log.error({ err }, 'Sales-order pegging failed');
    return res.status(500).json({ error: errorMessage(err), lines: [], byJob: {} });
  }
});

// ─────────────────────────────────────────────────────────────
// GET /api/inventory/warehouses
// Returns distinct warehouses available.
// ─────────────────────────────────────────────────────────────
router.get('/warehouses', async (req: Request, res: Response) => {
  const db = getDb(req);
  if (!db) {
    return res.status(503).json({ error: 'Database not connected', items: [] });
  }
  try {
    const result = await db.query(
      `SELECT DISTINCT Warehouse, Description FROM InvSite ORDER BY Warehouse`
    );
    return res.json({ items: result.recordset });
  } catch (err) {
    // InvSite may not exist in all Syspro editions
    try {
      const result2 = await db.query(
        `SELECT DISTINCT Warehouse FROM InvWarehouse ORDER BY Warehouse`
      );
      return res.json({ items: result2.recordset.map((r) => ({ Warehouse: r.Warehouse, Description: r.Warehouse })) });
    } catch (err2) {
      return res.status(500).json({ error: errorMessage(err2), items: [] });
    }
  }
});

export default router;
