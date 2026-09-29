/**
 * ShortcutsHelpModal — keyboard shortcuts overlay.
 *
 * Extracted from App.tsx as part of S4.3 (phase a of #42 App.tsx split).
 * Reads `showShortcutsHelp` / `setShowShortcutsHelp` from uiStore — zero props needed.
 */
import React from 'react';
import { Keyboard } from 'lucide-react';
import { useUiStore } from '../stores/uiStore';

const SHORTCUTS = [
  { keys: 'Ctrl + Enter',       label: 'Generate Schedule' },
  { keys: 'Ctrl + Shift + E',   label: 'Export Schedule' },
  { keys: 'Ctrl + Z',           label: 'Undo' },
  { keys: 'Ctrl + Shift + Z',   label: 'Redo' },
  { keys: 'Ctrl + Shift + D',   label: 'Toggle Dark Mode' },
  { keys: '?',                  label: 'Open User Guide' },
  { keys: 'Alt + ←',            label: 'Nudge highlighted job −1 hour' },
  { keys: 'Alt + →',            label: 'Nudge highlighted job +1 hour' },
] as const;

const ShortcutsHelpModal: React.FC = () => {
  const showShortcutsHelp    = useUiStore((s) => s.showShortcutsHelp);
  const setShowShortcutsHelp = useUiStore((s) => s.setShowShortcutsHelp);

  if (!showShortcutsHelp) return null;

  return (
    <div className="modal-overlay" onClick={() => setShowShortcutsHelp(false)}>
      <div
        className="shortcuts-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>
            <Keyboard size={16} style={{ verticalAlign: 'middle', marginRight: 6 }} aria-hidden="true" />
            Keyboard Shortcuts
          </h3>
          <button className="close-btn" onClick={() => setShowShortcutsHelp(false)}>✕</button>
        </div>
        <div className="shortcuts-list">
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={keys} className="shortcut-item">
              <kbd>{keys}</kbd>
              <span>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default ShortcutsHelpModal;
