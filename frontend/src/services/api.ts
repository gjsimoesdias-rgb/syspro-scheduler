/**
 * API Services
 */

import axios from 'axios';
import { Schedule, Job, Resource } from '../types';
import { setTypedClientTokenProvider } from './typed-client';

export type BomLineStatus = 'Materials' | 'Partial' | 'No Materials';

export interface BomWarehouseRow {
  warehouseCode: string;
  qtyOnHand: number;
  qtyAllocWip: number;
  qtyAllocSO: number;
}

export interface BomIncomingReceipt {
  poNumber: string;
  promiseDate: string | null; // ISO string
  dueDate: string | null;     // ISO string
  outstandingQty: number;
}

export interface BomDetailLine {
  componentCode: string;
  description: string;
  unitOfMeasure: string;
  quantityPerUnit: number;
  scrapFactor: number;
  requiredQty: number;

  // Headline numbers (kept for backward compatibility with the original modal)
  stockOnHand: number;        // sum of QtyOnHand across warehouses
  reservedQty: number;        // wipAlloc + soAlloc + otherJobsHold rolled together
  openPoQty: number;          // sum of outstanding PO qty
  availableQty: number;
  shortageQty: number;
  leadTimeDays: number;
  status: BomLineStatus;

  // Richer breakdown (added 2026-05-06)
  wipAllocQty?: number;       // QtyAllocWip from InvWarehouse
  soAllocQty?: number;        // QtyAllocSO from InvWarehouse
  otherJobsHoldQty?: number;  // From WipJobAllocation excluding current job
  freeOnHandQty?: number;     // onHand - wip - so - otherHolds (clamped >= 0)
  warehouses?: BomWarehouseRow[];
  incomingReceipts?: BomIncomingReceipt[];
}

export interface BomDetail {
  jobId: string;
  itemCode: string;
  itemDescription?: string;
  quantity: number;
  dueDate?: string | null;
  status: BomLineStatus;
  lineCount: number;
  okCount?: number;
  partialCount?: number;
  shortageCount: number;
  lines: BomDetailLine[];
  note?: string;
}

/**
 * The ONE API base URL for the whole frontend. Import it — never hardcode
 * 'http://localhost:3000/api', which only works on the server PC itself.
 * Vite builds: vite.config.ts maps VITE_API_URL to process.env.REACT_APP_API_URL.
 * Otherwise the API is on the same origin that served the page.
 */
export const API_BASE_URL =
  process.env.REACT_APP_API_URL ||
  (typeof window !== 'undefined' ? `${window.location.origin}/api` : 'http://localhost:3000/api');

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000
});

// ── Auth token injection ──────────────────────────────────────────────────────
// AuthContext calls setTokenProvider() whenever the access token changes.
// This keeps api.ts decoupled from React while still injecting the header.
// The typed openapi-fetch client (typed-client.ts) is kept in sync automatically.
let _tokenProvider: () => string | null = () => null;
export const setTokenProvider = (fn: () => string | null): void => {
  _tokenProvider = fn;
  // Sync the typed openapi-fetch client so AuthContext needs only one call site.
  setTypedClientTokenProvider(fn);
};

apiClient.interceptors.request.use((config) => {
  const token = _tokenProvider();
  // A retried request already carries the freshly refreshed token — keep it.
  if (token && !config.headers.Authorization) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// ── Silent token refresh ──────────────────────────────────────────────────────
// AuthContext registers how to get a new access token (refresh token or
// Windows re-auth). On a 401 we refresh ONCE — concurrent 401s share the same
// in-flight refresh — and replay the request. Only if that fails do we
// broadcast 'aps:unauthorized' so AuthContext signs the user out.
let _refreshHandler: (() => Promise<string | null>) | null = null;
let _refreshInFlight: Promise<string | null> | null = null;

export const setRefreshHandler = (fn: () => Promise<string | null>): void => {
  _refreshHandler = fn;
};

/** Get a new access token, de-duplicating concurrent callers. */
export const refreshAccessToken = (): Promise<string | null> => {
  if (!_refreshHandler) return Promise.resolve(null);
  if (!_refreshInFlight) {
    _refreshInFlight = _refreshHandler()
      .catch(() => null)
      .finally(() => { _refreshInFlight = null; });
  }
  return _refreshInFlight;
};

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
    const isAuthCall = String(config?.url || '').includes('/auth/');
    if (error.response?.status === 401 && config && !config._retried && !isAuthCall) {
      config._retried = true;
      const token = await refreshAccessToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
        return apiClient(config);
      }
    }
    if (error.response?.status === 401) {
      window.dispatchEvent(new CustomEvent('aps:unauthorized'));
    }
    return Promise.reject(error);
  }
);

