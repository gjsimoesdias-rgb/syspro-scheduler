/**
 * Export utilities for PDF, Excel, and CSV
 */

import { Schedule } from '../types';
import Papa from 'papaparse';

/**
 * Create a Blob URL, trigger download, then revoke the URL to prevent
 * memory leaks (browsers don't GC Blob URLs automatically).
 */
function triggerDownload(blob: Blob, fileName: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoke asynchronously so the browser has time to initiate the download
  setTimeout(() => window.URL.revokeObjectURL(url), 100);
}

export const exportToPDF = async (schedule: Schedule, fileName = 'schedule.pdf'): Promise<void> => {
  await downloadScheduleReport(schedule);
  // fileName param kept for API compatibility
  void fileName;
};

export const exportToCSV = (schedule: Schedule, fileName = 'schedule.csv'): void => {
  const header = ['Job ID', 'Operation ID', 'Workcentre', 'Resource', 'Start Date', 'End Date', 'Duration (hrs)', 'Overtime', 'Status'];

  const dataRows: unknown[][] = [];
  schedule.jobSchedules.forEach((job) => {
    job.operationSchedules.forEach((op) => {
      dataRows.push([
        job.jobId,
        op.opId,
        op.workcentreId,
        op.resourceId,
        op.plannedStartDate.toISOString().split('T')[0],
        op.plannedEndDate.toISOString().split('T')[0],
        (op.duration / 60).toFixed(2),
        op.isOvertimeSlot ? 'Yes' : 'No',
        'Scheduled',
      ]);
    });
  });

  const csv = Papa.unparse({ fields: header, data: dataRows });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, fileName);
};

export const exportToJSON = (schedule: Schedule, fileName = 'schedule.json'): void => {
  const json = JSON.stringify(schedule, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, fileName);
};

/**
 * PDF report. jsPDF (+ html2canvas, ~550 kB) is loaded only when a report is
 * actually made, so it isn't part of the app's start-up download.
 */
export const downloadScheduleReport = async (schedule: Schedule): Promise<void> => {
  const [{ default: jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const dateStr = new Date().toLocaleDateString();
  const fileName = `schedule-report-${new Date().toISOString().split('T')[0]}.pdf`;

  // --- Title ---
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Production Schedule Report', 14, 16);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${dateStr}`, 14, 23);

  // --- KPI summary ---
  const kpiHeaders = [['Total Jobs', 'On Time', 'Tardy', 'Avg Tardiness (d)', 'Utilisation %', 'Overtime (h)']];
  const kpiRow = [
    String(schedule.jobSchedules.length),
    String(schedule.metrics.jobsOnTime),
    String(schedule.metrics.jobsTardy),
    schedule.metrics.averageTardiness.toFixed(2),
    schedule.metrics.resourceUtilization.toFixed(1),
    schedule.metrics.overtimeHours.toFixed(1),
  ];
  autoTable(doc, {
    head: kpiHeaders,
    body: [kpiRow],
    startY: 28,
    styles: { fontSize: 9 },
    headStyles: { fillColor: [102, 126, 234] },
  });

  // --- Job schedule table ---
  const jobY = (doc as typeof doc & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 50;
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text('Job Schedule', 14, jobY + 8);

  const jobHeaders = [['Job ID', 'Start Date', 'End Date', 'Tardiness (d)', 'Status']];
  const jobRows = schedule.jobSchedules.map((job) => [
    job.jobId,
    new Date(job.plannedStartDate).toLocaleDateString(),
    new Date(job.plannedEndDate).toLocaleDateString(),
    job.estimatedTardiness.toFixed(2),
    job.status,
  ]);
  autoTable(doc, {
    head: jobHeaders,
    body: jobRows,
    startY: jobY + 12,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [102, 126, 234] },
    didParseCell: (data) => {
      if (data.section === 'body' && data.column.index === 4) {
        const status = String(data.cell.raw ?? '');
        if (status === 'ConstraintViolation') data.cell.styles.textColor = [239, 68, 68];
        else if (status === 'Unschedulable') data.cell.styles.textColor = [107, 114, 128];
      }
    },
  });

  // --- Constraint violations table (if any) ---
  if (schedule.constraintViolations.length > 0) {
    const cvY = (doc as typeof doc & { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 100;
    // Add a new page if we're near the bottom
    if (cvY > 170) doc.addPage();
    const cvStartY = cvY > 170 ? 16 : cvY + 8;
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('Constraint Violations', 14, cvStartY);

    const cvHeaders = [['Type', 'Severity', 'Description', 'Job', 'Operation']];
    const cvRows = schedule.constraintViolations.map((v) => [
      v.type,
      v.severity,
      v.description,
      v.affectedJobId ?? '',
      v.affectedOperationId ?? '',
    ]);
    autoTable(doc, {
      head: cvHeaders,
      body: cvRows,
      startY: cvStartY + 4,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [239, 68, 68] },
    });
  }

  doc.save(fileName);
};

const exportService = {
  exportToPDF,
  exportToCSV,
  exportToJSON,
  downloadScheduleReport,
};

export default exportService;
