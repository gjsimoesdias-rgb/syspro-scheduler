/**
 * Grid → CSV for Excel. UTF-8 with BOM so Excel keeps accents; values are
 * quoted when they contain separators, quotes or line breaks, and a leading
 * =, +, - or @ is prefixed with ' so Excel never evaluates a cell as a formula.
 */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const cell = (v: unknown): string => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
