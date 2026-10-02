import type { CSSProperties } from 'react';

/**
 * Inline CSS custom properties (e.g. { '--mk': '#e11' }). React's style type
 * doesn't know custom properties, so this is the one typed place they go in.
 */
export const cssVars = (vars: Record<`--${string}`, string | number | undefined>): CSSProperties =>
  vars as CSSProperties;