/**
 * Extract a human-readable message from ANY backend error shape.
 * Route-level catches send { error: string }; the Express 404 handler and the
 * centralised error middleware send { error: { code, message, details? } }.
 * Rendering the object form directly (e.g. in a toast) crashes React with
 * error #31 — always go through this helper.
 */
export const apiErrorMessage = (err: any, fallback: string): string => {
  const e = err?.response?.data?.error;
  if (typeof e === 'string' && e) return e;
  if (e && typeof e.message === 'string' && e.message) return e.message;
  const detail = err?.response?.data?.details?.[0]?.message;
  if (typeof detail === 'string' && detail) return detail;
  if (typeof err?.message === 'string' && err.message) return err.message;
  return fallback;
};

export const scheduleService = {
  generate: async (startDate: Date, endDate: Date): Promise<Schedule> => {
    const response = await apiClient.post('/schedule/generate', {
      planningHorizonStartDate: startDate,
      planningHorizonEndDate: endDate
    });
    return response.data.schedule;
  },

  getById: async (scheduleId: string): Promise<Schedule> => {
    const response = await apiClient.get(`/schedule/${scheduleId}`);
    return response.data;
  },

  approve: async (scheduleId: string): Promise<void> => {
    await apiClient.post(`/schedule/${encodeURIComponent(scheduleId)}/approve`);
  },

  /**
   * Write an APPROVED, already-saved schedule to SYSPRO. The server reads the
   * schedule from its own store by id (it ignores any body), so call save() and
   * approve() first. Long timeout: the export refreshes the APS cache and writes
   * every operation inside one transaction.
   */
  exportToSyspro: async (scheduleId: string): Promise<any> => {
    const response = await apiClient.post(
      `/schedule/${encodeURIComponent(scheduleId)}/export-to-syspro`,
      {},
      { timeout: 300000 }
    );
    return response.data;
  },

  save: async (schedule: Schedule): Promise<void> => {
    await apiClient.post('/schedule/save', { schedule });
  },

  loadLatest: async (): Promise<{ schedule: Schedule | null; meta?: any }> => {
    const response = await apiClient.get('/schedule/latest');
    return response.data;
  },

  restoreVersion: async (scheduleId: string): Promise<{ schedule: Schedule; restoredAt: string }> => {
    const response = await apiClient.post(`/schedule/load-version/${encodeURIComponent(scheduleId)}`);
    return response.data;
  }
};

/** Plan versions (backend /api/versions): master + what-ifs + history. */
export interface VersionSummary {
  versionId: string;
  kind: 'Master' | 'History' | 'WhatIf';
  name: string;
  status: string;
  jobCount: number | null;
  operationCount: number | null;
  horizonStart: string | null;
  horizonEnd: string | null;
  savedAt: string;
  createdBy: string | null;
  basedOnId: string | null;
  metrics: Record<string, any> | null;
}

export const versionService = {
  list: async (historyLimit = 30): Promise<{ master: VersionSummary | null; whatIfs: VersionSummary[]; history: VersionSummary[] }> =>
    (await apiClient.get('/versions', { params: { historyLimit } })).data,
  get: async (id: string): Promise<{ version: VersionSummary; schedule: Schedule }> =>
    (await apiClient.get(`/versions/${encodeURIComponent(id)}`)).data,
  createWhatIf: async (name: string, fromId?: string): Promise<VersionSummary> =>
    (await apiClient.post('/versions/whatif', { name, ...(fromId ? { fromId } : {}) })).data.version,
  saveInto: async (id: string, schedule: Schedule): Promise<void> => {
    await apiClient.put(`/versions/${encodeURIComponent(id)}/schedule`, { schedule });
  },
  commit: async (id: string): Promise<void> => { await apiClient.post(`/versions/${encodeURIComponent(id)}/commit`); },
  revert: async (id: string): Promise<void> => { await apiClient.post(`/versions/${encodeURIComponent(id)}/revert`); },
  rename: async (id: string, name: string): Promise<void> => { await apiClient.patch(`/versions/${encodeURIComponent(id)}`, { name }); },
  remove: async (id: string): Promise<void> => { await apiClient.delete(`/versions/${encodeURIComponent(id)}`); },
  publishStatus: async (): Promise<{
    jobs: Array<{ jobId: string; state: 'Published' | 'Pending' | 'Error'; publishedAt: string | null; lastError: string | null }>;
    counts: { Published: number; Pending: number; Error: number };
  }> => (await apiClient.get('/schedule/publish-status')).data,
  resetPublish: async (jobIds: string[]): Promise<number> =>
    (await apiClient.post('/schedule/publish-status/reset', { jobIds })).data.reset,
  purge: async (olderThanDays: number, keepAtLeast = 20): Promise<number> =>
    (await apiClient.post('/versions/purge', { olderThanDays, keepAtLeast })).data.deleted,
};

