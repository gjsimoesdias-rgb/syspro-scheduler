import { useState, useRef, useCallback } from 'react';
import toast from 'react-hot-toast';
import { jobService, resourceService, statusService, apiErrorMessage } from '../services/api';
import { Job, Resource } from '../types';
import { errorMessage } from '../utils/errors';

export interface DbStatus {
  sysproConnected: boolean;
  schedulerConnected: boolean;
  readOnly: boolean;
  message: string;
}

export interface AlternativeGroup {
  groupId: string;
  workcentreId: string;
  name: string;
  machineIds: string[];
  notes?: string;
}

export interface NewAlternativeGroup {
  workcentreId: string;
  name: string;
  machineIds: string[];
  notes: string;
}

export interface JobsDataResult {
  openJobs: Job[];
  setOpenJobs: React.Dispatch<React.SetStateAction<Job[]>>;
  resources: Resource[];
  setResources: React.Dispatch<React.SetStateAction<Resource[]>>;
  dataLoading: boolean;
  dataWarning: string | null;
  materialPlan: Array<Record<string, any>>;
  materialStatusByJob: Record<string, 'Materials' | 'Partial' | 'No Materials'>;
  setMaterialStatusByJob: React.Dispatch<React.SetStateAction<Record<string, 'Materials' | 'Partial' | 'No Materials'>>>;
  workcentreRows: Array<Record<string, unknown>>;
  workcentreColumns: string[];
  workcentrePage: number;
  setWorkcentrePage: React.Dispatch<React.SetStateAction<number>>;
  WORKCENTRE_PAGE_SIZE: number;
  alternativeGroups: AlternativeGroup[];
  newAlternativeGroup: NewAlternativeGroup;
  setNewAlternativeGroup: React.Dispatch<React.SetStateAction<NewAlternativeGroup>>;
  dbStatus: DbStatus;
  setDbStatus: React.Dispatch<React.SetStateAction<DbStatus>>;
  jobLoadRetryRef: React.MutableRefObject<number>;
  loadJobsAndResources: () => Promise<void>;
  loadSystemStatus: () => Promise<void>;
  loadWorkcentreDetails: () => Promise<void>;
  loadAlternativeGroups: () => Promise<void>;
  loadMaterialPlan: (jobs: Job[]) => Promise<void>;
  saveAlternativeGroup: () => Promise<void>;
  removeAlternativeGroup: (groupId: string) => Promise<void>;
}

const WORKCENTRE_PAGE_SIZE = 200;

/**
 * Manages all Syspro data loading: jobs, resources, workcentre details,
 * material plans, and alternative machine groups.
 */
