/**
 * Zod schemas for user management endpoints.
 */

import { z } from 'zod';

const roleSchema = z.enum(['super_admin', 'company_admin', 'planner', 'viewer']).optional();

export const createUserSchema = z.object({
  username: z.string().min(1, 'username is required').max(100),
  email: z.string().email('valid email is required'),
  password: z.string().min(8, 'password must be at least 8 characters'),
  role: roleSchema,
  fullName: z.string().max(200).optional(),
  companyId: z.number().int().positive().optional(),
});

export const updateUserSchema = z.object({
  username: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).optional(),
  role: roleSchema,
  fullName: z.string().max(200).optional(),
  isActive: z.boolean().optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'currentPassword is required'),
  newPassword: z.string().min(8, 'newPassword must be at least 8 characters'),
});
