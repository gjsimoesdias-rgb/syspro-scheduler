/**
 * AuditLogService — writes rows to sch_AuditLog and reads history.
 */
import { v4 as uuidv4 } from 'uuid';
import type { DbExecutor } from '../database/connection';

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  traceId?: string;
}

export interface AuditRow extends AuditEntry {
  auditId: string;
  ts: string;
}

export class AuditLogService {
  /**
   * Takes the app's DatabaseConnection (app.locals.schedulerDb). It used to be
   * typed as a raw mssql pool and call pool.request(), which the wrapper does
   * not have — so every audit read and write failed ("Failed to retrieve audit log").
   */
  constructor(private readonly db: DbExecutor) {}

  async log(entry: AuditEntry): Promise<void> {
    const beforeJson = entry.before !== undefined ? JSON.stringify(entry.before) : null;
    const afterJson  = entry.after  !== undefined ? JSON.stringify(entry.after)  : null;
    await this.db.queryWithParams(
      `INSERT INTO sch_AuditLog (auditId, actorId, action, entityType, entityId, [before], [after], traceId)
       VALUES (@auditId, @actorId, @action, @entityType, @entityId, @before, @after, @traceId)`,
      {
        auditId: uuidv4(),
        actorId: String(entry.actorId).slice(0, 128),
        action: String(entry.action).slice(0, 64),
        entityType: String(entry.entityType).slice(0, 64),
        entityId: String(entry.entityId).slice(0, 256),
        before: beforeJson,
        after: afterJson,
        traceId: entry.traceId ?? null,
      }
    );
  }

  async getHistory(
    entityType?: string,
    entityId?: string,
    limit = 100
  ): Promise<AuditRow[]> {
    const params: Record<string, unknown> = { limit: Math.max(1, Math.min(1000, Math.floor(limit))) };
    let where = '';
    if (entityType) { params.entityType = entityType; where += ' AND entityType = @entityType'; }
    if (entityId) { params.entityId = entityId; where += ' AND entityId = @entityId'; }
    const result = await this.db.queryWithParams<AuditRow>(
      `SELECT TOP (@limit)
         CAST(auditId AS NVARCHAR(36)) AS auditId,
         actorId, action, entityType, entityId,
         [before], [after], traceId,
         CONVERT(NVARCHAR(30), ts, 127) AS ts
       FROM sch_AuditLog
       WHERE 1=1 ${where}
       ORDER BY ts DESC`,
      params
    );
    return result.recordset || [];
  }
}
