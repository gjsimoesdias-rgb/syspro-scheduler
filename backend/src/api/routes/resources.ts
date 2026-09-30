/**
 * Resources API routes
 */

import { Router, Request, Response } from 'express';
import SysproDatabaseService from '../../services/SysproDatabaseService';
import { setLocal } from '../../utils/setLocal';
import { requirePlanner } from '../middleware/requireAuth';
import { CalendarException, normaliseException } from '../../utils/calendarExceptions';

const router = Router();

type ShiftTemplate = {
  shiftId: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  hoursPerDay: number;
  diversions?: Array<{
    id: string;
    type: string;
    startTime: string;
    endTime: string;
    schedulable: boolean;
  }>;
};

type ResourceDefinition = {
  resourceId: string;
  machine: string;
  workcentreId: string;
  description: string;
  quantity: number;
  shiftId: string;
  activated: boolean;
  loadingResourcePct: number;
  /** Flow-line group identifier. Null/undefined = not part of a line. */
  lineGroupId?: string;
};

type AlternativeGroup = {
  groupId: string;
  workcentreId: string;
  name: string;
  machineIds: string[];
  notes?: string;
};

const DEFAULT_SHIFT_DIVERSIONS: ShiftTemplate['diversions'] = [
  { id: 'default-1', type: 'Non Productive', startTime: '00:00', endTime: '08:00', schedulable: false },
  { id: 'default-2', type: 'Production', startTime: '08:00', endTime: '16:00', schedulable: true },
  { id: 'default-3', type: 'Non Productive', startTime: '16:00', endTime: '23:59', schedulable: false }
];

const toMinutes = (value: string): number => {
  const trimmed = String(value || '').trim();
  if (trimmed === '24:00') return 1440;
  const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!match) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return Number.NaN;
  return hours * 60 + minutes;
};

const validateShiftDiversions = (input: any[]) => {
  if (!Array.isArray(input) || input.length === 0) {
    return { valid: false, error: 'A shift must contain diversions covering the full 24 hours' };
  }

  const diversions = input.map((item: any, index: number) => ({
    id: String(item.id || `div-${index + 1}`),
    type: String(item.type || 'Non Productive'),
    startTime: String(item.startTime || '').trim(),
    endTime: String(item.endTime || '').trim(),
    schedulable: item.schedulable === undefined ? /production|overtime/i.test(String(item.type || '')) : !!item.schedulable
  })).sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));

  let cursor = 0;
  let productiveMinutes = 0;

  for (const diversion of diversions) {
    const start = toMinutes(diversion.startTime);
    const end = toMinutes(diversion.endTime);

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return { valid: false, error: `Invalid diversion range: ${diversion.startTime} - ${diversion.endTime}` };
    }

    if (start !== cursor) {
      return { valid: false, error: 'Diversions must cover 24 hours with no gaps or overlaps, starting at 00:00' };
    }

    if (diversion.schedulable) {
      productiveMinutes += end - start;
    }

    cursor = end;
  }

  if (cursor < 1439) {
    return { valid: false, error: 'Diversions must continue until 23:59 or 24:00' };
  }

  return {
    valid: true,
    diversions,
    hoursPerDay: Math.round((productiveMinutes / 60) * 100) / 100,
    startTime: '00:00',
    endTime: cursor >= 1440 ? '24:00' : '23:59'
  };
};

const ensureDefinitionStores = (req: Request): { shifts: ShiftTemplate[]; definitions: Record<string, ResourceDefinition> } => {
  const appLocals = req.app.locals as any;
  if (!appLocals.shiftTemplates) {
    appLocals.shiftTemplates = [
      {
        shiftId: 'default',
        name: 'Default',
        startTime: '00:00',
        endTime: '23:59',
        workingDays: [1, 2, 3, 4, 5],
        hoursPerDay: 8,
        diversions: DEFAULT_SHIFT_DIVERSIONS
      }
    ];
  }
  if (!appLocals.resourceDefinitions) {
    appLocals.resourceDefinitions = {};
  }
  return {
    shifts: appLocals.shiftTemplates as ShiftTemplate[],
    definitions: appLocals.resourceDefinitions as Record<string, ResourceDefinition>
  };
};

