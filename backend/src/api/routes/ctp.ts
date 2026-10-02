/**
 * Capable-to-promise and structure routes: CTP, stock search/routing, BOM tree.
 * Mounted inside the schedule router (before /:scheduleId), so URLs are unchanged.
 */
import { Router, Request, Response } from 'express';
import SysproDatabaseService from '../../services/SysproDatabaseService';
import { validate, ctpRequestSchema } from '../validators/scheduleValidators';
import { computeCtp } from '../../services/CtpService';
import { buildBomTree } from '../../services/BomTreeService';
import { applyAssignedShiftCalendars } from './scheduleShared';
import { planDbFor } from '../../services/planStore';
import { errorMessage } from '../../utils/errors';
import { parseStoredSchedule } from '../../services/ScheduleStore';

const router = Router();

// ═══════════════════ Capable-to-Promise (order promising) ════════════════════

/**
 * POST /api/schedule/ctp
 * Simulate inserting a prospective order's routing into the current committed
 * load and return the earliest promisable completion date. Read-only — the
 * live schedule is never modified.
 */
router.post('/ctp', async (req: Request, res: Response) => {
  const validation = validate(ctpRequestSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });

    // Resources (with assigned shift calendars, same as /generate).
    const sysproService = new SysproDatabaseService(sysproDb);
    const rawResources = await sysproService.getResources();
    const resources = applyAssignedShiftCalendars(req.app, rawResources as any);

    // Committed load = busy intervals from the latest saved schedule.
    const busyByResource = new Map<string, { start: number; end: number }[]>();
    try {
      const latest = await (await planDbFor(req.app)).query(
        `IF OBJECT_ID('aps.SavedSchedules', 'U') IS NULL SELECT TOP 0 CAST(NULL AS nvarchar(max)) AS ScheduleData; ELSE SELECT TOP 1 ScheduleData FROM aps.SavedSchedules WHERE IsLatest = 1 ORDER BY SavedAt DESC`
      );
      if (latest.recordset?.length) {
        const saved = parseStoredSchedule(latest.recordset[0].ScheduleData);
        for (const js of saved.jobSchedules || []) {
          for (const os of js.operationSchedules || []) {
            const start = new Date(os.plannedStartDate).getTime();
            const end = new Date(os.plannedEndDate).getTime();
            if (!os.resourceId || Number.isNaN(start) || Number.isNaN(end) || end <= start) continue;
            if (!busyByResource.has(os.resourceId)) busyByResource.set(os.resourceId, []);
            busyByResource.get(os.resourceId)!.push({ start, end });
          }
        }
      }
    } catch {
      // No saved schedule — computeCtp records the assumption.
    }

    const { operations, subJobs, desiredDueDate, earliestStart } = validation.data;
    const mapOps = (ops: Array<{ workcentreId: string; setupMinutes?: number; runMinutes: number; description?: string }>) =>
      ops.map((op) => ({
        workcentreId: op.workcentreId,
        setupMinutes: op.setupMinutes ?? 0,
        runMinutes: op.runMinutes,
        description: op.description,
      }));
    const result = computeCtp({
      operations: mapOps(operations),
      subRoutings: subJobs?.length
        ? subJobs.map((sj) => ({ label: sj.label, operations: mapOps(sj.operations) }))
        : undefined,
      resources: resources as any,
      busyByResource,
      earliestStart: earliestStart ? new Date(earliestStart) : new Date(),
      desiredDueDate: desiredDueDate ? new Date(desiredDueDate) : undefined,
    });

    req.log.info(
      { feasible: result.feasible, promiseDate: result.promiseDate, ops: operations.length },
      'CTP simulation complete'
    );
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'Error running CTP simulation');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/ctp/stock-search?q=
 * Search InvMaster stock codes for the Promise tab picker.
 */
