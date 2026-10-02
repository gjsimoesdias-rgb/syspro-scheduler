/**
 * Helpers shared by the schedule, CTP and changeover routers.
 */
import { applyCalendarExceptions } from '../../utils/calendarExceptions';
import type { CalendarException, CalendarLike } from '../../utils/calendarExceptions';
import type { AppLike } from '../../types/appLocals';

/** Resource calendars from their assigned shift template, plus calendar exceptions. */
/** A shift template (Resources > Shifts) as stored in app state. */
interface ShiftTemplate {
  shiftId: string;
  name: string;
  workingDays?: number[];
  hoursPerDay?: number;
  startTime?: string;
  endTime?: string;
  diversions?: NonNullable<NonNullable<CalendarLike['shifts']>[number]['diversions']>;
}

type ResourceWithCalendar = { resourceId: string; worcentreId?: string; calendar?: CalendarLike | null };

export const applyAssignedShiftCalendars = <R extends ResourceWithCalendar>(app: AppLike, resources: R[]): R[] =>
  applyCalendarExceptions(applyShiftTemplates(app, resources), app.locals.calendarExceptions as CalendarException[] | undefined);

export const applyShiftTemplates = <R extends ResourceWithCalendar>(app: AppLike, resources: R[]): R[] => {
  const definitions = (app.locals.resourceDefinitions || {}) as Record<string, { shiftId?: string } | undefined>;
  const shifts = (app.locals.shiftTemplates || []) as ShiftTemplate[];
  const shiftById = new Map<string, ShiftTemplate>(shifts.map((shift) => [String(shift.shiftId), shift]));

  return resources.map((resource) => {
    const definition = definitions[resource.resourceId];
    const assignedShift = shiftById.get(String(definition?.shiftId || 'default'));
    if (!assignedShift) {
      return resource;
    }

    return {
      ...resource,
      calendar: {
        ...(resource.calendar || {}),
        calendarId: assignedShift.shiftId,
        name: `${assignedShift.name} Calendar`,
        workingDays: assignedShift.workingDays || [1, 2, 3, 4, 5],
        workingHoursPerDay: Number(assignedShift.hoursPerDay || 0),
        shifts: [
          {
            shiftId: assignedShift.shiftId,
            name: assignedShift.name,
            startTime: assignedShift.startTime || '00:00',
            endTime: assignedShift.endTime || '23:59',
            breakTime: 0,
            diversions: assignedShift.diversions || []
          }
        ],
        holidays: resource.calendar?.holidays || []
      }
    };
  });
};