export const jobService = {
  getAll: async (): Promise<{ items: Job[]; warning?: string }> => {
    const response = await apiClient.get('/jobs');
    return {
      items: response.data.jobs,
      warning: response.data.warning
    };
  },

  getMaterialPlan: async (jobs: Partial<Job>[]) => {
    const response = await apiClient.post('/jobs/material-plan', { jobs });
    return response.data;
  },

  /**
   * Returns the BOM for a single job along with per-line availability.
   * Used by the Gantt right-click → "View materials" feature.
   */
  getBomDetail: async (jobId: string): Promise<BomDetail> => {
    const response = await apiClient.get(`/jobs/${encodeURIComponent(jobId)}/bom-detail`);
    return response.data;
  },

  getById: async (jobId: string): Promise<Job> => {
    const response = await apiClient.get(`/jobs/${jobId}`);
    return response.data;
  },

  getOperations: async (jobId: string) => {
    const response = await apiClient.get(`/jobs/${jobId}/operations`);
    return response.data.operations;
  }
};

export const resourceService = {
  getAll: async (): Promise<{ items: Resource[]; warning?: string }> => {
    const response = await apiClient.get('/resources');
    return {
      items: response.data.resources,
      warning: response.data.warning
    };
  },

  getWorkcentres: async () => {
    const response = await apiClient.get('/resources/workcentres');
    return response.data.workcentres;
  },

  getWorkcentreDetails: async () => {
    const response = await apiClient.get('/resources/workcentres/details');
    return response.data;
  },

  getAlternativeGroups: async () => {
    const response = await apiClient.get('/resources/alternatives/groups');
    return response.data.groups || [];
  },

  saveAlternativeGroup: async (payload: { workcentreId: string; name: string; machineIds: string[]; notes?: string }) => {
    const response = await apiClient.post('/resources/alternatives/groups', payload);
    return response.data.group;
  },

  deleteAlternativeGroup: async (groupId: string) => {
    const response = await apiClient.delete(`/resources/alternatives/groups/${groupId}`);
    return response.data;
  },

  getDefinitions: async (): Promise<{ definitions: any[]; shifts: any[]; warning?: string }> => {
    const response = await apiClient.get('/resources/definitions');
    return {
      definitions: response.data.definitions || [],
      shifts: response.data.shifts || [],
      warning: response.data.warning
    };
  },

  updateDefinition: async (resourceId: string, payload: { quantity?: number; shiftId?: string; activated?: boolean; lineGroupId?: string }) => {
    const response = await apiClient.put(`/resources/definitions/${resourceId}`, payload);
    return response.data.definition;
  },

  createShift: async (payload: {
    name: string;
    startTime?: string;
    endTime?: string;
    workingDays: number[];
    hoursPerDay: number;
    diversions?: any[];
  }) => {
    const response = await apiClient.post('/resources/shifts', payload);
    return response.data.shift;
  },

  updateShift: async (shiftId: string, payload: {
    name: string;
    startTime?: string;
    endTime?: string;
    workingDays: number[];
    hoursPerDay: number;
    diversions?: any[];
  }) => {
    const response = await apiClient.put(`/resources/shifts/${shiftId}`, payload);
    return response.data.shift;
  },

  deleteShift: async (shiftId: string) => {
    const response = await apiClient.delete(`/resources/shifts/${shiftId}`);
    return response.data;
  },

  getCalendarExceptions: async (): Promise<CalendarException[]> => {
    const response = await apiClient.get('/resources/calendar-exceptions');
    return response.data.exceptions || [];
  },

  createCalendarException: async (payload: Omit<CalendarException, 'id'>): Promise<CalendarException> => {
    const response = await apiClient.post('/resources/calendar-exceptions', payload);
    return response.data.exception;
  },

  deleteCalendarException: async (id: string) => {
    const response = await apiClient.delete(`/resources/calendar-exceptions/${encodeURIComponent(id)}`);
    return response.data;
  }
};

