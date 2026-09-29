/**
 * BomTreeService — read-only, multi-level Structure & Routings explorer.
 *
 * Builds the full BOM tree for a stock code straight from SYSPRO:
 *   - BomStructure  — parent column resolves at runtime (StockCode on standard
 *     SYSPRO 8; ParentPart on installs like this one), QtyPer guarded.
 *   - BomOperations — routing per node (first route), setup/run columns
 *     resolved defensively (SetUpTime/SetupTime, UnitRunTime/RunTime).
 *   - InvMaster     — descriptions, joined inside the structure query so the
 *     whole tree costs ~2 queries per node, not 3.
 *
 * Unlike the CTP explosion (which only follows made-in branches for
 * simulation), this explorer shows EVERY component — purchased leaf parts
 * included — because it is a browsing view, not a capacity model.
 * All table references live inside dynamic SQL guarded by OBJECT_ID /
 * COL_LENGTH, matching the codebase's defensive pattern for SYSPRO variance.
 */

export interface BomRoutingOp {
  operation: string;
  workcentreId: string;
  setupMinutes: number;
  unitRunMinutes: number;
}

export interface BomTreeNode {
  stockCode: string;
  description: string;
  /** Quantity per ONE unit of the direct parent. Root = 1. */
  qtyPer: number;
  /** 0 = the requested root. */
  level: number;
  hasRouting: boolean;
  operations: BomRoutingOp[];
  children: BomTreeNode[];
  /** True when depth/node caps stopped expansion below this node. */
  truncated?: boolean;
}

export interface BomTreeResult {
  root: BomTreeNode;
  nodeCount: number;
  warnings: string[];
}

const MAX_DEPTH = 10;
const MAX_NODES = 500;

const STRUCTURE_SQL = `
  IF OBJECT_ID('BomStructure', 'U') IS NULL
    SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer,
                 CAST('' AS nvarchar(100)) AS description, CAST(0 AS int) AS hasRouting;
  ELSE
  BEGIN
    DECLARE @parentCol NVARCHAR(30) = CASE
      WHEN COL_LENGTH('BomStructure', 'ParentPart') IS NOT NULL THEN N'ParentPart'
      WHEN COL_LENGTH('BomStructure', 'StockCode') IS NOT NULL THEN N'StockCode'
      ELSE NULL END;
    IF @parentCol IS NULL
      SELECT TOP 0 CAST('' AS nvarchar(50)) AS component, CAST(1 AS float) AS qtyPer,
                   CAST('' AS nvarchar(100)) AS description, CAST(0 AS int) AS hasRouting;
    ELSE
    BEGIN
      DECLARE @qtyExpr NVARCHAR(60) = CASE
        WHEN COL_LENGTH('BomStructure', 'QtyPer') IS NOT NULL THEN N'ISNULL(bs.QtyPer, 1)'
        ELSE N'CAST(1 AS float)' END;
      DECLARE @descExpr NVARCHAR(120) = CASE
        WHEN OBJECT_ID('InvMaster', 'U') IS NOT NULL AND COL_LENGTH('InvMaster', 'Description') IS NOT NULL
          THEN N'ISNULL(im.Description, '''')'
        ELSE N'CAST('''' AS nvarchar(100))' END;
      DECLARE @joinExpr NVARCHAR(200) = CASE
        WHEN OBJECT_ID('InvMaster', 'U') IS NOT NULL
          THEN N'LEFT JOIN InvMaster im ON im.StockCode = bs.Component'
        ELSE N'' END;
      DECLARE @routingExpr NVARCHAR(300) = CASE
        WHEN OBJECT_ID('BomOperations', 'U') IS NOT NULL
          THEN N'CASE WHEN EXISTS (SELECT 1 FROM BomOperations bo WHERE bo.StockCode = bs.Component) THEN 1 ELSE 0 END'
        ELSE N'CAST(0 AS int)' END;
      DECLARE @sql NVARCHAR(MAX) = N'
        SELECT DISTINCT bs.Component AS component, ' + @qtyExpr + N' AS qtyPer,
               ' + @descExpr + N' AS description, ' + @routingExpr + N' AS hasRouting
        FROM BomStructure bs ' + @joinExpr + N'
        WHERE bs.' + @parentCol + N' = @sc
        ORDER BY bs.Component';
      EXEC sp_executesql @sql, N'@sc NVARCHAR(50)', @sc = @sc;
    END
  END`;

