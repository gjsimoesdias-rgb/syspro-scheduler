/**
 * Helpers shared by the schedule, CTP and changeover routers.
 */
import { applyCalendarExceptions } from '../../utils/calendarExceptions';

/** Resource calendars from their assigned shift template, plus calendar exceptions. */
export const applyAssignedShiftCalendars = (app: any, resources: any[]) =>
  applyCalendarExceptions(applyShiftTemplates(app, resources), app.locals.calendarExceptions);

export const applyShiftTemplates = (app: any, resources: any[]) => {
  const definitions = app.locals.resourceDefinitions || {};
  const shifts = app.locals.shiftTemplates || [];
  const shiftById = new Map<string, any>(shifts.map((shift: any) => [String(shift.shiftId), shift]));

  return resources.map((resource: any) => {
    const definition = definitions[resource.resourceId];
    const assignedShift: any = shiftById.get(String(definition?.shiftId || 'default'));
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
