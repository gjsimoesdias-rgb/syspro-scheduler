/**
 * What the route sends to the scheduling worker thread (workerData).
 * Maps travel as [key, value][] arrays and Dates as strings — the worker
 * turns them back into Maps / Dates before running the engine.
 */
import type { Job, Workcentre, Resource, Material, PinnedOperation, ScheduleRequest } from '../types';
import type { SchedulingContext, JobMaterialPlanLite } from './SchedulingEngine';
import type { CrewSetup, ShiftTemplateLike } from '../utils/crews';
import type { EngineType } from './ISchedulingEngine';

type Entries<V> = Array<[string, V]>;

export interface SetupSequenceRow {
  fromItemCode: string;
  toItemCode: string;
  setupTimeMinutes: number;
  workcentreId?: string;
}

export interface WorkerPayload {
  jobs: Job[];
  workcentres: Entries<Workcentre>;
  resources: Entries<Resource>;
  materials: Entries<Material>;
  resourceCapacities?: Entries<number>;
  workcentreCapacities?: Entries<number>;
  materialPlan?: Entries<JobMaterialPlanLite>;
  setupSequences?: SetupSequenceRow[];
  /** Date.toString() / ISO text; parsed back with new Date(). */
  planningHorizonStart: string;
  planningHorizonEnd: string;
  schedulingRule?: SchedulingContext['schedulingRule'];
  schedulingDirection?: SchedulingContext['schedulingDirection'];
  dateAnchorMode?: SchedulingContext['dateAnchorMode'];
  anchorDate?: string;
  engineType?: EngineType;
  cpSatWeights?: ScheduleRequest['cpSatWeights'];
  cpSatTimeLimitSeconds?: number;
  productionMode?: SchedulingContext['productionMode'];
  lineGroupOverrides?: Record<string, string>;
  ruleToggles?: SchedulingContext['ruleToggles'];
  crewSetup?: CrewSetup;
  crewEmployees?: Array<{ code: string; shiftId?: string }>;
  crewShifts?: ShiftTemplateLike[];
  pinnedOperations?: Entries<PinnedOperation>;
}

/** Worker → route message. */
export type WorkerMessage<S> = { success: true; schedule: S } | { success: false; error: string };
