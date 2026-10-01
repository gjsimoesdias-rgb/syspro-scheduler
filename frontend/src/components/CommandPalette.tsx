/**
 * Command palette (LYNQ "Type a menu item"): Ctrl+K / ⌘K, type to find any
 * view, manage screen or action, Enter to run it. Matching is by words in
 * any order, so "mach an" finds "Analyse › Machines".
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  label: string;
  group: string;
  keywords?: string;
  hint?: string;
  disabled?: boolean;
  run: () => void;
}

/** Score a command for a query: every word must match; earlier/label matches rank higher. */
export function scoreCommand(cmd: Pick<PaletteCommand, 'label' | 'group' | 'keywords'>, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const label = cmd.label.toLowerCase();
  const hay = `${label} ${cmd.group.toLowerCase()} ${(cmd.keywords || '').toLowerCase()}`;
  let score = 0;
  for (const w of q.split(/\s+/)) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    const inLabel = label.indexOf(w);
    score += inLabel === 0 ? 30 : inLabel > 0 ? (/\s/.test(label[inLabel - 1]) ? 20 : 10) : 5;
  }
  return score;
}

const CommandPalette: React.FC<{ open: boolean; onClose: () => void; commands: PaletteCommand[] }> = ({ open, onClose, commands }) => {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) { setQuery(''); setActive(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  const results = useMemo(() => commands
    .map((c, i) => ({ c, i, s: scoreCommand(c, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, 50)
    .map((x) => x.c), [commands, query]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const run = (c?: PaletteCommand) => {
    if (!c || c.disabled) return;
    onClose();
    setTimeout(c.run, 0);
  };

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Go to a menu item" onMouseDown={(e) => e.stopPropagation()}>
        <div className="cmdk-input-row">
          <Search size={15} className="ui-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk-input"
            placeholder="Type a menu item…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            role="combobox"
            aria-expanded="true"
            aria-controls="cmdk-list"
            aria-activedescendant={results[active] ? `cmdk-${results[active].id}` : undefined}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); run(results[active]); }
              else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul id="cmdk-list" className="cmdk-list" role="listbox" ref={listRef}>
          {results.map((c, i) => (
            <li
              key={c.id}
              id={`cmdk-${c.id}`}
              data-idx={i}
              role="option"
              aria-selected={i === active}
              aria-disabled={c.disabled || undefined}
              className={`cmdk-item${i === active ? ' is-active' : ''}${c.disabled ? ' is-disabled' : ''}`}
              onMouseMove={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="cmdk-group">{c.group}</span>
              <span className="cmdk-label">{c.label}</span>
              {c.hint && <kbd className="cmdk-hint">{c.hint}</kbd>}
            </li>
          ))}
          {results.length === 0 && <li className="cmdk-empty">No menu item matches “{query}”.</li>}
        </ul>
      </div>
    </div>
  );
};

export default CommandPalette;
