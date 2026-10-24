import { useId } from 'react';

/*
 * The selo brilhante as a real award seal (owner request 28/09/2026): a scalloped gold rosette with
 * a stitched inner ring, a raised star and two ribbon tails. Pure SVG, so it stays crisp at any size;
 * a soft light crosses it now and then, clipped to the rosette.
 */
const CENTER_X = 16;
const CENTER_Y = 15;
const SCALLOPS = 16;
// Alternating outer/inner radii give the scalloped edge.
const ROSETTE_POINTS = Array.from({ length: SCALLOPS * 2 }, (_, index) => {
  const angle = (Math.PI * index) / SCALLOPS - Math.PI / 2;
  const radius = index % 2 === 0 ? 14.6 : 12.6;
  return `${(CENTER_X + radius * Math.cos(angle)).toFixed(2)},${(CENTER_Y + radius * Math.sin(angle)).toFixed(2)}`;
}).join(' ');
// Five-point star, outer radius 5.6.
const STAR_POINTS = Array.from({ length: 10 }, (_, index) => {
  const angle = (Math.PI * index) / 5 - Math.PI / 2;
  const radius = index % 2 === 0 ? 5.6 : 2.4;
  return `${(CENTER_X + radius * Math.cos(angle)).toFixed(2)},${(CENTER_Y + radius * Math.sin(angle)).toFixed(2)}`;
}).join(' ');

export function BrilliantSealBadgeV1({ label = 'Selo Brilhante' }: Readonly<{ label?: string }>) {
  const id = useId().replaceAll(':', '');
  const gold = `${id}-gold`;
  const face = `${id}-face`;
  const edge = `${id}-edge`;
  return (
    <span className="pa-seal" role="img" aria-label={label}>
      <svg viewBox="0 0 32 38" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gold} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fde9b5" />
            <stop offset="0.45" stopColor="#f5b94a" />
            <stop offset="1" stopColor="#c9821a" />
          </linearGradient>
          <radialGradient id={face} cx="0.38" cy="0.32" r="0.8">
            <stop offset="0" stopColor="#fff6dc" />
            <stop offset="0.55" stopColor="#fbd27f" />
            <stop offset="1" stopColor="#e9a53a" />
          </radialGradient>
          <clipPath id={edge}>
            <polygon points={ROSETTE_POINTS} />
          </clipPath>
        </defs>
        {/* Ribbon tails, behind the rosette. */}
        <path d="M10.2 24.5 L7.4 36.6 L10.9 34.6 L13.2 37.6 L15.4 26.4 Z" fill="#b8741a" />
        <path d="M21.8 24.5 L24.6 36.6 L21.1 34.6 L18.8 37.6 L16.6 26.4 Z" fill="#d38b1f" />
        <polygon points={ROSETTE_POINTS} fill={`url(#${gold})`} stroke="#a7661a" strokeWidth="0.6" strokeLinejoin="round" />
        <circle cx={CENTER_X} cy={CENTER_Y} r="9.6" fill={`url(#${face})`} stroke="#a7661a" strokeWidth="0.7" />
        {/* Stitched ring, like a stamped seal. */}
        <circle
          cx={CENTER_X}
          cy={CENTER_Y}
          r="8.1"
          fill="none"
          stroke="#fff8e6"
          strokeWidth="0.7"
          strokeDasharray="1.1 1.1"
          opacity="0.9"
        />
        {/* Raised star: a light offset under a darker star. */}
        <polygon points={STAR_POINTS} fill="#fff3d0" transform="translate(0.45 0.55)" opacity="0.8" />
        <polygon points={STAR_POINTS} fill="#8a510d" />
        <g clipPath={`url(#${edge})`}>
          <rect className="pa-seal-shine" x="-12" y="-4" width="8" height="40" fill="#fff" opacity="0.55" transform="rotate(20 16 15)" />
        </g>
      </svg>
    </span>
  );
}
