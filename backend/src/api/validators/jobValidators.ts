/**
 * Zod schemas for jobs API endpoints.
 */

import { z } from 'zod';

const importedJobSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
  description: z.string().optional(),
  dueDate: z.union([z.string(), z.date()]),
  quantity: z.number().positive(),
  priority: z.union([z.string(), z.number()]).optional(),
});

const importedOperationSchema = z.object({
  jobId: z.string().min(1, 'jobId is required'),
  opSequence: z.union([z.string(), z.number()]),
  workcentreId: z.string().min(1, 'workcentreId is required'),
  duration: z.number().positive('duration must be positive'),
  setupTime: z.number().min(0).optional(),
  movementTime: z.number().min(0).optional(),
});

export const bulkImportJobsSchema = z.object({
  jobs: z.array(importedJobSchema).min(1, 'At least one job is required'),
});

export const bulkImportOperationsSchema = z.object({
  operations: z.array(importedOperationSchema).min(1, 'At least one operation is required'),
});

export const materialPlanSchema = z.object({
  jobIds: z.array(z.string().min(1)).min(1, 'At least one jobId is required'),
});

export const updateScheduleSchema = z.object({
  plannedStartDate: z.string().min(1, 'plannedStartDate is required'),
  plannedEndDate: z.string().min(1, 'plannedEndDate is required'),
});