const ensureAlternativeGroups = (req: Request): AlternativeGroup[] => {
  const appLocals = req.app.locals as any;
  if (!appLocals.alternativeGroups) {
    appLocals.alternativeGroups = [];
  }
  return appLocals.alternativeGroups as AlternativeGroup[];
};

const applyShiftCalendarsToResources = (req: Request, resources: any[]) => {
  const { shifts, definitions } = ensureDefinitionStores(req);
  const shiftById = new Map(shifts.map((shift) => [shift.shiftId, shift]));

  return resources.map((resource) => {
    const definition = definitions[resource.resourceId];
    const assignedShift = shiftById.get(definition?.shiftId || 'default');
    if (!assignedShift) {
      return resource;
    }

    return {
      ...resource,
      assignedShiftId: assignedShift.shiftId,
      assignedShiftName: assignedShift.name,
      // Propagate lineGroupId from the resource definition so the engine
      // can enforce flow-line constraints.
      lineGroupId: definition?.lineGroupId ?? resource.lineGroupId,
      calendar: {
        ...(resource.calendar || {}),
        calendarId: assignedShift.shiftId,
        name: `${assignedShift.name} Calendar`,
        workingDays: assignedShift.workingDays,
        workingHoursPerDay: assignedShift.hoursPerDay,
        shifts: [
          {
            shiftId: assignedShift.shiftId,
            name: assignedShift.name,
            startTime: assignedShift.startTime,
            endTime: assignedShift.endTime,
            breakTime: 0,
            diversions: assignedShift.diversions || []
          }
        ],
        holidays: resource.calendar?.holidays || []
      }
    };
  });
};

/**
 * GET /api/resources
 * Get all resources
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.json({
        count: 0,
        resources: [],
        warning: 'Database not connected - running in read-only mode'
      });
    }

    const sysproService = new SysproDatabaseService(sysproDb);
    const resources = await sysproService.getResources();
    const resolvedResources = applyShiftCalendarsToResources(req, resources);

    res.json({
      count: resolvedResources.length,
      resources: resolvedResources
    });
  } catch (error) {
    const message = (error as any).message || 'Failed to load resources';
    if (message.includes('Invalid object name')) {
      return res.json({
        count: 0,
        resources: [],
        warning: 'Database connected, but Syspro routing/resource tables were not found in this company database'
      });
    }
    res.status(500).json({ error: message });
  }
});

/**
 * GET /api/resources/definitions
 * Get editable resource definitions used by Resource Definition tab
 */
router.get('/definitions', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.json({
        count: 0,
        definitions: [],
        warning: 'Database not connected - running in read-only mode'
      });
    }

    const { shifts, definitions } = ensureDefinitionStores(req);
    const sysproService = new SysproDatabaseService(sysproDb);
    const resources = await sysproService.getResources();

    const items: ResourceDefinition[] = resources.map((resource) => {
      const existing = definitions[resource.resourceId];
      const definition: ResourceDefinition = existing || {
        resourceId: resource.resourceId,
        machine: resource.resourceId,
        workcentreId: resource.worcentreId,
        description: resource.name,
        quantity: 1,
        shiftId: 'default',
        activated: true,
        loadingResourcePct: 100
      };
      definitions[resource.resourceId] = definition;
      return definition;
    });

    res.json({
      count: items.length,
      shifts,
      definitions: items
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to load resource definitions' });
  }
});

/**
 * PUT /api/resources/definitions/:resourceId
 * Update resource quantity / assigned shift / activation
 */
