/**
 * AppHeader — top navigation bar for Ascend APS.
 *
 * Extracted from App.tsx as part of #42 (phased App.tsx split, phase a).
 * Receives only the props it truly needs; everything else stays in App.tsx
 * until future phases migrate it.
 */
import React from 'react';
import { Sun, Moon, HelpCircle, RefreshCw } from 'lucide-react';

export interface DbStatus {
  sysproConnected: boolean;
  schedulerConnected: boolean;
  readOnly: boolean;
  message: string;
}

interface Props {
  isDarkMode: boolean;
  toggleDarkMode: () => void;
  onOpenUserGuide: (section?: 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts') => void;
  dbStatus: DbStatus;
  dataWarning: string | null;
}

const AppHeader: React.FC<Props> = ({
  isDarkMode,
  toggleDarkMode,
  onOpenUserGuide,
  dbStatus,
  dataWarning,
}) => (
  <header className="app-header">
    <div className="header-content">
      <div className="header-title">
        <div className="brand-lockup" aria-label="Ascend APS">
          <div className="brand-icon" />
          <div className="brand-text">
            <span className="brand-ascend">Ascend</span>
            <span className="brand-aps">APS</span>
          </div>
        </div>
      </div>
      <div className="header-controls">
        <button
          className="btn btn-icon"
          onClick={toggleDarkMode}
          title="Toggle dark mode (Ctrl+Shift+D)"
          aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
        </button>
        <button
          className="btn btn-icon"
          onClick={() => onOpenUserGuide('overview')}
          title="Show help"
          aria-label="Show help"
        >
          <HelpCircle size={16} />
        </button>
        <button
          className="btn btn-info"
          onClick={() => window.location.reload()}
          title="Reload application"
        >
          <RefreshCw size={14} aria-hidden="true" />
          <span style={{ marginLeft: 6 }}>Refresh</span>
        </button>
      </div>
    </div>
    {(dbStatus.readOnly || dataWarning) && (
      <div className={`status-banner ${dbStatus.readOnly ? 'status-warning' : 'status-info'}`}>
        <strong>{dbStatus.readOnly ? 'Read-only mode:' : 'Info:'}</strong>{' '}
        {dbStatus.message || dataWarning || 'Scheduled planning is available after SQL connection is restored.'}
      </div>
    )}
  </header>
);

export default AppHeader;