/** Crew (labour) pools — Manage → Crews (see backend utils/crews.ts). */
export interface CrewPool { id: string; name: string; headcount: number; employees?: string[] }
/** SYSPRO employee (BomEmployee: Employee, Name, WorkCentre, ShiftId). */
export interface SysproEmployee { code: string; name: string; workCentre?: string; shiftId?: string; active: boolean }
export interface CrewLine { poolId: string; operators: number }
export interface CrewSetup { enabled: boolean; pools: CrewPool[]; lines: Record<string, CrewLine> }

export const crewService = {
  get: async (): Promise<CrewSetup> => {
    const response = await apiClient.get('/resources/crews');
    return response.data.setup;
  },
  employees: async (): Promise<{ employees: SysproEmployee[]; note?: string }> => {
    const response = await apiClient.get('/resources/employees');
    return { employees: response.data.employees || [], note: response.data.note };
  },
  save: async (setup: CrewSetup): Promise<CrewSetup> => {
    const response = await apiClient.put('/resources/crews', setup);
    return response.data.setup;
  },
};

/** Holiday, shutdown, short day or extra working day (see backend utils/calendarExceptions.ts). */
export interface CalendarException {
  id: string;
  date: string;       // YYYY-MM-DD
  name: string;
  scope: string;      // 'plant' or a work-centre id
  isWorking: boolean;
  startTime?: string; // HH:MM — when set, only this window is workable
  endTime?: string;
}

// ─────────────────────────────────────────────────────────────
// Inventory — Stock On Hand and Open Purchase Orders
// ─────────────────────────────────────────────────────────────

export interface StockItem {
  StockCode: string;
  Description: string;
  ProductClass: string;
  PreferredSupplier: string;
  LeadTime: number;
  UnitOfMeasure: string;
  Warehouse: string;
  QtyOnHand: number;
  QtyAllocated: number;
  QtyAllocatedWip: number;
  QtyOnOrder: number;
  QtyInTransit: number;
  QtyInInspection: number;
  SafetyStockQty: number;
  ReOrderQty: number;
  MinimumQty: number;
  MaximumQty: number;
  UnitCost: number;
  FreeOnHand: number;
  DateLastSale: string | null;
  DateLastStockMove: string | null;
  DateLastPurchase: string | null;
}

export interface PurchaseOrderLine {
  PurchaseOrder: string;
  OrderStatus: string;
  OrderStatusLabel: string;
  Supplier: string;
  OrderEntryDate: string;
  OrderDueDate: string;
  Warehouse: string;
  Line: number;
  StockCode: string;
  StockDescription: string;
  LineWarehouse: string;
  OrderUom: string;
  OrderedQty: number;
  ReceivedQty: number;
  OutstandingQty: number;
  LineDueDate: string;
  UnitPrice: number;
  OutstandingValue: number;
}

export interface MaterialShortage {
  job: string;
  jobStockCode: string;
  componentCode: string;
  componentDesc: string;
  totalRequired: number;
  qtyIssued: number;
  qtyOutstanding: number;
  onHand: number;
  freeOnHand: number;
  openPoQty: number;
  netAvailable: number;
  shortage: number;
  unitOfMeasure: string;
  preferredSupplier: string;
  leadTime: number;
  abcClass: string;
  productClass: string;
}

export interface ProjectionEvent { date: string; kind: 'po' | 'output' | 'demand'; ref: string; qty: number; balance: number }
export interface ComponentProjection {
  code: string; description?: string; unitOfMeasure?: string;
  opening: number; onHand: number; events: ProjectionEvent[];
  unscheduledDemand: Array<{ jobId: string; qty: number }>;
  minBalance: number; finalBalance: number;
  firstShort?: { date: string; jobId: string; shortQty: number };
  status: 'short' | 'ok';
  daily: Array<{ day: string; balance: number }>;
}