router.put('/definitions/:resourceId', requirePlanner, async (req: Request, res: Response) => {
  try {
    const { resourceId } = req.params;
    const { shifts, definitions } = ensureDefinitionStores(req);
    const current = definitions[resourceId];
    if (!current) {
      return res.status(404).json({ error: `Resource definition not found: ${resourceId}` });
    }

    const nextQuantity = Number(req.body.quantity ?? current.quantity);
    if (!Number.isFinite(nextQuantity) || nextQuantity <= 0) {
      return res.status(400).json({ error: 'Quantity must be greater than zero' });
    }

    const nextShiftId = String(req.body.shiftId ?? current.shiftId);
    const shiftExists = shifts.some((s) => s.shiftId === nextShiftId);
    if (!shiftExists) {
      return res.status(400).json({ error: `Shift not found: ${nextShiftId}` });
    }

    const updated: ResourceDefinition = {
      ...current,
      quantity: nextQuantity,
      shiftId: nextShiftId,
      activated: req.body.activated === undefined ? current.activated : !!req.body.activated,
      loadingResourcePct:
        req.body.loadingResourcePct === undefined
          ? current.loadingResourcePct
          : Math.max(0, Math.min(100, Number(req.body.loadingResourcePct))),
      lineGroupId: req.body.lineGroupId === undefined
        ? current.lineGroupId
        : (String(req.body.lineGroupId).trim() || undefined),
    };

    definitions[resourceId] = updated;
    setLocal(req.app.locals, 'resourceDefinitions', definitions);
    res.json({ definition: updated });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to update resource definition' });
  }
});

/**
 * GET /api/resources/shifts
 * Get shift templates
 */
router.get('/shifts', (req: Request, res: Response) => {
  const { shifts } = ensureDefinitionStores(req);
  res.json({ count: shifts.length, shifts });
});

/**
 * POST /api/resources/shifts
 * Create a new shift template
 */
router.post('/shifts', requirePlanner, (req: Request, res: Response) => {
  try {
    const { shifts } = ensureDefinitionStores(req);
    const name = String(req.body.name || '').trim();
    const workingDays = Array.isArray(req.body.workingDays)
      ? req.body.workingDays.map((d: any) => Number(d)).filter((d: number) => d >= 0 && d <= 6)
      : [1, 2, 3, 4, 5];

    if (!name) {
      return res.status(400).json({ error: 'Shift name is required' });
    }

    if (shifts.some((shift) => shift.name.trim().toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: `A shift named "${name}" already exists` });
    }

    if (workingDays.length === 0) {
      return res.status(400).json({ error: 'At least one working day is required' });
    }

    const validation = validateShiftDiversions(req.body.diversions || []);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    const shiftId = `shift-${Date.now()}`;
    const newShift: ShiftTemplate = {
      shiftId,
      name,
      startTime: validation.startTime || '00:00',
      endTime: validation.endTime || '23:59',
      workingDays,
      hoursPerDay: validation.hoursPerDay || 0,
      diversions: validation.diversions
    };

    shifts.push(newShift);
    setLocal(req.app.locals, 'shiftTemplates', shifts);
    res.status(201).json({ shift: newShift });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to create shift' });
  }
});

router.put('/shifts/:shiftId', requirePlanner, (req: Request, res: Response) => {
  try {
    const { shiftId } = req.params;
    const { shifts } = ensureDefinitionStores(req);
    const existing = shifts.find((shift) => shift.shiftId === shiftId);

    if (!existing) {
      return res.status(404).json({ error: `Shift not found: ${shiftId}` });
    }

    const name = String(req.body.name || '').trim();
    const workingDays = Array.isArray(req.body.workingDays)
      ? req.body.workingDays.map((d: any) => Number(d)).filter((d: number) => d >= 0 && d <= 6)
      : existing.workingDays;

    if (!name) {
      return res.status(400).json({ error: 'Shift name is required' });
    }

    if (shifts.some((shift) => shift.shiftId !== shiftId && shift.name.trim().toLowerCase() === name.toLowerCase())) {
      return res.status(400).json({ error: `A shift named "${name}" already exists` });
    }

    if (workingDays.length === 0) {
      return res.status(400).json({ error: 'At least one working day is required' });
    }

    const validation = validateShiftDiversions(req.body.diversions || existing.diversions || []);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.error });
    }

    existing.name = name;
    existing.workingDays = workingDays;
    existing.startTime = validation.startTime || '00:00';
    existing.endTime = validation.endTime || '23:59';
    existing.hoursPerDay = validation.hoursPerDay || 0;
    existing.diversions = validation.diversions;
    setLocal(req.app.locals, 'shiftTemplates', shifts);
    res.json({ shift: existing });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to update shift' });
  }
});

