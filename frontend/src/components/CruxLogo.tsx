/**
 * CRUX APS logo — hollow outline "CRUX" (current text colour) with the lime
 * accent on the X stroke and "APS". Drawn as SVG so it is crisp at any size
 * and works on light and dark backgrounds (accent from --crux-accent).
 *
 *  variant="full"   — stacked: CRUX / ── APS ── / tagline (login page)
 *  variant="inline" — CRUX + APS side by side (app header)
 */
import React, { useId } from 'react';

interface Props {
  variant?: 'full' | 'inline';
  height?: number;
  className?: string;
  tagline?: string;
}

// Letter strokes on a 0..320 x 0..64 grid.
const LETTERS = [
  'M66 10 H22 Q10 10 10 22 V50 Q10 62 22 62 H66',                        // C
  'M88 62 V10 H136 Q148 10 148 22 V28 Q148 40 136 40 H88 M120 40 L150 62', // R
  'M170 10 V50 Q170 62 182 62 H218 Q230 62 230 50 V10',                  // U
  'M252 10 L306 62',                                                       // X (first stroke)
];
const X_ACCENT = 'M252 62 L318 0';

const CruxMark: React.FC<{ maskId: string }> = ({ maskId }) => (
  <>
    <defs>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="-8" width="330" height="80">
        <g fill="none" strokeLinecap="square" strokeLinejoin="miter">
          {LETTERS.map((d) => <path key={d} d={d} stroke="#fff" strokeWidth={9} />)}
          {LETTERS.map((d) => <path key={`i${d}`} d={d} stroke="#000" strokeWidth={4.2} />)}
        </g>
      </mask>
    </defs>
    <rect x="0" y="-8" width="330" height="80" fill="currentColor" mask={`url(#${maskId})`} />
    <path d={X_ACCENT} stroke="var(--crux-accent, #c5f23a)" strokeWidth={6} strokeLinecap="square" fill="none" />
  </>
);

const CruxLogo: React.FC<Props> = ({
  variant = 'full',
  height,
  className,
  tagline = 'ADVANCED PLANNING & SCHEDULING',
}) => {
  const maskId = `crux-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  if (variant === 'inline') {
    const h = height ?? 30;
    return (
      <svg className={className} viewBox="0 -10 430 84" height={h} role="img" aria-label="CRUX APS">
        <CruxMark maskId={maskId} />
        <text x="340" y="60" fill="var(--crux-accent, #c5f23a)" fontSize="40" fontWeight={500}
          letterSpacing="6" fontFamily="'Segoe UI', 'Inter', system-ui, sans-serif">APS</text>
      </svg>
    );
  }

  const h = height ?? 120;
  return (
    <svg className={className} viewBox="0 -10 330 150" height={h} role="img" aria-label="CRUX APS">
      <CruxMark maskId={maskId} />
      <g stroke="var(--crux-accent, #c5f23a)" strokeWidth={1.6}>
        <line x1="40" y1="94" x2="118" y2="94" />
        <line x1="212" y1="94" x2="290" y2="94" />
      </g>
      <text x="165" y="103" textAnchor="middle" fill="var(--crux-accent, #c5f23a)" fontSize="25" fontWeight={400}
        letterSpacing="11" fontFamily="'Segoe UI', 'Inter', system-ui, sans-serif" dx="5">APS</text>
      {tagline && (
        <text x="165" y="132" textAnchor="middle" fill="var(--crux-accent, #c5f23a)" fontSize="9.6"
          letterSpacing="2.4" fontFamily="'Segoe UI', 'Inter', system-ui, sans-serif">{tagline}</text>
      )}
    </svg>
  );
};

export default CruxLogo;
