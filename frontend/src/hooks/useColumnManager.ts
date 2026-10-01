import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { format } from 'date-fns';
import toast from 'react-hot-toast';
import { Job, Operation } from '../types';
import { columnProfileService } from '../services/api';
import { useUiStore } from '../stores/uiStore';

export interface JobColumnDef {
  key: string;
  label: string;
}

export const DEFAULT_JOB_COLUMNS: JobColumnDef[] = [
  { key: 'jobId', label: 'Job' },
  { key: 'itemCode', label: 'Item' },
  { key: 'description', label: 'Description' },
  { key: 'quantity', label: 'Qty' },
  { key: 'priority', label: 'Priority' },
  { key: 'dueDate', label: 'Due Date' },
  { key: 'status', label: 'Status' },
  { key: 'scheduleStatus', label: 'Schedule' },
  { key: 'materialStatus', label: 'Materials' },
  // LYNQ-style status columns (phase 6)
  { key: 'validForScheduling', label: 'Valid' },
  { key: 'lateness', label: 'Overdue' },
  { key: 'lockedOps', label: 'Locked' },
  { key: 'publishState', label: 'SYSPRO' },
];

export const DEFAULT_OPERATION_COLUMNS: JobColumnDef[] = [
  { key: 'sequence', label: 'Seq' },
  { key: 'opId', label: 'Op' },
  { key: 'workcentreId', label: 'Workcentre' },
  { key: 'workcentreName', label: 'Name' },
  { key: 'duration', label: 'Duration' },
  { key: 'setupTime', label: 'Setup' },
  { key: 'queueTime', label: 'Queue' },
  { key: 'moveTime', label: 'Move' },
  { key: 'batchSize', label: 'Batch Size' },
  { key: 'status', label: 'Status' },
];

export interface ColumnManagerResult {
  visibleJobColumns: string[];
  setVisibleJobColumns: React.Dispatch<React.SetStateAction<string[]>>;
  visibleOperationColumns: string[];
  setVisibleOperationColumns: React.Dispatch<React.SetStateAction<string[]>>;
  columnProfileName: string;
  setColumnProfileName: React.Dispatch<React.SetStateAction<string>>;
  profileSaving: boolean;
  showColumnPicker: boolean;
  setShowColumnPicker: React.Dispatch<React.SetStateAction<boolean>>;
  showOperationColumnPicker: boolean;
  setShowOperationColumnPicker: React.Dispatch<React.SetStateAction<boolean>>;
  dragColRef: React.MutableRefObject<string | null>;
  allJobColumns: JobColumnDef[];
  allOperationColumns: JobColumnDef[];
  dynamicDbColumns: JobColumnDef[];
  orderedVisibleColumns: JobColumnDef[];
  saveColumnProfile: () => Promise<void>;
  toggleJobColumn: (key: string) => void;
  toggleOperationColumn: (key: string) => void;
  handleColDragStart: (key: string) => void;
  handleColDrop: (targetKey: string) => void;
  formatGridColumnValue: (record: Record<string, unknown>, key: string) => string;
  formatJobColumnValue: (job: Job, key: string) => string;
  formatOperationColumnValue: (op: Operation, key: string) => string;
}

interface Params {
  openJobs: Job[];
  userId?: string;
}

/**
 * Manages column visibility, ordering, drag-reorder, and profile
 * persistence for the Jobs grid and Operations sub-table.
 */