router.delete('/shifts/:shiftId', requirePlanner, (req: Request, res: Response) => {
  try {
    const { shiftId } = req.params;
    const { shifts, definitions } = ensureDefinitionStores(req);

    if (shiftId === 'default') {
      return res.status(400).json({ error: 'The default shift cannot be deleted' });
    }

    const shiftIndex = shifts.findIndex((shift) => shift.shiftId === shiftId);
    if (shiftIndex < 0) {
      return res.json({
        deleted: true,
        alreadyMissing: true,
        reassignedResources: 0
      });
    }

    const [deletedShift] = shifts.splice(shiftIndex, 1);
    let reassignedResources = 0;

    Object.values(definitions).forEach((definition) => {
      if (definition.shiftId === shiftId) {
        definition.shiftId = 'default';
        reassignedResources += 1;
      }
    });

    setLocal(req.app.locals, 'shiftTemplates', shifts);
    if (reassignedResources > 0) setLocal(req.app.locals, 'resourceDefinitions', definitions);

    res.json({
      deleted: true,
      shift: deletedShift,
      reassignedResources
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to delete shift' });
  }
});

/**
 * Calendar exceptions — holidays, shutdowns, short days, extra working days.
 * GET    /api/resources/calendar-exceptions
 * POST   /api/resources/calendar-exceptions        { date, name, scope?, isWorking?, startTime?, endTime? }
 * PUT    /api/resources/calendar-exceptions/:id
 * DELETE /api/resources/calendar-exceptions/:id
 */
const getExceptions = (req: Request): CalendarException[] => {
  const locals = req.app.locals as any;
  if (!Array.isArray(locals.calendarExceptions)) locals.calendarExceptions = [];
  return locals.calendarExceptions as CalendarException[];
};
const sortExceptions = (list: CalendarException[]) =>
  list.sort((a, b) => a.date.localeCompare(b.date) || a.scope.localeCompare(b.scope));

router.get('/calendar-exceptions', (req: Request, res: Response) => {
  res.json({ exceptions: sortExceptions([...getExceptions(req)]) });
});

router.post('/calendar-exceptions', requirePlanner, (req: Request, res: Response) => {
  const result = normaliseException({ ...req.body, id: undefined });
  if (typeof result === 'string') return res.status(400).json({ error: result });
  const list = getExceptions(req);
  if (list.some((e) => e.date === result.date && e.scope === result.scope)) {
    return res.status(409).json({ error: `There is already an exception on ${result.date} for ${result.scope === 'plant' ? 'the whole plant' : result.scope}` });
  }
  list.push(result);
  setLocal(req.app.locals, 'calendarExceptions', sortExceptions(list));
  res.status(201).json({ exception: result });
});

router.put('/calendar-exceptions/:id', requirePlanner, (req: Request, res: Response) => {
  const list = getExceptions(req);
  const index = list.findIndex((e) => e.id === req.params.id);
  if (index < 0) return res.status(404).json({ error: 'Calendar exception not found' });
  const result = normaliseException({ ...req.body, id: req.params.id });
  if (typeof result === 'string') return res.status(400).json({ error: result });
  if (list.some((e, i) => i !== index && e.date === result.date && e.scope === result.scope)) {
    return res.status(409).json({ error: `There is already an exception on ${result.date} for that scope` });
  }
  list[index] = result;
  setLocal(req.app.locals, 'calendarExceptions', sortExceptions(list));
  res.json({ exception: result });
});

router.delete('/calendar-exceptions/:id', requirePlanner, (req: Request, res: Response) => {
  const list = getExceptions(req);
  const next = list.filter((e) => e.id !== req.params.id);
  setLocal(req.app.locals, 'calendarExceptions', next);
  res.json({ deleted: next.length !== list.length });
});

/**
 * GET /api/resources/workcentres/details
 * Return full rows from BomWorkCentre(s) for the Manage > Work Centers tab
 */
router.get('/workcentres/details', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const result = await sysproDb.query(`
      IF OBJECT_ID('BomWorkCentres', 'U') IS NOT NULL
        SELECT * FROM BomWorkCentres ORDER BY 1;
      ELSE IF OBJECT_ID('BomWorkCentre', 'U') IS NOT NULL
        SELECT * FROM BomWorkCentre ORDER BY 1;
      ELSE
        SELECT TOP 0 CAST('' AS varchar(50)) AS WorkCentre;
    `);

    const rows = result.recordset || [];
    res.json({
      count: rows.length,
      columns: rows.length ? Object.keys(rows[0]) : [],
      rows
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to load work centre detail rows' });
  }
});

router.get('/alternatives/groups', (req: Request, res: Response) => {
  const groups = ensureAlternativeGroups(req);
  res.json({ count: groups.length, groups });
});

router.post('/alternatives/groups', requirePlanner, (req: Request, res: Response) => {
  try {
    const groups = ensureAlternativeGroups(req);
    const workcentreId = String(req.body.workcentreId || '').trim();
    const name = String(req.body.name || '').trim();
    const machineIds = Array.isArray(req.body.machineIds)
      ? req.body.machineIds.map((value: any) => String(value || '').trim()).filter(Boolean)
      : [];

    if (!workcentreId || !name || machineIds.length === 0) {
      return res.status(400).json({ error: 'Work centre, group name, and at least one machine are required' });
    }

    const group: AlternativeGroup = {
      groupId: `alt-${Date.now()}`,
      workcentreId,
      name,
      machineIds,
      notes: String(req.body.notes || '').trim()
    };

    groups.push(group);
    setLocal(req.app.locals, 'alternativeGroups', groups);
    res.status(201).json({ group });
  } catch (error) {
    res.status(500).json({ error: (error as any).message || 'Failed to save alternative group' });
  }
});

router.delete('/alternatives/groups/:groupId', requirePlanner, (req: Request, res: Response) => {
  const groups = ensureAlternativeGroups(req);
  const index = groups.findIndex((group) => group.groupId === req.params.groupId);
  if (index < 0) {
    return res.status(404).json({ error: 'Alternative group not found' });
  }
  const [deleted] = groups.splice(index, 1);
  setLocal(req.app.locals, 'alternativeGroups', groups);
  res.json({ deleted: true, group: deleted });
});

/**
 * GET /api/resources/workcentre/:worcentreId
 * Get resources by workcentre
 */
router.get('/workcentre/:worcentreId', async (req: Request, res: Response) => {
  try {
    const { worcentreId } = req.params;
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const sysproService = new SysproDatabaseService(sysproDb);
    const resources = await sysproService.getResourcesByWorkcentre(worcentreId);
    const resolvedResources = applyShiftCalendarsToResources(req, resources);

    res.json({
      worcentreId,
      count: resolvedResources.length,
      resources: resolvedResources
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

/**
 * GET /api/resources/workcentres
 * Get all workcentres
 */
router.get('/workcentres', async (req: Request, res: Response) => {
  try {
    const sysproDb = req.app.locals.sysproDb;
    if (!sysproDb) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    const sysproService = new SysproDatabaseService(sysproDb);
    const workcentres = await sysproService.getWorkcentres();

    res.json({
      count: workcentres.length,
      workcentres
    });
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

export default router;
