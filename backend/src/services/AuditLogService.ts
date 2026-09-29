/**
 * AuditLogService — writes rows to sch_AuditLog and reads history.
 */
import { v4 as uuidv4 } from 'uuid';
import sql from 'mssql';

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
  constructor(private readonly pool: sql.ConnectionPool) {}

  async log(entry: AuditEntry): Promise<void> {
    const auditId = uuidv4();
    const beforeJson = entry.before !== undefined ? JSON.stringify(entry.before) : null;
    const afterJson  = entry.after  !== undefined ? JSON.stringify(entry.after)  : null;

    await this.pool
      .request()
      .input('auditId',    sql.UniqueIdentifier, auditId)
      .input('actorId',    sql.NVarChar(128),    entry.actorId)
      .input('action',     sql.NVarChar(64),     entry.action)
      .input('entityType', sql.NVarChar(64),     entry.entityType)
      .input('entityId',   sql.NVarChar(256),    entry.entityId)
      .input('before',     sql.NVarChar(sql.MAX), beforeJson)
      .input('after',      sql.NVarChar(sql.MAX), afterJson)
      .input('traceId',    sql.NVarChar(128),    entry.traceId ?? null)
      .query(`
        INSERT INTO sch_AuditLog (auditId, actorId, action, entityType, entityId, before, after, traceId)
        VALUES (@auditId, @actorId, @action, @entityType, @entityId, @before, @after, @traceId)
      `);
  }

  async getHistory(
    entityType?: string,
    entityId?: string,
    limit = 100
  ): Promise<AuditRow[]> {
    const req = this.pool.request().input('limit', sql.Int, limit);

    let where = '';
    if (entityType) {
      req.input('entityType', sql.NVarChar(64), entityType);
      where += ' AND entityType = @entityType';
    }
    if (entityId) {
      req.input('entityId', sql.NVarChar(256), entityId);
      where += ' AND entityId = @entityId';
    }

    const result = await req.query<AuditRow>(`
      SELECT TOP (@limit)
        CAST(auditId AS NVARCHAR(36)) AS auditId,
        actorId, action, entityType, entityId,
        before, after, traceId,
        CONVERT(NVARCHAR(30), ts, 127) AS ts
      FROM sch_AuditLog
      WHERE 1=1 ${where}
      ORDER BY ts DESC
    `);

    return result.recordset;
  }
}
