/**
 * In-app replacements for window.confirm / window.prompt / alert.
 *
 *   if (!(await confirmDialog({ message: 'Delete it?', danger: true }))) return;
 *   const name = await promptDialog({ message: 'Name', defaultValue: 'x' }); // null = cancelled
 *
 * The native dialogs block the whole page, can't be styled, ignore the theme
 * and are suppressed by some browsers after a few uses. <DialogHost /> is
 * mounted once at the root and shows one dialog at a time.
 */
import React, { useEffect, useRef, useState } from 'react';

interface BaseOptions {
  title?: string;
  /** Plain text; line breaks are kept. */
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Red confirm button (deletes, irreversible actions). */
  danger?: boolean;
}
export type ConfirmOptions = BaseOptions;
export interface PromptOptions extends BaseOptions { defaultValue?: string; placeholder?: string }
export type AlertOptions = Omit<BaseOptions, 'cancelLabel' | 'danger'>;

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void }
  | { kind: 'alert'; opts: AlertOptions; resolve: () => void };

let enqueue: ((r: Request) => void) | null = null;
const pending: Request[] = [];
const push = (r: Request) => (enqueue ? enqueue(r) : pending.push(r));

const asOpts = <T extends BaseOptions | AlertOptions>(o: T | string): T => (typeof o === 'string' ? ({ message: o } as T) : o);

export const confirmDialog = (o: ConfirmOptions | string): Promise<boolean> =>
  new Promise((resolve) => push({ kind: 'confirm', opts: asOpts(o), resolve }));

export const promptDialog = (o: PromptOptions | string): Promise<string | null> =>
  new Promise((resolve) => push({ kind: 'prompt', opts: asOpts(o), resolve }));

export const alertDialog = (o: AlertOptions | string): Promise<void> =>
  new Promise((resolve) => push({ kind: 'alert', opts: asOpts(o), resolve }));

const DialogHost: React.FC = () => {
  const [queue, setQueue] = useState<Request[]>([]);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    enqueue = (r) => setQueue((q) => [...q, r]);
    if (pending.length) setQueue((q) => [...q, ...pending.splice(0)]);
    return () => { enqueue = null; };
  }, []);

  const current = queue[0];

  useEffect(() => {
    if (!current) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setValue(current.kind === 'prompt' ? current.opts.defaultValue ?? '' : '');
    const t = window.setTimeout(() => {
      if (current.kind === 'prompt') { inputRef.current?.focus(); inputRef.current?.select(); } else okRef.current?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [current]);

  if (!current) return null;

  const close = (ok: boolean) => {
    if (current.kind === 'confirm') current.resolve(ok);
    else if (current.kind === 'prompt') current.resolve(ok ? value : null);
    else current.resolve();
    setQueue((q) => q.slice(1));
    restoreFocus.current?.focus?.();
  };

  const { opts } = current;
  const title = opts.title || (current.kind === 'alert' ? 'Notice' : 'Please confirm');
  const danger = current.kind !== 'alert' && (opts as BaseOptions).danger;
  const confirmLabel = opts.confirmLabel || (current.kind === 'alert' ? 'OK' : current.kind === 'prompt' ? 'OK' : 'Confirm');
  const cancelLabel = (opts as BaseOptions).cancelLabel || 'Cancel';
  const okDisabled = current.kind === 'prompt' && !value.trim();

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(false); }
    if (e.key === 'Tab') {
      // keep focus inside the dialog
      const nodes = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input, button:not([disabled])'));
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };

  return (
    <div className="crux-dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(false); }}>
      <div
        className="crux-dialog"
        role={current.kind === 'alert' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby="crux-dialog-title"
        aria-describedby="crux-dialog-message"
        onKeyDown={onKeyDown}
      >
        <h2 id="crux-dialog-title" className="crux-dialog-title">{title}</h2>
        <p id="crux-dialog-message" className="crux-dialog-message">{opts.message}</p>
        <form onSubmit={(e) => { e.preventDefault(); if (!okDisabled) close(true); }}>
          {current.kind === 'prompt' && (
            <input
              ref={inputRef}
              className="crux-dialog-input"
              value={value}
              placeholder={current.opts.placeholder}
              onChange={(e) => setValue(e.target.value)}
              aria-labelledby="crux-dialog-message"
            />
          )}
          <div className="crux-dialog-actions">
            {current.kind !== 'alert' && (
              <button type="button" className="crux-dialog-btn" onClick={() => close(false)}>{cancelLabel}</button>
            )}
            <button
              ref={okRef}
              type="submit"
              className={`crux-dialog-btn ${danger ? 'is-danger' : 'is-primary'}`}
              disabled={okDisabled}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default DialogHost;
