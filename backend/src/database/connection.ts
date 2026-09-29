/**
 * Database connection management for MSSQL
 */

import sql, { ConnectionPool, Transaction, config as SQLConfig } from 'mssql';
import util from 'util';
import { logger } from '../utils/logger';

/**
 * A minimal executor interface that both DatabaseConnection and a
 * transaction-bound context implement. Use this when a function needs to
 * work either inside a transaction or stand-alone.
 */
export interface DbExecutor {
  query(sql: string): Promise<any>;
  queryWithParams(sql: string, params: Record<string, any>): Promise<any>;
  execute(procedure: string, params?: Record<string, any>): Promise<any>;
}

export class DatabaseConnection implements DbExecutor {
  private pool: ConnectionPool | null = null;
  private config: SQLConfig;

  constructor(connectionConfig: SQLConfig) {
    this.config = connectionConfig;
  }

  private getSqlModule(): any {
    if ((this.config as any).driver === 'msnodesqlv8') {
      // Lazy require: importing mssql/msnodesqlv8 mutates the shared global
      // driver registry, overwriting the tedious Request class for all pools.
      // Only load it when the connection actually needs the native driver.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return require('mssql/msnodesqlv8');
    }
    return sql;
  }

  async connect(): Promise<void> {
    try {
      const sqlModule = this.getSqlModule();
      this.pool = new sqlModule.ConnectionPool(this.config);
      await this.pool.connect();
      logger.info('Database connected');
    } catch (error: any) {
      logger.error({ err: error, details: util.inspect(error, { depth: 5, colors: false }) }, 'Database connection failed');
      if (error.code === 'ESOCKET') {
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

  async query(sqlQueries: string): Promise<any> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    const request = this.pool.request();
    return request.query(sqlQueries);
  }

  async queryWithParams(sql: string, params: Record<string, any>): Promise<any> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    const request = this.pool.request();
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
    return request.query(sql);
  }

  async execute(procedure: string, params: Record<string, any> = {}): Promise<any> {
    if (!this.pool) {
      throw new Error('Database not connected');
    }
    const request = this.pool.request();
    for (const [key, value] of Object.entries(params)) {
      request.input(key, value);
    }
    return request.execute(procedure);
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
      query: (sqlText: string) => transaction.request().query(sqlText),
      queryWithParams: (sqlText: string, params: Record<string, any>) => {
        const request = transaction.request();
        for (const [key, value] of Object.entries(params)) {
          request.input(key, value);
        }
        return request.query(sqlText);
      },
      execute: (procedure: string, params: Record<string, any> = {}) => {
        const request = transaction.request();
        for (const [key, value] of Object.entries(params)) {
          request.input(key, value);
        }
        return request.execute(procedure);
      }
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
