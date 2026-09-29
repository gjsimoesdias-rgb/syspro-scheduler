/**
 * CSV/Excel import service
 */

import axios from 'axios';
import Papa from 'papaparse';

const apiClient = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3000/api'
});

export interface ImportJobData {
  jobId: string;
  description?: string;
  dueDate: string;
  quantity: string;
  priority?: string;
}

export interface ImportOperationData {
  jobId: string;
  opSequence: string;
  workcentreId: string;
  duration: string;
  setupTime?: string;
  movementTime?: string;
}

export class BulkImportService {
  /**
   * Parse CSV text and extract job/operation rows
   */
  static parseCSV(csvText: string): string[][] {
    const result = Papa.parse<string[]>(csvText, { skipEmptyLines: true });
    return result.data;
  }

  /**
   * Extract jobs from CSV rows
   */
  static extractJobs(rows: string[][]): ImportJobData[] {
    if (rows.length < 2) return [];

    const headerRow = rows[0];
    const jobs: ImportJobData[] = [];

    // Find column indices
    const jobIdIdx = headerRow.findIndex((h) => h.toLowerCase() === 'job id');
    const dueDateIdx = headerRow.findIndex((h) => h.toLowerCase() === 'due date');
    const qtyIdx = headerRow.findIndex((h) =>
      h.toLowerCase().includes('qty') || h.toLowerCase().includes('quantity')
    );
    const descIdx = headerRow.findIndex((h) => h.toLowerCase().includes('description'));
    const priorIdx = headerRow.findIndex((h) => h.toLowerCase().includes('priority'));

    if (jobIdIdx === -1 || dueDateIdx === -1 || qtyIdx === -1) {
      throw new Error('CSV must have Job ID, Due Date, and Quantity columns');
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length > Math.max(jobIdIdx, dueDateIdx, qtyIdx)) {
        jobs.push({
          jobId: row[jobIdIdx],
          dueDate: row[dueDateIdx],
          quantity: row[qtyIdx],
          description: descIdx >= 0 ? row[descIdx] : undefined,
          priority: priorIdx >= 0 ? row[priorIdx] : 'Normal'
        });
      }
    }

    return jobs;
  }

  /**
   * Extract operations from CSV rows
   */
  static extractOperations(rows: string[][]): ImportOperationData[] {
    if (rows.length < 2) return [];

    const headerRow = rows[0];
    const operations: ImportOperationData[] = [];

    const jobIdIdx = headerRow.findIndex((h) => h.toLowerCase() === 'job id');
    const opSeqIdx = headerRow.findIndex((h) =>
      h.toLowerCase().includes('sequence') || h.toLowerCase().includes('operation')
    );
    const wcIdx = headerRow.findIndex((h) => h.toLowerCase().includes('workcentre'));
    const durationIdx = headerRow.findIndex((h) => h.toLowerCase().includes('duration'));

    if (jobIdIdx === -1 || opSeqIdx === -1 || wcIdx === -1 || durationIdx === -1) {
      throw new Error('CSV must have Job ID, Operation, Workcentre, and Duration columns');
    }

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length > Math.max(jobIdIdx, opSeqIdx, wcIdx, durationIdx)) {
        operations.push({
          jobId: row[jobIdIdx],
          opSequence: row[opSeqIdx],
          workcentreId: row[wcIdx],
          duration: row[durationIdx],
          setupTime: headerRow.findIndex((h) => h.toLowerCase() === 'setup time') >= 0
            ? row[headerRow.findIndex((h) => h.toLowerCase() === 'setup time')]
            : undefined,
          movementTime: headerRow.findIndex((h) => h.toLowerCase() === 'movement time') >= 0
            ? row[headerRow.findIndex((h) => h.toLowerCase() === 'movement time')]
            : undefined
        });
      }
    }

    return operations;
  }

  /**
   * Upload jobs via API
   */
  static async importJobs(jobs: ImportJobData[]): Promise<any> {
    const payload = jobs.map((j) => ({
      jobId: j.jobId,
      description: j.description || '',
      dueDate: new Date(j.dueDate),
      quantity: parseInt(j.quantity, 10),
      priority: j.priority || 'Normal'
    }));

    return apiClient.post('/jobs/bulk-import', { jobs: payload });
  }

  /**
   * Upload operations via API
   */
  static async importOperations(operations: ImportOperationData[]): Promise<any> {
    const payload = operations.map((o) => ({
      jobId: o.jobId,
      opSequence: o.opSequence,
      workcentreId: o.workcentreId,
      duration: parseInt(o.duration, 10),
      setupTime: o.setupTime ? parseInt(o.setupTime, 10) : 0,
      movementTime: o.movementTime ? parseInt(o.movementTime, 10) : 0
    }));

    return apiClient.post('/jobs/operations/bulk-import', { operations: payload });
  }

  /**
   * Helper: Process file upload
   */
  static async processFile(file: File, importType: 'jobs' | 'operations'): Promise<any> {
    const text = await file.text();
    const rows = this.parseCSV(text);

    if (importType === 'jobs') {
      const jobs = this.extractJobs(rows);
      return this.importJobs(jobs);
    } else {
      const operations = this.extractOperations(rows);
      return this.importOperations(operations);
    }
  }
}

export default BulkImportService;