const ROUTING_SQL = `
  IF OBJECT_ID('BomOperations', 'U') IS NULL
    SELECT TOP 0 CAST('' AS nvarchar(50)) AS operation, CAST('' AS nvarchar(50)) AS workcentreId,
                 CAST(0 AS float) AS setupHours, CAST(0 AS float) AS unitRunHours;
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
    EXEC sp_executesql @sql, N'@sc NVARCHAR(50)', @sc = @sc;
  END`;

const ROOT_DESC_SQL = `
  IF OBJECT_ID('InvMaster', 'U') IS NOT NULL AND COL_LENGTH('InvMaster', 'Description') IS NOT NULL
    EXEC sp_executesql
      N'SELECT ISNULL(Description, '''') AS description FROM InvMaster WHERE StockCode = @sc',
      N'@sc NVARCHAR(50)', @sc = @sc;
  ELSE
    SELECT TOP 0 CAST('' AS nvarchar(100)) AS description;`;

export async function buildBomTree(sysproDb: any, stockCode: string): Promise<BomTreeResult> {
  const warnings: string[] = [];
  let nodeCount = 0;

  const getOps = async (code: string): Promise<BomRoutingOp[]> => {
    const r = await sysproDb.queryWithParams(ROUTING_SQL, { sc: code });
    return (r.recordset || []).map((row: any) => ({
      operation: String(row.operation ?? '').trim(),
      workcentreId: String(row.workcentreId ?? '').trim(),
      setupMinutes: Math.round((Number(row.setupHours) || 0) * 60),
      unitRunMinutes: Math.round((Number(row.unitRunHours) || 0) * 60),
    })).filter((op: BomRoutingOp) => op.workcentreId);
  };

  const getChildren = async (code: string) => {
    const r = await sysproDb.queryWithParams(STRUCTURE_SQL, { sc: code });
    return (r.recordset || []) as Array<{ component: string; qtyPer: number; description: string; hasRouting: number }>;
  };

  const build = async (
    code: string,
    description: string,
    qtyPer: number,
    level: number,
    ancestors: Set<string>
  ): Promise<BomTreeNode> => {
    nodeCount++;
    const operations = await getOps(code);
    const node: BomTreeNode = {
      stockCode: code,
      description,
      qtyPer,
      level,
      hasRouting: operations.length > 0,
      operations,
      children: [],
    };

    if (ancestors.has(code)) {
      warnings.push(`Circular structure reference at ${code} — not expanded further.`);
      node.truncated = true;
      return node;
    }
    if (level >= MAX_DEPTH) {
      const kids = await getChildren(code);
      if (kids.length) {
        warnings.push(`Structure deeper than ${MAX_DEPTH} levels under ${code} — deeper levels not shown.`);
        node.truncated = true;
      }
      return node;
    }
    if (nodeCount >= MAX_NODES) {
      node.truncated = true;
      return node;
    }

    ancestors.add(code);
    for (const child of await getChildren(code)) {
      if (nodeCount >= MAX_NODES) {
        node.truncated = true;
        break;
      }
      node.children.push(
        await build(
          String(child.component).trim(),
          String(child.description ?? '').trim(),
          Number(child.qtyPer) || 1,
          level + 1,
          ancestors
        )
      );
    }
    ancestors.delete(code);
    return node;
  };

  let rootDescription = '';
  try {
    const d = await sysproDb.queryWithParams(ROOT_DESC_SQL, { sc: stockCode });
    rootDescription = String(d.recordset?.[0]?.description ?? '').trim();
  } catch { /* cosmetic only */ }

  const root = await build(stockCode, rootDescription, 1, 0, new Set<string>());

  if (nodeCount >= MAX_NODES) {
    warnings.push(`Tree capped at ${MAX_NODES} components — some branches are truncated.`);
  }
  if (!root.hasRouting && root.children.length === 0) {
    warnings.push(`${stockCode} has no routing and no structure — nothing to explore.`);
  }

  return { root, nodeCount, warnings };
}