router.get('/ctp/stock-search', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ items: [] });

    // Schema-defensive: SYSPRO installs vary. Guard InvMaster.Description and the
    // BomOperations table (hasRouting) so a missing column/table degrades instead
    // of throwing. Any genuinely unexpected SQL error still surfaces to the toast.
    const searchSql = `
      IF OBJECT_ID('InvMaster', 'U') IS NULL
        SELECT TOP 0 CAST('' AS varchar(50)) AS stockCode,
                     CAST('' AS varchar(200)) AS description,
                     CAST(0 AS int) AS hasRouting;
      ELSE
      BEGIN
        DECLARE @descExpr NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'ISNULL(m.Description, '''')'
          ELSE N'CAST('''' AS nvarchar(200))' END;
        DECLARE @routingExpr NVARCHAR(400) = CASE
          WHEN OBJECT_ID('BomOperations', 'U') IS NOT NULL
            THEN N'CASE WHEN EXISTS (SELECT 1 FROM BomOperations bo WHERE bo.StockCode = m.StockCode) THEN 1 ELSE 0 END'
          ELSE N'CAST(0 AS int)' END;
        DECLARE @whereExpr NVARCHAR(400) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'm.StockCode LIKE @q OR m.Description LIKE @q'
          ELSE N'm.StockCode LIKE @q' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT TOP 25 m.StockCode AS stockCode, ' + @descExpr + N' AS description,
                 ' + @routingExpr + N' AS hasRouting
          FROM InvMaster m
          WHERE ' + @whereExpr + N'
          ORDER BY ' + @routingExpr + N' DESC, m.StockCode';
        EXEC sp_executesql @sql, N'@q NVARCHAR(200)', @q = @q;
      END`;
    const result = await sysproDb.queryWithParams(searchSql, { q: `%${q}%` });
    res.json({ items: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error searching stock codes');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/ctp/stock-routing/:stockCode?quantity=n
 *
 * Build a CTP request skeleton from SYSPRO structures & routings — NOT from
 * open WIP jobs: the routing comes from BomOperations (first route) and each
 * made-in BomStructure component that has its own routing becomes a sub-job
 * leg (scaled by QtyPer × quantity). SYSPRO times are hours → minutes here.
 */
router.get('/ctp/stock-routing/:stockCode', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const stockCode = String(req.params.stockCode || '').trim();
    if (!stockCode) return res.status(400).json({ error: 'stockCode is required' });
    const quantity = Math.max(1, Number(req.query.quantity) || 1);
    const warnings: string[] = [];

    // Column names vary across SYSPRO versions — resolve them defensively,
    // matching the COL_LENGTH pattern used elsewhere in this codebase.
    const routingSql = `
      IF OBJECT_ID('BomOperations', 'U') IS NULL
        SELECT TOP 0 CAST('' AS nvarchar(50)) AS operation,
                     CAST('' AS nvarchar(50)) AS workcentreId,
                     CAST(0 AS float) AS setupHours,
                     CAST(0 AS float) AS unitRunHours;
      ELSE
      BEGIN
        DECLARE @setupExpr NVARCHAR(100) = CASE
          WHEN COL_LENGTH('BomOperations', 'SetUpTime') IS NOT NULL THEN N'ISNULL(bo.SetUpTime, 0)'
          WHEN COL_LENGTH('BomOperations', 'SetupTime') IS NOT NULL THEN N'ISNULL(bo.SetupTime, 0)'
          ELSE N'CAST(0 AS float)' END;
        DECLARE @runExpr NVARCHAR(100) = CASE
          WHEN COL_LENGTH('BomOperations', 'UnitRunTime') IS NOT NULL THEN N'ISNULL(bo.UnitRunTime, 0)'
          WHEN COL_LENGTH('BomOperations', 'RunTime') IS NOT NULL THEN N'ISNULL(bo.RunTime, 0)'
          ELSE N'CAST(0 AS float)' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT bo.Operation AS operation, bo.WorkCentre AS workcentreId,
                 ' + @setupExpr + N' AS setupHours,
                 ' + @runExpr + N' AS unitRunHours
          FROM BomOperations bo
          WHERE bo.StockCode = @sc
            AND bo.Route = (SELECT MIN(Route) FROM BomOperations WHERE StockCode = @sc)
          ORDER BY TRY_CAST(bo.Operation AS int), bo.Operation';
        EXEC sp_executesql @sql, N'@sc NVARCHAR(50)', @sc = @stockCode;
      END
    `;

    const buildOps = (rows: any[], qty: number) =>
      (rows || []).map((r: any) => ({
        workcentreId: String(r.workcentreId || '').trim(),
        setupMinutes: Math.round((Number(r.setupHours) || 0) * 60),
        runMinutes: Math.max(1, Math.round((Number(r.unitRunHours) || 0) * 60 * qty)),
        description: `Op ${String(r.operation ?? '').trim()}`,
      })).filter((op: any) => op.workcentreId);

    const routingResult = await sysproDb.queryWithParams(routingSql, { stockCode });
    const operations = buildOps(routingResult.recordset, quantity);
    if (operations.length === 0) {
      return res.status(404).json({ error: `No routing found in BomOperations for stock code ${stockCode}` });
    }

    // Made-in components — FULL multi-level BomStructure explosion.
    // SYSPRO 8 keys the parent as BomStructure.StockCode (child = Component);
    // some installs/older schemas use ParentPart. Resolve dynamically.
    //
    // Model: each DIRECT child of the quoted item becomes one CTP leg; deeper
    // made-in descendants are serialised INTO their branch's leg in build
    // order (children before parents). Branches run in parallel sharing
    // capacity; the master routing starts after the last branch — matching
    // CtpService's leg semantics. Within a branch this respects precedence
    // exactly for chains and is conservative (never optimistic) when a branch
    // itself has parallel children. Children are traversed even when they have
    // no routing of their own (phantoms), so deeper made-in levels are found.
    const subJobs: Array<{ label: string; operations: any[] }> = [];
    try {
      const structureSql = `
        IF OBJECT_ID('BomStructure', 'U') IS NULL
          SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer;
        ELSE
        BEGIN
          DECLARE @parentCol NVARCHAR(30) = CASE
            WHEN COL_LENGTH('BomStructure', 'ParentPart') IS NOT NULL THEN N'ParentPart'
            WHEN COL_LENGTH('BomStructure', 'StockCode') IS NOT NULL THEN N'StockCode'
            ELSE NULL END;
          IF @parentCol IS NULL
            SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer;
          ELSE
          BEGIN
            DECLARE @qtyExpr NVARCHAR(60) = CASE
              WHEN COL_LENGTH('BomStructure', 'QtyPer') IS NOT NULL THEN N'ISNULL(bs.QtyPer, 1)'
              ELSE N'CAST(1 AS float)' END;
            -- Keep components that are made-in (have a routing) OR are
            -- structural (have children of their own, e.g. phantoms) so the
            -- traversal can reach deeper made-in levels. Purchased leaf parts
            -- (no routing, no children) are excluded.
            DECLARE @sqlStr NVARCHAR(MAX) = N'
              SELECT DISTINCT bs.Component AS component, ' + @qtyExpr + N' AS qtyPer
              FROM BomStructure bs
              WHERE bs.' + @parentCol + N' = @sc
                AND (
                  EXISTS (SELECT 1 FROM BomOperations bo WHERE bo.StockCode = bs.Component)
                  OR EXISTS (SELECT 1 FROM BomStructure b2 WHERE b2.' + @parentCol + N' = bs.Component)
                )
              ORDER BY bs.Component';
            EXEC sp_executesql @sqlStr, N'@sc NVARCHAR(50)', @sc = @sc;
          END
        END`;

      const MAX_DEPTH = 10;
      const MAX_NODES = 200;
      let nodesVisited = 0;
      let multiLevel = false;

      const getChildren = async (parent: string): Promise<Array<{ component: string; qtyPer: number }>> => {
        const r = await sysproDb.queryWithParams(structureSql, { sc: parent });
        return (r.recordset || []) as Array<{ component: string; qtyPer: number }>;
      };

      /**
       * Post-order (build-order) explosion of one branch: descendants' ops are
       * appended before the node's own ops. Quantities compound down the chain
       * (QtyPer × parent qty). Cycle-safe via the ancestor set.
       */
      const explodeBranch = async (
        code: string,
        qty: number,
        depth: number,
        ancestors: Set<string>,
        acc: any[]
      ): Promise<void> => {
        if (depth > MAX_DEPTH) {
          warnings.push(`BOM deeper than ${MAX_DEPTH} levels under ${code} — deeper levels omitted.`);
          return;
        }
        if (ancestors.has(code)) {
          warnings.push(`Circular BOM reference at ${code} — branch skipped.`);
          return;
        }
        if (++nodesVisited > MAX_NODES) return;
        ancestors.add(code);
        for (const child of await getChildren(code)) {
          const childCode = String(child.component).trim();
          const childQty = Math.max(1, Math.ceil((Number(child.qtyPer) || 1) * qty));
          await explodeBranch(childCode, childQty, depth + 1, ancestors, acc);
        }
        const routing = await sysproDb.queryWithParams(routingSql, { stockCode: code });
        const ownOps = buildOps(routing.recordset, qty).map((op: any) => ({
          ...op,
          description: `${code} · ${op.description}`,
        }));
        if (ownOps.length && depth > 1) multiLevel = true;
        acc.push(...ownOps);
        ancestors.delete(code);
      };

      for (const comp of await getChildren(stockCode)) {
        if (subJobs.length >= 20) {
          warnings.push('More than 20 made-in sub-assembly branches — extra branches omitted.');
          break;
        }
        const compCode = String(comp.component).trim();
        const compQty = Math.max(1, Math.ceil((Number(comp.qtyPer) || 1) * quantity));
        const branchOps: any[] = [];
        await explodeBranch(compCode, compQty, 1, new Set([stockCode]), branchOps);
        if (branchOps.length > 50) {
          warnings.push(`${compCode}: branch has ${branchOps.length} operations — trimmed to 50 for simulation.`);
          branchOps.length = 50;
        }
        if (branchOps.length) subJobs.push({ label: compCode, operations: branchOps });
      }
      if (nodesVisited > MAX_NODES) {
        warnings.push(`BOM explosion stopped after ${MAX_NODES} components — quote may be incomplete.`);
      }
      if (multiLevel) {
        warnings.push(
          'Multi-level BOM: within each branch, deeper sub-assemblies are built before their parents (serialised); branches run in parallel sharing capacity.'
        );
      }
    } catch (structErr) {
      warnings.push(
        `BomStructure read failed — made-in components were not expanded into sub-legs (${errorMessage(structErr, 'unknown error')}).`
      );
    }

    // Description for display.
    let description = '';
    try {
      const dm = await sysproDb.queryWithParams(
        `SELECT Description FROM InvMaster WHERE StockCode = @sc`, { sc: stockCode }
      );
      description = dm.recordset?.[0]?.Description || '';
    } catch { /* cosmetic only */ }

    warnings.push('Unit run times scaled linearly by quantity (setup charged once per operation).');
    res.json({ stockCode, description, quantity, operations, subJobs, warnings });
  } catch (error) {
    req.log.error({ err: error }, 'Error building routing from stock code');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/bom-tree/:stockCode
 * Read-only Structure & Routings explorer — full multi-level BOM tree with
 * per-node routing operations, straight from BomStructure/BomOperations.
 * Registered BEFORE GET /:scheduleId so the static prefix isn't shadowed.
 */
router.get('/bom-tree/:stockCode', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const stockCode = String(req.params.stockCode || '').trim();
    if (!stockCode) return res.status(400).json({ error: 'stockCode is required' });
    const result = await buildBomTree(sysproDb, stockCode);
    res.json(result);
  } catch (error) {
    req.log.error({ err: error }, 'Error building BOM tree');
    res.status(500).json({ error: errorMessage(error) });
  }
});

export default router;