export function useJobsData(): JobsDataResult {
  const [openJobs, setOpenJobs] = useState<Job[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataWarning, setDataWarning] = useState<string | null>(null);
  const [materialPlan, setMaterialPlan] = useState<Array<Record<string, any>>>([]);
  const [materialStatusByJob, setMaterialStatusByJob] = useState<Record<string, 'Materials' | 'Partial' | 'No Materials'>>({});
  const [workcentreRows, setWorkcentreRows] = useState<Array<Record<string, unknown>>>([]);
  const [workcentreColumns, setWorkcentreColumns] = useState<string[]>([]);
  const [workcentrePage, setWorkcentrePage] = useState(0);
  const [alternativeGroups, setAlternativeGroups] = useState<AlternativeGroup[]>([]);
  const [newAlternativeGroup, setNewAlternativeGroup] = useState<NewAlternativeGroup>({
    workcentreId: '',
    name: '',
    machineIds: [],
    notes: ''
  });
  const [dbStatus, setDbStatus] = useState<DbStatus>({
    sysproConnected: true,
    schedulerConnected: true,
    readOnly: false,
    message: ''
  });
  const jobLoadRetryRef = useRef(0);

  const loadJobsAndResources = async () => {
    try {
      setDataLoading(true);
      setDataWarning(null);

      const [jobsResult, resourcesResult] = await Promise.allSettled([
        jobService.getAll(),
        resourceService.getAll()
      ]);

      const warnings: string[] = [];

      if (jobsResult.status === 'fulfilled') {
        setOpenJobs(jobsResult.value.items || []);
        if (jobsResult.value.warning) warnings.push(jobsResult.value.warning);
      } else {
        console.error('Failed to load jobs:', jobsResult.reason);
        setOpenJobs((prev) => {
          if (prev.length > 0) {
            console.log(`Preserving ${prev.length} existing jobs after API failure`);
            return prev;
          }
          return [];
        });
        warnings.push('Jobs could not be loaded from the server');
      }

      if (resourcesResult.status === 'fulfilled') {
        setResources(resourcesResult.value.items || []);
        if (resourcesResult.value.warning) warnings.push(resourcesResult.value.warning);
      } else {
        console.error('Failed to load resources:', resourcesResult.reason);
        warnings.push('Resources could not be loaded from the server');
      }

      const warningText = warnings.length ? warnings.join(' • ') : null;
      setDataWarning(warningText);
      const jobsOk = jobsResult.status === 'fulfilled';
      setDbStatus((prev) => ({
        ...prev,
        sysproConnected: jobsOk,
        readOnly: !jobsOk,
        message: warningText || prev.message
      }));

      if (jobsResult.status === 'rejected' && resourcesResult.status === 'rejected') {
        toast.error('Failed to load jobs and resources');
      }
    } catch (error) {
      console.error('Failed to load jobs/resources:', error);
      toast.error(errorMessage(error, 'Failed to load jobs and resources'));
    } finally {
      setDataLoading(false);
    }
  };

  const loadSystemStatus = async () => {
    try {
      const response = await statusService.getStatus();
      const { sysproConnected, schedulerConnected, readOnly, message } = response;
      setDbStatus({ sysproConnected, schedulerConnected, readOnly, message });
    } catch (error) {
      console.warn('Status check failed:', error);
      setDbStatus((prev) => ({
        ...prev,
        sysproConnected: false,
        readOnly: true,
        message: 'Unable to verify database connection status'
      }));
    }
  };

  const loadWorkcentreDetails = async () => {
    try {
      const response = await resourceService.getWorkcentreDetails();
      setWorkcentreRows(response.rows || []);
      setWorkcentreColumns(response.columns || []);
      setWorkcentrePage(0);
    } catch (error) {
      console.warn('Failed to load work centre details:', error);
      setWorkcentreRows([]);
      setWorkcentreColumns([]);
      setWorkcentrePage(0);
    }
  };

  const loadAlternativeGroups = async () => {
    try {
      const groups = await resourceService.getAlternativeGroups();
      setAlternativeGroups(groups || []);
    } catch (error) {
      console.warn('Failed to load alternative groups:', error);
      setAlternativeGroups([]);
    }
  };

  // Only uses state setters, so its identity never needs to change.
  const loadMaterialPlan = useCallback(async (jobs: Job[]) => {
    try {
      if (!jobs.length) {
        setMaterialPlan([]);
        setMaterialStatusByJob({});
        return;
      }
      const response = await jobService.getMaterialPlan(
        jobs.map((job) => ({
          jobId: job.jobId,
          itemCode: job.itemCode,
          quantity: job.quantity,
          description: job.description
        }))
      );
      setMaterialPlan(response.materials || []);
      setMaterialStatusByJob(response.jobStatuses || {});
    } catch (error) {
      console.warn('Failed to load material plan:', error);
      setMaterialPlan([]);
      setMaterialStatusByJob({});
    }
  }, []);

  const saveAlternativeGroup = async () => {
    try {
      if (
        !newAlternativeGroup.workcentreId ||
        !newAlternativeGroup.name.trim() ||
        newAlternativeGroup.machineIds.length === 0
      ) {
        toast.error('Select a work centre, enter a group name, and choose at least one machine');
        return;
      }
      await resourceService.saveAlternativeGroup(newAlternativeGroup);
      setNewAlternativeGroup({ workcentreId: '', name: '', machineIds: [], notes: '' });
      await loadAlternativeGroups();
      toast.success('Alternative machine group saved');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to save alternative group'));
    }
  };

  const removeAlternativeGroup = async (groupId: string) => {
    try {
      await resourceService.deleteAlternativeGroup(groupId);
      await loadAlternativeGroups();
      toast.success('Alternative group removed');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Failed to remove alternative group'));
    }
  };

  return {
    openJobs,
    setOpenJobs,
    resources,
    setResources,
    dataLoading,
    dataWarning,
    materialPlan,
    materialStatusByJob,
    setMaterialStatusByJob,
    workcentreRows,
    workcentreColumns,
    workcentrePage,
    setWorkcentrePage,
    WORKCENTRE_PAGE_SIZE,
    alternativeGroups,
    newAlternativeGroup,
    setNewAlternativeGroup,
    dbStatus,
    setDbStatus,
    jobLoadRetryRef,
    loadJobsAndResources,
    loadSystemStatus,
    loadWorkcentreDetails,
    loadAlternativeGroups,
    loadMaterialPlan,
    saveAlternativeGroup,
    removeAlternativeGroup,
  };
}