export function useColumnManager({ openJobs, userId }: Params): ColumnManagerResult {
  const jobPaneMode = useUiStore((s) => s.jobPaneMode);

  const [visibleJobColumns, setVisibleJobColumns] = useState<string[]>(
    DEFAULT_JOB_COLUMNS.map((c) => c.key)
  );
  const [visibleOperationColumns, setVisibleOperationColumns] = useState<string[]>(
    DEFAULT_OPERATION_COLUMNS.map((c) => c.key)
  );
  const [columnsInitialized, setColumnsInitialized] = useState(false);
  const [operationColumnsInitialized, setOperationColumnsInitialized] = useState(false);
  const [columnProfileName, setColumnProfileName] = useState('');
  const [profileSaving, setProfileSaving] = useState(false);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [showOperationColumnPicker, setShowOperationColumnPicker] = useState(false);
  const dragColRef = useRef<string | null>(null);

  // Derive dynamic columns from job data
  const dynamicDbColumns = useMemo<JobColumnDef[]>(() => {
    if (openJobs.length === 0) return [];
    const excluded = new Set([...DEFAULT_JOB_COLUMNS.map((c) => c.key), 'operations']);
    const keys = Array.from(
      new Set(
        openJobs
          .flatMap((job) => Object.keys(job as Record<string, unknown>))
          .filter((key) => !excluded.has(key))
      )
    ).sort((a, b) => a.localeCompare(b));
    return keys.map((key) => ({ key, label: key }));
  }, [openJobs]);

  const allJobColumns = useMemo(
    () => [...DEFAULT_JOB_COLUMNS, ...dynamicDbColumns],
    [dynamicDbColumns]
  );

  const dynamicOperationColumns = useMemo<JobColumnDef[]>(() => {
    const operations = openJobs.flatMap((job) => job.operations || []);
    if (operations.length === 0) return [];
    const excluded = new Set(DEFAULT_OPERATION_COLUMNS.map((c) => c.key));
    const keys = Array.from(
      new Set(
        operations
          .flatMap((op) => Object.keys(op as Record<string, unknown>))
          .filter((key) => !excluded.has(key))
      )
    ).sort((a, b) => a.localeCompare(b));
    return keys.map((key) => ({ key, label: key }));
  }, [openJobs]);

  const allOperationColumns = useMemo(
    () => [...DEFAULT_OPERATION_COLUMNS, ...dynamicOperationColumns],
    [dynamicOperationColumns]
  );

  const orderedVisibleColumns = useMemo((): JobColumnDef[] => {
    const colMap = new Map(allJobColumns.map((c) => [c.key, c]));
    return visibleJobColumns.map((key) => colMap.get(key)).filter((c): c is JobColumnDef => !!c);
  }, [allJobColumns, visibleJobColumns]);

  // Sync visible columns when the column list changes. Wait for the jobs:
  // columns that come from SYSPRO fields (e.g. Version) only exist once the
  // data is loaded, and filtering before that silently dropped them from a
  // saved column profile whenever the profile loaded first.
  useEffect(() => {
    if (allJobColumns.length === 0 || openJobs.length === 0) return;
    const availableKeys = new Set(allJobColumns.map((c) => c.key));
    setVisibleJobColumns((prev) => {
      const preferredKeys = (columnsInitialized ? prev : DEFAULT_JOB_COLUMNS.map((c) => c.key)).filter(
        (key) => availableKeys.has(key)
      );
      return preferredKeys.length
        ? preferredKeys
        : allJobColumns.slice(0, DEFAULT_JOB_COLUMNS.length).map((c) => c.key);
    });
    if (!columnsInitialized) setColumnsInitialized(true);
  }, [allJobColumns, columnsInitialized, openJobs.length]);

  useEffect(() => {
    if (allOperationColumns.length === 0 || openJobs.length === 0) return;
    const availableKeys = new Set(allOperationColumns.map((c) => c.key));
    setVisibleOperationColumns((prev) => {
      const preferredKeys = (
        operationColumnsInitialized ? prev : DEFAULT_OPERATION_COLUMNS.map((c) => c.key)
      ).filter((key) => availableKeys.has(key));
      return preferredKeys.length
        ? preferredKeys
        : allOperationColumns.slice(0, DEFAULT_OPERATION_COLUMNS.length).map((c) => c.key);
    });
    if (!operationColumnsInitialized) setOperationColumnsInitialized(true);
  }, [allOperationColumns, operationColumnsInitialized, openJobs.length]);

  // Close column pickers when the job pane mode changes
  useEffect(() => {
    setShowColumnPicker(false);
    setShowOperationColumnPicker(false);
  }, [jobPaneMode]);

  // Load saved column profile on login
  useEffect(() => {
    if (!userId) return;
    columnProfileService
      .get()
      .then((profile) => {
        if (profile.visibleJobColumns && profile.visibleJobColumns.length > 0) {
          setVisibleJobColumns(profile.visibleJobColumns);
          setColumnsInitialized(true);
        }
        if (profile.profileName) setColumnProfileName(profile.profileName);
      })
      .catch(() => {
        /* no profile yet — use defaults */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const saveColumnProfile = useCallback(async () => {
    setProfileSaving(true);
    try {
      await columnProfileService.save(visibleJobColumns, columnProfileName || undefined);
      toast.success(`Profile "${columnProfileName || 'Default'}" saved`);
    } catch {
      toast.error('Failed to save profile');
    } finally {
      setProfileSaving(false);
    }
  }, [visibleJobColumns, columnProfileName]);

  const toggleJobColumn = useCallback((key: string) => {
    setVisibleJobColumns((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev;
        return prev.filter((col) => col !== key);
      }
      return [...prev, key];
    });
  }, []);

  const toggleOperationColumn = useCallback((key: string) => {
    setVisibleOperationColumns((prev) => {
      if (prev.includes(key)) {
        if (prev.length === 1) return prev;
        return prev.filter((col) => col !== key);
      }
      return [...prev, key];
    });
  }, []);

  const handleColDragStart = useCallback((key: string) => {
    dragColRef.current = key;
  }, []);

  const handleColDrop = useCallback((targetKey: string) => {
    const src = dragColRef.current;
    if (!src || src === targetKey) return;
    setVisibleJobColumns((prev) => {
      const next = [...prev];
      const from = next.indexOf(src);
      const to = next.indexOf(targetKey);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, src);
      return next;
    });
  }, []);

  const formatGridColumnValue = useCallback(
    (record: Record<string, unknown>, key: string): string => {
      const value = record[key];
      if (value === null || value === undefined || value === '') return '-';
      if (key.toLowerCase().includes('date')) {
        const asDate = new Date(String(value));
        if (!Number.isNaN(asDate.getTime())) {
          return format(asDate, 'dd/MM/yyyy HH:mm');
        }
      }
      if (typeof value === 'number') return value.toLocaleString();
      if (typeof value === 'boolean') return value ? 'Yes' : 'No';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    },
    []
  );

  const formatJobColumnValue = useCallback(
    (job: Job, key: string) => formatGridColumnValue(job as Record<string, unknown>, key),
    [formatGridColumnValue]
  );

  const formatOperationColumnValue = useCallback(
    (op: Operation, key: string) => formatGridColumnValue(op as Record<string, unknown>, key),
    [formatGridColumnValue]
  );

  return {
    visibleJobColumns,
    setVisibleJobColumns,
    visibleOperationColumns,
    setVisibleOperationColumns,
    columnProfileName,
    setColumnProfileName,
    profileSaving,
    showColumnPicker,
    setShowColumnPicker,
    showOperationColumnPicker,
    setShowOperationColumnPicker,
    dragColRef,
    allJobColumns,
    allOperationColumns,
    dynamicDbColumns,
    orderedVisibleColumns,
    saveColumnProfile,
    toggleJobColumn,
    toggleOperationColumn,
    handleColDragStart,
    handleColDrop,
    formatGridColumnValue,
    formatJobColumnValue,
    formatOperationColumnValue,
  };
}
