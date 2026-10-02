/**
 * Changeover routes: setup matrix, product classes, class changeover, finished goods.
 * Mounted inside the schedule router (before /:scheduleId), so URLs are unchanged.
 */
import { Router, Request, Response } from 'express';
import { validate, setupMatrixRowSchema, setupMatrixBulkSchema, setupClassBulkSchema } from '../validators/scheduleValidators';
import { requireAuth, requirePlanner, AuthRequest } from '../middleware/requireAuth';
import { errorMessage } from '../../utils/errors';

const router = Router();

// ═══════════════ Setup matrix (sequence-dependent changeovers) ═══════════════
// NOTE: these static routes MUST be registered before GET /:scheduleId below,
// otherwise Express would treat "setup-matrix" as a scheduleId.

/**
 * GET /api/schedule/setup-matrix
 * List all changeover rows (workcentre, from item, to item, minutes).
 */
router.get('/setup-matrix', async (req: Request, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const result = await schedulerDb.query(
      `SELECT SetupId AS setupId, WorkcentreId AS workcentreId, FromItemCode AS fromItemCode,
              ToItemCode AS toItemCode, SetupMinutes AS setupMinutes, UpdatedAt AS updatedAt
       FROM dbo.sch_SetupMatrix
       ORDER BY WorkcentreId, FromItemCode, ToItemCode`
    );
    res.json({ rows: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading setup matrix');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * POST /api/schedule/setup-matrix
 * Upsert one changeover row (unique on workcentre + from + to).
 */
router.post('/setup-matrix', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupMatrixRowSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);

  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const { workcentreId, fromItemCode, toItemCode, setupMinutes } = validation.data;

    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_SetupMatrix AS target
       USING (SELECT @workcentreId AS WorkcentreId, @fromItemCode AS FromItemCode, @toItemCode AS ToItemCode) AS src
         ON target.WorkcentreId = src.WorkcentreId
        AND target.FromItemCode = src.FromItemCode
        AND target.ToItemCode = src.ToItemCode
       WHEN MATCHED THEN
         UPDATE SET SetupMinutes = @setupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN NOT MATCHED THEN
         INSERT (WorkcentreId, FromItemCode, ToItemCode, SetupMinutes)
         VALUES (@workcentreId, @fromItemCode, @toItemCode, @setupMinutes);`,
      { workcentreId, fromItemCode, toItemCode, setupMinutes }
    );

    req.log.info({ workcentreId, fromItemCode, toItemCode, setupMinutes }, 'Setup matrix row upserted');
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'Error upserting setup matrix row');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * DELETE /api/schedule/setup-matrix/:setupId
 */
router.delete('/setup-matrix/:setupId', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    await schedulerDb.queryWithParams(
      `DELETE FROM dbo.sch_SetupMatrix WHERE SetupId = @setupId`,
      { setupId: req.params.setupId }
    );
    res.json({ ok: true });
  } catch (error) {
    req.log.error({ err: error }, 'Error deleting setup matrix row');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * Expand the ProductClass-level changeover matrix into item->item setup times
 * for the items in this run, using each item's InvMaster.ProductClass. Lets the
 * (item-keyed) scheduler charge class-level changeovers with no engine change.
 */
export async function buildClassChangeoverSequences(
  schedulerDb: any,
  sysproDb: any,
  jobs: Array<{ itemCode?: string }>,
  log: any
): Promise<Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number }>> {
  if (!schedulerDb) return [];
  let classRows: Array<{ fromClass: string; toClass: string; setupMinutes: number }> = [];
  try {
    const r = await schedulerDb.query(
      `IF OBJECT_ID('dbo.sch_ClassChangeover', 'U') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS fromClass, CAST('' AS nvarchar(50)) AS toClass, CAST(0 AS int) AS setupMinutes;
       ELSE
         SELECT FromClass AS fromClass, ToClass AS toClass, SetupMinutes AS setupMinutes
         FROM dbo.sch_ClassChangeover WHERE SetupMinutes > 0`
    );
    classRows = r.recordset || [];
  } catch {
    return [];
  }
  if (classRows.length === 0) return [];
  const items = Array.from(
    new Set(jobs.map((j) => String(j.itemCode || '').toUpperCase().trim()).filter(Boolean))
  );
  if (items.length === 0 || !sysproDb) return [];
  const itemClass = new Map<string, string>();
  try {
    const r = await sysproDb.queryWithParams(
      `IF OBJECT_ID('InvMaster', 'U') IS NULL OR COL_LENGTH('InvMaster', 'ProductClass') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS StockCode, CAST('' AS nvarchar(50)) AS ProductClass;
       ELSE
         SELECT m.StockCode AS StockCode, ISNULL(m.ProductClass, '') AS ProductClass
         FROM InvMaster m
         JOIN OPENJSON(@items) WITH (code nvarchar(50) '$') j ON j.code = m.StockCode`,
      { items: JSON.stringify(items) }
    );
    for (const row of r.recordset || []) {
      itemClass.set(String(row.StockCode).toUpperCase(), String(row.ProductClass || '').toUpperCase().trim());
    }
  } catch {
    return [];
  }
  const cm = new Map<string, number>();
  for (const cr of classRows) {
    cm.set(`${String(cr.fromClass).toUpperCase().trim()}->${String(cr.toClass).toUpperCase().trim()}`, cr.setupMinutes);
  }
  const out: Array<{ fromItemCode: string; toItemCode: string; setupTimeMinutes: number }> = [];
  for (const a of items) {
    const ca = itemClass.get(a);
    if (!ca) continue;
    for (const b of items) {
      if (a === b) continue;
      const cb = itemClass.get(b);
      if (!cb) continue;
      const mins = cm.get(`${ca}->${cb}`);
      if (mins && mins > 0) out.push({ fromItemCode: a, toItemCode: b, setupTimeMinutes: mins });
    }
  }
  if (out.length && log) log.info({ pairs: out.length, classes: classRows.length }, 'Class-level changeovers expanded');
  return out;
}

/**
 * POST /api/schedule/setup-matrix/bulk
 * Upsert many changeover cells at once (Changeover Matrix grid save). A cell
 * with setupMinutes = 0 is deleted so the matrix stays sparse. Global rows use
 * WorkcentreId '*' (see setupMatrixRowSchema default).
 */
router.post('/setup-matrix/bulk', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupMatrixBulkSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const rows = validation.data.rows.map((r) => ({
      workcentreId: (r.workcentreId || '*').toUpperCase() === 'ALL' ? '*' : (r.workcentreId || '*'),
      fromItemCode: r.fromItemCode.trim().toUpperCase(),
      toItemCode: r.toItemCode.trim().toUpperCase(),
      setupMinutes: Math.round(r.setupMinutes),
    })).filter((r) => r.fromItemCode !== r.toItemCode);
    if (rows.length === 0) return res.json({ ok: true, applied: 0 });

    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_SetupMatrix AS target
       USING (
         SELECT WorkcentreId, FromItemCode, ToItemCode, SetupMinutes
         FROM OPENJSON(@rows) WITH (
           WorkcentreId nvarchar(50) '$.workcentreId',
           FromItemCode nvarchar(50) '$.fromItemCode',
           ToItemCode   nvarchar(50) '$.toItemCode',
           SetupMinutes int          '$.setupMinutes'
         )
       ) AS src
         ON target.WorkcentreId = src.WorkcentreId
        AND target.FromItemCode = src.FromItemCode
        AND target.ToItemCode  = src.ToItemCode
       WHEN MATCHED AND src.SetupMinutes > 0 THEN
         UPDATE SET SetupMinutes = src.SetupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN MATCHED AND src.SetupMinutes <= 0 THEN
         DELETE
       WHEN NOT MATCHED BY TARGET AND src.SetupMinutes > 0 THEN
         INSERT (WorkcentreId, FromItemCode, ToItemCode, SetupMinutes)
         VALUES (src.WorkcentreId, src.FromItemCode, src.ToItemCode, src.SetupMinutes);`,
      { rows: JSON.stringify(rows) }
    );
    req.log.info({ count: rows.length }, 'Setup matrix bulk-upserted');
    res.json({ ok: true, applied: rows.length });
  } catch (error) {
    req.log.error({ err: error }, 'Error bulk-saving setup matrix');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/finished-goods?q=
 * Finished (manufactured) goods from SYSPRO InvMaster for the Changeover Matrix
 * axes. Schema-defensive: filters PartCategory = 'M' (this install's finished-goods
 * discriminator) when that column exists, else returns all stock codes.
 * Optional ?q= narrows by code/description.
 */
router.get('/finished-goods', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const q = String(req.query.q || '').trim();
    const sql = `
      IF OBJECT_ID('InvMaster', 'U') IS NULL
        SELECT TOP 0 CAST('' AS varchar(50)) AS stockCode, CAST('' AS varchar(200)) AS description;
      ELSE
      BEGIN
        DECLARE @descExpr NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N'ISNULL(m.Description, '''')'
          ELSE N'CAST('''' AS nvarchar(200))' END;
        DECLARE @fgFilter NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'PartCategory') IS NOT NULL THEN N'm.PartCategory = ''M'''
          ELSE N'1 = 1' END;
        DECLARE @qFilter NVARCHAR(500) = CASE WHEN LEN(@q) > 0 THEN (CASE
          WHEN COL_LENGTH('InvMaster', 'Description') IS NOT NULL THEN N' AND (m.StockCode LIKE @q OR m.Description LIKE @q)'
          ELSE N' AND m.StockCode LIKE @q' END) ELSE N'' END;
        DECLARE @sql NVARCHAR(MAX) = N'
          SELECT TOP 10000 m.StockCode AS stockCode, ' + @descExpr + N' AS description
          FROM InvMaster m
          WHERE ' + @fgFilter + @qFilter + N'
          ORDER BY m.StockCode';
        EXEC sp_executesql @sql, N'@q NVARCHAR(200)', @q = @q;
      END`;
    const result = await sysproDb.queryWithParams(sql, { q: `%${q}%` });
    res.json({ items: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading finished goods');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/product-classes
 * Distinct SYSPRO product classes (InvMaster.ProductClass) among finished
 * (PartCategory='M') goods — the axes of the class-level Changeover Matrix.
 */
router.get('/product-classes', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) return res.status(503).json({ error: 'Database not connected' });
    const sql = `
      SET NOCOUNT ON;
      IF OBJECT_ID('InvMaster', 'U') IS NULL OR COL_LENGTH('InvMaster', 'ProductClass') IS NULL
        SELECT TOP 0 CAST('' AS nvarchar(50)) AS productClass, CAST(1 AS bit) AS filtered;
      ELSE
      BEGIN
        -- Finished-goods discriminator: on this SYSPRO install manufactured
        -- finished goods are identified by PartCategory = 'M' (verified 2026-09;
        -- NOT MakeBuyCode). Applied only when the column is present.
        DECLARE @fg NVARCHAR(200) = CASE
          WHEN COL_LENGTH('InvMaster', 'PartCategory') IS NOT NULL THEN N'm.PartCategory = ''M'''
          ELSE N'1 = 1' END;
        DECLARE @base NVARCHAR(300) = N' FROM InvMaster m WHERE LTRIM(RTRIM(ISNULL(m.ProductClass, ''''))) <> '''' ';
        CREATE TABLE #pc (productClass nvarchar(200), filtered bit);
        -- 1) Manufactured finished goods that carry a ProductClass.
        DECLARE @sql NVARCHAR(MAX) = N'SELECT DISTINCT LTRIM(RTRIM(m.ProductClass)), CAST(1 AS bit)' + @base + N'AND (' + @fg + N')';
        INSERT INTO #pc (productClass, filtered) EXEC sp_executesql @sql;
        -- 2) Fallback: if no manufactured item carries a ProductClass, surface every
        --    product class so the changeover matrix is still usable rather than empty.
        IF NOT EXISTS (SELECT 1 FROM #pc)
        BEGIN
          DECLARE @sql2 NVARCHAR(MAX) = N'SELECT DISTINCT LTRIM(RTRIM(m.ProductClass)), CAST(0 AS bit)' + @base;
          INSERT INTO #pc (productClass, filtered) EXEC sp_executesql @sql2;
        END
        SELECT productClass, filtered FROM #pc ORDER BY productClass;
        DROP TABLE #pc;
      END`;
    const result = await sysproDb.query(sql);
    const rows = (result.recordset || []) as Array<{ productClass: string; filtered: boolean }>;
    const usedFilter = rows.length === 0 || rows[0].filtered !== false;
    const body: { classes: string[]; warning?: string } = {
      classes: rows.map((r) => r.productClass),
    };
    if (!usedFilter) {
      body.warning =
        'No finished goods (PartCategory = M) carry a ProductClass, so all product ' +
        'classes are shown. Assign ProductClass to your finished goods in SYSPRO to ' +
        'refine the changeover axes.';
    }
    res.json(body);
  } catch (error) {
    req.log.error({ err: error }, 'Error loading product classes');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * GET /api/schedule/class-changeover — current ProductClass->ProductClass values.
 */
router.get('/class-changeover', async (req: Request, res: Response) => {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const result = await schedulerDb.query(
      `IF OBJECT_ID('dbo.sch_ClassChangeover', 'U') IS NULL
         SELECT TOP 0 CAST('' AS nvarchar(50)) AS fromClass, CAST('' AS nvarchar(50)) AS toClass, CAST(0 AS int) AS setupMinutes;
       ELSE
         SELECT FromClass AS fromClass, ToClass AS toClass, SetupMinutes AS setupMinutes
         FROM dbo.sch_ClassChangeover ORDER BY FromClass, ToClass`
    );
    res.json({ rows: result.recordset || [] });
  } catch (error) {
    req.log.error({ err: error }, 'Error loading class changeover matrix');
    res.status(500).json({ error: errorMessage(error) });
  }
});

/**
 * POST /api/schedule/class-changeover/bulk — upsert/delete class->class cells.
 * setupMinutes = 0 deletes the cell (sparse). Charged during scheduling by
 * expanding to item pairs via each item's ProductClass.
 */
router.post('/class-changeover/bulk', requireAuth, requirePlanner, async (req: AuthRequest, res: Response) => {
  const validation = validate(setupClassBulkSchema, req.body);
  if (!validation.ok) return res.status(400).json(validation.error);
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    if (!schedulerDb) return res.status(503).json({ error: 'Scheduler database not connected' });
    const rows = validation.data.rows.map((r) => ({
      fromClass: r.fromClass.trim().toUpperCase(),
      toClass: r.toClass.trim().toUpperCase(),
      setupMinutes: Math.round(r.setupMinutes),
    })).filter((r) => r.fromClass !== r.toClass);
    if (rows.length === 0) return res.json({ ok: true, applied: 0 });
    await schedulerDb.queryWithParams(
      `MERGE dbo.sch_ClassChangeover AS target
       USING (
         SELECT FromClass, ToClass, SetupMinutes
         FROM OPENJSON(@rows) WITH (
           FromClass    nvarchar(50) '$.fromClass',
           ToClass      nvarchar(50) '$.toClass',
           SetupMinutes int          '$.setupMinutes'
         )
       ) AS src
         ON target.FromClass = src.FromClass AND target.ToClass = src.ToClass
       WHEN MATCHED AND src.SetupMinutes > 0 THEN
         UPDATE SET SetupMinutes = src.SetupMinutes, UpdatedAt = SYSUTCDATETIME()
       WHEN MATCHED AND src.SetupMinutes <= 0 THEN
         DELETE
       WHEN NOT MATCHED BY TARGET AND src.SetupMinutes > 0 THEN
         INSERT (FromClass, ToClass, SetupMinutes)
         VALUES (src.FromClass, src.ToClass, src.SetupMinutes);`,
      { rows: JSON.stringify(rows) }
    );
    req.log.info({ count: rows.length }, 'Class changeover bulk-upserted');
    res.json({ ok: true, applied: rows.length });
  } catch (error) {
    req.log.error({ err: error }, 'Error bulk-saving class changeover');
    res.status(500).json({ error: errorMessage(error) });
  }
});

export default router;
