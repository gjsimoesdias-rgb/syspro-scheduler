import { useState } from 'react';
import toast from 'react-hot-toast';
import { Job, Resource } from '../types';
import { useUiStore } from '../stores/uiStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { apiClient, scheduleService, apiErrorMessage } from '../services/api';
import exportService from '../services/exportService';
import { convertScheduleDates } from '../utils/scheduleDates';
import { DbStatus } from './useJobsData';
import type { ScheduleConfig } from '../components/ScheduleSetupModal';

export interface ScheduleGenerationResult {
  loading: boolean;
  generateSchedule: (selectedJobIds?: string[], configOverride?: Partial<ScheduleConfig>) => Promise<void>;
  exportToSyspro: () => Promise<void>;
  handleExport: (format: 'csv' | 'json' | 'pdf') => Promise<void>;
}

interface Params {
  openJobs: Job[];
  resources: Resource[];
  dbStatus: DbStatus;
  excludedJobIds: Set<string>;
  pinnedJobIds: Set<string>;
  loadJobsAndResources: () => Promise<void>;
  addVersion: (schedule: import('../types').Schedule, description: string) => void;
}

/**
 * Encapsulates schedule generation, file export, and Syspro write-back.
 */
export function useScheduleGeneration({
  openJobs,
  resources,
  dbStatus,
  excludedJobIds,
  pinnedJobIds,
  loadJobsAndResources,
  addVersion,
}: Params): ScheduleGenerationResult {
  const [loading, setLoading] = useState(false);

  // Read scheduling preferences from stores
  const schedulingRule = useUiStore((s) => s.schedulingRule);
  const schedulingDirection = useUiStore((s) => s.schedulingDirection);
  const scheduleDateMode = useUiStore((s) => s.scheduleDateMode);
  const schedulingHorizonStart = useUiStore((s) => s.schedulingHorizonStart);
  const schedulingHorizonEnd = useUiStore((s) => s.schedulingHorizonEnd);
  const useAlternatives = useUiStore((s) => s.useAlternatives);

  const schedule = useScheduleStore((s) => s.schedule);
  const setSchedule = useScheduleStore((s) => s.setSchedule);
  const setScheduleSource = useScheduleStore((s) => s.setScheduleSource);
  const setIsGeneratingSchedule = useScheduleStore((s) => s.setIsGeneratingSchedule);
  const setGenerationProgress = useScheduleStore((s) => s.setGenerationProgress);
  const setGenerationStatusText = useScheduleStore((s) => s.setGenerationStatusText);
  const scheduleVersions = useScheduleStore((s) => s.scheduleVersions);
  const undoRedoManager = useScheduleStore((s) => s.undoRedoManager);
  const activeVersion = useScheduleStore((s) => s.activeVersion);

  const getHorizonBounds = (override?: { start: string; end: string }) => {
    const startValue = override?.start ?? schedulingHorizonStart;
    const endValue = override?.end ?? schedulingHorizonEnd;
    const startDate = new Date(`${startValue}T00:00:00`);
    const endDate = new Date(`${endValue}T23:59:59.999`);
    return { startDate, endDate };
  };

  const generateSchedule = async (
    selectedJobIds?: string[],
    configOverride?: Partial<ScheduleConfig>
  ) => {
    if (!dbStatus.sysproConnected) {
      toast.error('SQL Server not connected - scheduling unavailable in read-only mode');
      return;
    }
    if (!openJobs.length || !resources.length) {
      toast.error('Load jobs and resources before scheduling');
      return;
    }

    try {
      setLoading(true);
      setIsGeneratingSchedule(true);
      setGenerationProgress(3);
      setGenerationStatusText('Reading jobs, shifts, and constraints...');
      console.log('📊 Requesting schedule generation...');

      const effectiveRule = configOverride?.schedulingRule ?? schedulingRule;
      const effectiveDirection = configOverride?.schedulingDirection ?? schedulingDirection;
      const effectiveDateMode = configOverride?.scheduleDateMode ?? scheduleDateMode;
      const effectiveHorizonStart = configOverride?.horizonStart ?? schedulingHorizonStart;
      const effectiveHorizonEnd = configOverride?.horizonEnd ?? schedulingHorizonEnd;
      const horizonBounds = getHorizonBounds({ start: effectiveHorizonStart, end: effectiveHorizonEnd });

      const anchorDate =
        effectiveDateMode === 'manual'
          ? configOverride?.anchorDateTime
            ? new Date(configOverride.anchorDateTime)
            : effectiveDirection === 'backward'
            ? horizonBounds.endDate
            : horizonBounds.startDate
          : undefined;

      const response = await apiClient.post(
        '/schedule/generate',
        {
          planningHorizonStartDate: horizonBounds.startDate,
          planningHorizonEndDate: horizonBounds.endDate,
          schedulingRule: effectiveRule,
          schedulingDirection: effectiveDirection,
          dateAnchorMode: effectiveDateMode,
          anchorDate,
          useAlternatives,
          excludedJobIds: excludedJobIds.size > 0 ? Array.from(excludedJobIds) : undefined,
          pinnedJobIds: pinnedJobIds.size > 0 ? Array.from(pinnedJobIds) : undefined,
          ...(selectedJobIds && selectedJobIds.length > 0 ? { selectedJobIds } : {}),
          engineType: configOverride?.engineType ?? 'greedy',
          ...(configOverride?.cpSatWeights ? { cpSatWeights: configOverride.cpSatWeights } : {}),
          ...(configOverride?.cpSatTimeLimitSeconds
            ? { cpSatTimeLimitSeconds: configOverride.cpSatTimeLimitSeconds }
            : {}),
          productionMode: configOverride?.productionMode ?? 'job-shop',
          ...(configOverride?.freezeHorizonDays && configOverride.freezeHorizonDays > 0
            ? { freezeHorizonDays: configOverride.freezeHorizonDays }
            : {}),
          // An open what-if receives the run; the master plan stays as it is.
          ...(activeVersion ? { versionId: activeVersion.versionId } : {}),
        },
        { timeout: 300000 } as any
      );

      setGenerationProgress(100);
      setGenerationStatusText('Schedule ready');

      const newSchedule = convertScheduleDates(response.data.schedule);
      setSchedule(newSchedule);
      setScheduleSource('session');

      undoRedoManager.addState(newSchedule, `Generated schedule - ${newSchedule.jobSchedules.length} jobs`);
      addVersion(newSchedule, `Generated v${scheduleVersions.length + 1}`);

      toast.success(activeVersion
        ? `✓ What-if "${activeVersion.name}" regenerated with ${newSchedule.jobSchedules.length} jobs`
        : `✓ Schedule generated with ${newSchedule.jobSchedules.length} jobs`);
    } catch (error: any) {
      console.error('Error generating schedule:', error);
      toast.error(apiErrorMessage(error, 'Failed to generate schedule'));
    } finally {
      setLoading(false);
      setIsGeneratingSchedule(false);
    }
  };

  const exportToSyspro = async () => {
    if (!schedule) {
      toast.error('No schedule to export');
      return;
    }
    if (activeVersion) {
      toast.error(`"${activeVersion.name}" is a what-if. Commit it to the master plan (Versions tab) before sending to SYSPRO.`);
      return;
    }
    const jobCount = schedule.jobSchedules.filter((j) => j.operationSchedules?.length).length;
    const opCount = schedule.jobSchedules.reduce((n, j) => n + (j.operationSchedules?.length || 0), 0);
    if (!window.confirm(
      `Send this schedule to SYSPRO?\n\n${jobCount} jobs / ${opCount} operations will get new scheduled ` +
      'dates and machines in SYSPRO. Due dates are not changed.\n\nThe schedule will be saved and approved first.'
    )) {
      return;
    }
    try {
      setLoading(true);
      // Export reads the schedule from the server, so persist exactly what is on
      // screen, approve it, then export that approved version.
      await scheduleService.save(schedule);
      await scheduleService.approve(schedule.scheduleId);
      const result = await scheduleService.exportToSyspro(schedule.scheduleId);
      setScheduleSource('none');
      await loadJobsAndResources();
      const written = result?.details?.schedulesWritten;
      toast.success(written != null ? `✓ Sent to SYSPRO — ${written} jobs updated` : '✓ Schedule sent to SYSPRO');
    } catch (error: any) {
      console.error('Error exporting schedule:', error);
      toast.error(apiErrorMessage(error, 'Failed to export schedule'));
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async (format: 'csv' | 'json' | 'pdf') => {
    if (!schedule) {
      toast.error('No schedule to export');
      return;
    }
    try {
      if (format === 'csv') exportService.exportToCSV(schedule);
      else if (format === 'json') exportService.exportToJSON(schedule);
      else if (format === 'pdf') exportService.downloadScheduleReport(schedule);
      toast.success(`✓ Schedule exported as ${format.toUpperCase()}`);
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Failed to export schedule');
    }
  };

  return { loading, generateSchedule, exportToSyspro, handleExport };
}