export interface SoPeg { source: 'stock' | 'job'; jobId?: string; qty: number; availableAt: string | null; direct?: boolean }
export interface PeggedSoLine {
  salesOrder: string; line: number; customer?: string; customerName?: string; customerPo?: string;
  stockCode: string; description?: string; unitOfMeasure?: string; openQty: number; shipDate: string | null;
  pegs: SoPeg[]; shortQty: number; availableAt: string | null;
  status: 'on-time' | 'late' | 'past-due' | 'unscheduled' | 'short'; daysLate: number;
}
export interface SoPeggingResult {
  generatedAt: string;
  counts: { lines: number; onTime: number; late: number; pastDue: number; short: number; unscheduled: number };
  lines: PeggedSoLine[];
  byJob: Record<string, Array<{ salesOrder: string; line: number; customerName?: string; qty: number; shipDate: string | null; status: PeggedSoLine['status'] }>>;
  warning?: string;
}

export const inventoryService = {
  /** Open sales-order lines pegged to stock and the plan's jobs. */
  pegging: async (jobs: Array<{ jobId: string; itemCode?: string; quantity?: number; start?: string | null; end?: string | null }>) => {
    const response = await apiClient.post('/inventory/pegging', { jobs });
    return response.data as SoPeggingResult;
  },
  /** Projected inventory by day for the plan's components. */
  projection: async (jobs: Array<{ jobId: string; itemCode?: string; quantity?: number; start?: string | null; end?: string | null }>) => {
    const response = await apiClient.post('/inventory/projection', { jobs });
    return response.data as { generatedAt: string; count: number; shortCount: number; components: ComponentProjection[] };
  },
  getStock: async (params?: { warehouse?: string; stockCode?: string; lowStock?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.warehouse) query.set('warehouse', params.warehouse);
    if (params?.stockCode) query.set('stockCode', params.stockCode);
    if (params?.lowStock) query.set('lowStock', 'true');
    const response = await apiClient.get(`/inventory/stock?${query.toString()}`);
    return response.data as { items: StockItem[]; count: number };
  },

  getStockByCode: async (stockCode: string) => {
    const response = await apiClient.get(`/inventory/stock/${encodeURIComponent(stockCode)}`);
    return response.data;
  },

  getPurchaseOrders: async (params?: { supplier?: string; stockCode?: string; status?: string }) => {
    const query = new URLSearchParams();
    if (params?.supplier) query.set('supplier', params.supplier);
    if (params?.stockCode) query.set('stockCode', params.stockCode);
    if (params?.status) query.set('status', params.status);
    const response = await apiClient.get(`/inventory/purchase-orders?${query.toString()}`);
    return response.data as { items: PurchaseOrderLine[]; count: number };
  },

  getPurchaseOrdersByStockCode: async (stockCode: string) => {
    const response = await apiClient.get(`/inventory/purchase-orders/${encodeURIComponent(stockCode)}`);
    return response.data;
  },

  getShortages: async () => {
    const response = await apiClient.get('/inventory/shortages');
    return response.data as { items: MaterialShortage[]; count: number; affectedJobs: number };
  },

  getWarehouses: async () => {
    const response = await apiClient.get('/inventory/warehouses');
    return response.data as { items: { Warehouse: string; Description: string }[] };
  }
};

// ── Live schema introspection (HOME → Schema diagram) ──────────────────────────

export interface SchemaColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
}

export interface SchemaObject {
  schema: string;
  name: string;
  type: 'table' | 'view';
  rows?: number;
  columns: SchemaColumn[];
}

export interface SchemaRelationship {
  name: string;
  fromSchema: string;
  fromTable: string;
  fromColumn: string;
  toSchema: string;
  toTable: string;
  toColumn: string;
}

export interface SchemaDatabase {
  name: string;
  role: 'syspro' | 'scheduler';
  tableCount: number;
  viewCount: number;
  objects: SchemaObject[];
  relationships: SchemaRelationship[];
}

export interface SchemaResponse {
  databases: SchemaDatabase[];
  generatedAt: string;
}

export const statusService = {
  getStatus: async () => {
    const response = await apiClient.get('/status');
    return response.data;
  },

  getSchema: async (): Promise<SchemaResponse> => {
    // SYSPRO catalogs are large — allow a generous timeout for the round-trip.
    const response = await apiClient.get('/status/schema', { timeout: 120000 });
    return response.data as SchemaResponse;
  },

  getDatabases: async (payload: {
    server?: string;
    userName?: string;
    username?: string;
    password?: string;
    authMode?: string;
    instanceName?: string;
    port?: number | string;
  }) => {
    const response = await apiClient.post('/status/databases', payload);
    return response.data;
  },

  connect: async (payload: {
    server: string;
    database: string;
    schedulerDatabase?: string;
    userName?: string;
    username?: string;
    password?: string;
    authMode?: string;
    instanceName?: string;
    port?: number | string;
  }) => {
    const response = await apiClient.post('/status/connect', payload);
    return response.data;
  }
};

