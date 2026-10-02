/**
 * Zod schemas for database connection / status endpoints.
 */

import { z } from 'zod';

const connectionPayloadBase = z.object({
  server: z.string().min(1, 'server is required'),
  instanceName: z.string().optional(),
  port: z.number().int().positive().optional(),
  authMode: z.enum(['sql', 'windows']).optional(),
  userName: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const listDatabasesSchema = connectionPayloadBase;

export const connectSchema = connectionPayloadBase.extend({
  database: z.string().min(1, 'database is required'),
  schedulerDatabase: z.string().optional(),
});

/** A connection request body (database is optional when listing databases). */
export type ConnectionPayload = z.infer<typeof connectionPayloadBase> & {
  database?: string;
  schedulerDatabase?: string;
};
