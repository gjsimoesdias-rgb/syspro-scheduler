/**
 * Validation utilities
 */

export class Validators {
  /**
   * Validate job has valid operations
   */
  static validateJob(job: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!job.jobId) errors.push('jobId is required');
    if (!job.dueDate) errors.push('dueDate is required');
    if (job.quantity <= 0) errors.push('quantity must be greater than 0');
    if (!job.operations || job.operations.length === 0) {
      errors.push('job must have at least one operation');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate operation
   */
  static validateOperation(operation: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!operation.opId) errors.push('opId is required');
    if (!operation.workcentreId) errors.push('workcentreId is required');
    if (operation.duration <= 0) errors.push('duration must be greater than 0');

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Validate date range
   */
  static validateDateRange(
    startDate: Date,
    endDate: Date
  ): { valid: boolean; error?: string } {
    if (startDate >= endDate) {
      return {
        valid: false,
        error: 'startDate must be before endDate'
      };
    }

    // Check max horizon (e.g., 365 days)
    const maxDays = 365;
    const days = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);

    if (days > maxDays) {
      return {
        valid: false,
        error: `Planning horizon cannot exceed ${maxDays} days`
      };
    }

    return { valid: true };
  }

  /**
   * Validate resource availability
   */
  static validateResourceAvailability(
    resource: any
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!resource.resourceId) errors.push('resourceId is required');
    if (!resource.worcentreId) errors.push('worcentreId is required');
    if (resource.costPerHour < 0) errors.push('costPerHour cannot be negative');

    return {
      valid: errors.length === 0,
      errors
    };
  }
}

export default Validators;