// ── Audit log ────────────────────────────────────────────────────────────────

export interface AuditRow {
  auditId: string;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: string;
  after?: string;
  traceId?: string;
  ts: string;
}

export const auditService = {
  getHistory: async (params?: {
    entityType?: string;
    entityId?: string;
    limit?: number;
  }): Promise<{ entries: AuditRow[]; total: number }> => {
    const query = new URLSearchParams();
    if (params?.entityType) query.set('entityType', params.entityType);
    if (params?.entityId)   query.set('entityId',   params.entityId);
    if (params?.limit)      query.set('limit',       String(params.limit));
    const response = await apiClient.get(`/audit?${query.toString()}`);
    return response.data as { entries: AuditRow[]; total: number };
  },
};

// Bundled default — assigned to a named const so ESLint's
// import/no-anonymous-default-export rule passes and the React DevTools
// can show a friendlier display name.
const apiServices = {
  scheduleService,
  jobService,
  resourceService,
  statusService,
  inventoryService,
};

export const columnProfileService = {
  get: async (): Promise<{ visibleJobColumns: string[]; profileName?: string }> => {
    const res = await apiClient.get('/users/me/column-profile');
    return res.data;
  },
  save: async (visibleJobColumns: string[], profileName?: string): Promise<void> => {
    await apiClient.put('/users/me/column-profile', { visibleJobColumns, profileName });
  },
};

// ─────────────────────────────────────────────────────────────
// Settings service
// ─────────────────────────────────────────────────────────────

export interface PlanningIntervalSettings {
  mode: 'from-today' | 'previous-loaded' | 'custom';
  fromTodayStartOffset: number;   // days from today → schedule start
  fromTodayDurationWeeks: number; // weeks from start → schedule end
  customFrom: string;             // ISO date (YYYY-MM-DD)
  customTo: string;               // ISO date (YYYY-MM-DD)
}

export interface CompanySettingsDto {
  general?: {
    theme?: string;
    [key: string]: unknown;
  };
  jobManagement?: {
    defaultDirection?: string;
    includeCompletedOps?: boolean;
    [key: string]: unknown;
  };
  fcs?: {
    planningInterval?: PlanningIntervalSettings;
    schedulingRules?: {
      schedulingMethod?: string;
      sequenceBy?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: any;
}

export const settingsService = {
  getCompany: async (): Promise<CompanySettingsDto> => {
    const res = await apiClient.get('/settings/company');
    return res.data;
  },
};

// ─────────────────────────────────────────────────────────────
// Pin service — freeze / unfreeze operation time slots
// ─────────────────────────────────────────────────────────────

export interface PinnedOperationDto {
  jobId: string;
  opId: string;
  workcentreId: string;
  resourceId: string;
  plannedStartDate: string; // ISO 8601
  plannedEndDate: string;   // ISO 8601
  pinnedAt: string;         // ISO 8601
  pinnedBy?: string;
}

export const pinService = {
  getAll: async (): Promise<PinnedOperationDto[]> => {
    const res = await apiClient.get('/schedule/pins');
    return res.data;
  },

  pin: async (pin: Omit<PinnedOperationDto, 'pinnedAt' | 'pinnedBy'>): Promise<{ ok: boolean; key: string }> => {
    const res = await apiClient.post('/schedule/pin', pin);
    return res.data;
  },

  unpin: async (jobId: string, opId: string): Promise<{ ok: boolean }> => {
    const res = await apiClient.delete(`/schedule/pin/${encodeURIComponent(jobId)}/${encodeURIComponent(opId)}`);
    return res.data;
  },

  /** Time-fence lock: pin every master-plan operation starting before `until`. */
  timeFence: async (until: Date): Promise<{ added: number; total: number }> =>
    (await apiClient.post('/schedule/pins/time-fence', { until: until.toISOString() })).data,

  /** Remove all locks, or only those starting before `before`. */
  removeAll: async (before?: Date): Promise<{ removed: number; total: number }> =>
    (await apiClient.delete('/schedule/pins', { params: before ? { before: before.toISOString() } : {} })).data,
};

export default apiServices;
