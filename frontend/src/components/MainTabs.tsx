/**
 * MainTabs — the top-level ribbon tab-selector bar (FILE | HOME | MANAGE …).
 *
 * Extracted from App.tsx as part of S4.3 (phase a of #42 App.tsx split).
 * Reads `mainTab` / `setMainTab` directly from uiStore — zero props needed.
 */
import React from 'react';
import { useUiStore, MAIN_TABS } from '../stores/uiStore';

/** Display labels for each tab value. */
const TAB_LABELS: Record<typeof MAIN_TABS[number], string> = {
  file:     'FILE',
  home:     'HOME',
  manage:   'MANAGE',
  schedule: 'SCHEDULE',
  review:   'REVIEW',
  reports:  'REPORTS',
  view:     'VIEW',
  workflow: 'WORKFLOW',
};

const MainTabs: React.FC = () => {
  const mainTab    = useUiStore((s) => s.mainTab);
  const setMainTab = useUiStore((s) => s.setMainTab);

  return (
    <section className="aps-main-tabs">
      {MAIN_TABS.map((tab) => (
        <button
          key={tab}
          className={`aps-main-tab ${mainTab === tab ? 'active' : ''}`}
          onClick={() => setMainTab(tab)}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </section>
  );
};

export default MainTabs;
