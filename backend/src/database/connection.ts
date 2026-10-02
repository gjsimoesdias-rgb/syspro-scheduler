/**
 * Database connection management for MSSQL
 */

import sql, { ConnectionPool, Transaction, config as SQLConfig } from 'mssql';
import util from 'util';
import { logger } from '../utils/logger';

/**
 * One row of a SQL result. Column sets differ between SYSPRO versions and
 * installs (many queries probe columns at run time), so values are untyped
 * here — the one deliberate `any` of the data layer. Convert at the edge
 * (String(row.Job).trim(), Number(row.Qty) || 0) when mapping to app types,
 * or pass a row type: db.query<{ n: number }>(...).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbRow = Record<string, any>;

/** SQL parameter values (bound with mssql's type inference). */
export type DbParams = Record<string, unknown>;

/** What every query returns (a subset of mssql's IResult). */
export interface DbResult<T = DbRow> {
  recordset: T[];
  recordsets?: T[][];
  rowsAffected?: number[];
  output?: Record<string, unknown>;
}

/**
 * A minimal executor interface that both DatabaseConnection and a
 * transaction-bound context implement. Use this when a function needs to
 * work either inside a transaction or stand-alone.
 */
export interface DbExecutor {
  query<T = DbRow>(sql: string): Promise<DbResult<T>>;
  queryWithParams<T = DbRow>(sql: string, params: DbParams): Promise<DbResult<T>>;
  execute<T = DbRow>(procedure: string, params?: DbParams): Promise<DbResult<T>>;
}

/**
 * Connection settings: mssql's config, plus the Windows-auth form used with
 * the native msnodesqlv8 driver (a full ODBC connectionString, no server).
 */
export type DbConnectionConfig = Omit<SQLConfig, 'server'> & { server?: string; connectionString?: string };

/** Bind parameters onto an mssql request. */
const bind = (request: sql.Request, params: DbParams): sql.Request => {
  for (const [key, value] of Object.entries(params)) request.input(key, value);
  return request;
};

export class DatabaseConnection implements DbExecutor {
  private pool: ConnectionPool | null = null;
  readonly config: DbConnectionConfig;

  constructor(connectionConfig: DbConnectionConfig) {
    this.config = connectionConfig;
  }

  private getSqlModule(): typeof sql {
    if (this.config.driver === 'msnodesqlv8') {
      // Lazy require: importing mssql/msnodesqlv8 mutates the shared global
      // driver registry, overwriting the tedious Request class for all pools.
      // Only load it when the connection actually needs the native driver.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('mssql/msnodesqlv8') as typeof sql;
    }
    return sql;
  }

  async connect(): Promise<void> {
    try {
      const sqlModule = this.getSqlModule();
      // msnodesqlv8 accepts connectionString in place of server/auth.
      const pool = new sqlModule.ConnectionPool(this.config as SQLConfig);
      this.pool = pool;
      await pool.connect();
      logger.info('Database connected');
    } catch (error) {
      logger.error({ err: error, details: util.inspect(error, { depth: 5, colors: false }) }, 'Database connection failed');
      if ((error as { code?: string })?.code === 'ESOCKET') {
        logger.error('Hint: Verify SQL TCP/IP is enabled for the given instance or port.');
        logger.error('Hint: Verify SQL Browser is running for named instance resolution.');
      }
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
      logger.info('Database disconnected');
    }
  }

  getPool(): ConnectionPool {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    return this.pool;
  }

  async query<T = DbRow>(sqlQueries: string): Promise<DbResult<T>> {
    return this.getPool().request().query<T>(sqlQueries);
  }

  async queryWithParams<T = DbRow>(sqlText: string, params: DbParams): Promise<DbResult<T>> {
    return bind(this.getPool().request(), params).query<T>(sqlText);
  }

  async execute<T = DbRow>(procedure: string, params: DbParams = {}): Promise<DbResult<T>> {
    return bind(this.getPool().request(), params).execute<T>(procedure);
  }

  /**
   * Run a callback inside a single transaction. Commits on success,
   * rolls back (and re-throws) on any error. Use this when multiple
   * writes must be atomic — e.g. SYSPRO write-back.
   */
  async withTransaction<T>(callback: (tx: DbExecutor) => Promise<T>): Promise<T> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }

    const transaction = new (this.getSqlModule()).Transaction(this.pool);
    await transaction.begin();

    const txExecutor: DbExecutor = {
      query: <R = DbRow>(sqlText: string) => transaction.request().query<R>(sqlText),
      queryWithParams: <R = DbRow>(sqlText: string, params: DbParams) =>
        bind(transaction.request(), params).query<R>(sqlText),
      execute: <R = DbRow>(procedure: string, params: DbParams = {}) =>
        bind(transaction.request(), params).execute<R>(procedure),
    };

    try {
      const result = await callback(txExecutor);
      await transaction.commit();
      return result;
    } catch (error) {
      try {
        await transaction.rollback();
      } catch (rollbackError) {
        logger.error({ err: rollbackError }, 'Transaction rollback failed');
      }
      throw error;
    }
  }
}

export { Transaction };
export default DatabaseConnection;
