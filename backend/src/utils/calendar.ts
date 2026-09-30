/**
 * Calendar utility functions
 */

import { Calendar, Holiday } from '../types';
import { exceptionForDay, exceptionWindowMinutes, holidayKey } from './calendarExceptions';

export class CalendarUtils {
  /**
   * Check if date is a working day
   */
  static isWorkingDay(date: Date, calendar: Calendar): boolean {
    const dayOfWeek = date.getDay();

    const exception = exceptionForDay(calendar, date);
    if (exception) {
      const forced = exceptionWindowMinutes(exception);
      return forced === null || forced.length > 0;
    }
    return calendar.workingDays.includes(dayOfWeek);
  }

  /**
   * Get next working day
   */
  static getNextWorkingDay(date: Date, calendar: Calendar): Date {
    const nextDate = new Date(date);
    nextDate.setDate(nextDate.getDate() + 1);

    while (!this.isWorkingDay(nextDate, calendar)) {
      nextDate.setDate(nextDate.getDate() + 1);
    }

    return nextDate;
  }

  /**
   * Calculate working hours between two dates
   */
  static getWorkingHoursBetween(
    startDate: Date,
    endDate: Date,
    calendar: Calendar
  ): number {
    let hours = 0;
    const current = new Date(startDate);

    while (current <= endDate) {
      if (this.isWorkingDay(current, calendar)) {
        hours += calendar.workingHoursPerDay;
      }
      current.setDate(current.getDate() + 1);
    }

    return hours;
  }

  /**
   * Add working days to a date
   */
  static addWorkingDays(date: Date, days: number, calendar: Calendar): Date {
    let result = new Date(date);
    let count = 0;

    while (count < days) {
      result = this.getNextWorkingDay(result, calendar);
      count++;
    }

    return result;
  }

  /**
   * Get all holidays in date range
   */
  static getHolidaysInRange(
    startDate: Date,
    endDate: Date,
    calendar: Calendar
  ): Holiday[] {
    const from = holidayKey(startDate);
    const to = holidayKey(endDate);
    return calendar.holidays.filter((h) => {
      const key = holidayKey(h.date);
      return key >= from && key <= to && !h.isWorking;
    });
  }
}

export default CalendarUtils;
