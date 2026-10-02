/**
 * Core scheduling models/DTOs
 */

import { holidayKey, localDayKey } from '../utils/calendarExceptions';
import {
  Job,
  Operation,
  Workcentre,
  Resource,
  Material,
  Calendar,
  Shift,
  Holiday
} from '../types';

export class JobModel implements Job {
  [key: string]: unknown;

  constructor(
    public jobId: string,
    public itemCode: string,
    public description: string,
    public quantity: number,
    public dueDate: Date,
    public releaseDate: Date,
    public priority: number,
    public status: 'Released' | 'Firm' | 'Planned' | 'InProgress' | 'Complete' | 'OnHold',
    public operations: Operation[] = [],
    public estimatedMaterialCost: number = 0,
    public estimatedLaborCost: number = 0
  ) {}

  getTotalDuration(): number {
    return this.operations.reduce((acc, op) => acc + op.duration, 0);
  }

  getCriticalPath(): number {
    // Simplified: sum of all operations (no parallelization assumed)
    return this.getTotalDuration();
  }
}

export class OperationModel implements Operation {
  [key: string]: unknown;

  constructor(
    public opId: string,
    public jobId: string,
    public sequence: number,
    public workcentreId: string,
    public workcentreName: string,
    public duration: number,
    public setupTime: number,
    public queueTime: number,
    public moveTime: number,
    public batchSize: number,
    public qualifiedResourceIds: string[] = [],
    public status: 'NotStarted' | 'InProgress' | 'Complete' = 'NotStarted',
    public plannedStartDate?: Date,
    public plannedEndDate?: Date,
    public actualStartDate?: Date,
    public actualEndDate?: Date,
    public assignedResourceId?: string,
    public predecessorOpId?: string,
    public successorOpId?: string
  ) {}

  getTotalTime(): number {
    return this.setupTime + this.duration + this.queueTime + this.moveTime;
  }

  canRunInBatch(quantity: number): boolean {
    return quantity >= this.batchSize;
  }
}

export class WorkcentreModel implements Workcentre {
  constructor(
    public worcentreId: string,
    public name: string,
    public description: string,
    public capabilities: string[] = [],
    public shiftProfile: any = {},
    public calendar: Calendar,
    public costPerHour: number = 0,
    public maxOvertimePerDay: number = 3.0,
    public setupSequenceDependencies: any[] = []
  ) {}
}

export class ResourceModel implements Resource {
  constructor(
    public resourceId: string,
    public name: string,
    public type: 'Employee' | 'Machine',
    public worcentreId: string,
    public skillTags: string[] = [],
    public costPerHour: number = 0,
    public calendar: Calendar,
    public status: 'Available' | 'OnLeave' | 'Unavailable' = 'Available'
  ) {}

  hasSkill(requiredSkill: string): boolean {
    return this.skillTags.includes(requiredSkill);
  }

  isAvailable(_date: Date): boolean {
    return this.status === 'Available' && this.calendar != null;
  }
}

export class MaterialModel implements Material {
  constructor(
    public materialId: string,
    public code: string,
    public description: string,
    public unitOfMeasure: string,
    public stockQty: number,
    public reservedQty: number = 0,
    public leadTimeDays: number = 0,
    public minimumOrderQty: number = 1
  ) {}

  getAvailableQty(): number {
    return this.stockQty - this.reservedQty;
  }

  isAvailableForReservation(requiredQty: number): boolean {
    return this.getAvailableQty() >= requiredQty;
  }
}

export class CalendarModel implements Calendar {
  constructor(
    public calendarId: string,
    public name: string,
    public workingDays: number[] = [1, 2, 3, 4, 5], // Mon-Fri
    public workingHoursPerDay: number = 8,
    public shifts: Shift[] = [],
    public holidays: Holiday[] = []
  ) {}

  isWorkingDay(date: Date): boolean {
    const dayOfWeek = date.getDay();
    // Check if it's a holiday
    const isHoliday = this.holidays.some(
      (h) => holidayKey(h.date) === localDayKey(date) && !h.isWorking && !h.startTime
    );
    if (isHoliday) return false;
    return this.workingDays.includes(dayOfWeek);
  }

  getNextWorkingDay(date: Date): Date {
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);
    while (!this.isWorkingDay(nextDate)) {
      nextDate.setDate(nextDate.getDate() + 1);
    }
    return nextDate;
  }

  getWorkingHoursUntil(startDate: Date, endDate: Date): number {
    let hours = 0;
    const current = new Date(startDate);
    while (current < endDate) {
      if (this.isWorkingDay(current)) {
        hours += this.workingHoursPerDay;
      }
      current.setDate(current.getDate() + 1);
    }
    return hours;
  }
}
