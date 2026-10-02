/**
 * Dark mode context — S4.1: delegates to uiStore so dark mode is a single
 * source of truth. DarkModeProvider is kept as a pass-through so that
 * existing consumers of useDarkMode() continue to work unchanged.
 */

import React from 'react';
import { useUiStore } from '../stores/uiStore';

/** Pass-through provider — dark mode state now lives in uiStore. */
export const DarkModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <>{children}</>
);

export const useDarkMode = () => {
  // Read from uiStore so that both useDarkMode() and useUiStore(s => s.isDarkMode)
  // return the same value and stay in sync.
  const isDarkMode = useUiStore((s) => s.isDarkMode);
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode);
  return { isDarkMode, toggleDarkMode };
};

export default DarkModeProvider;
