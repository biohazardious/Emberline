import { useId } from 'react';

interface BrandLogoProps {
  size?: number;
  className?: string;
}

/**
 * Bespoke vector mark for Emberline AI Coding Factory:
 * combines a precision terminal chevron (`>`), an isometric molten ember core diamond,
 * and the glowing baseline (`_`).
 */
export function BrandLogo({ size = 24, className = 'brand-mark' }: BrandLogoProps) {
  const uid = useId().replace(/:/g, '');
  const bgId = `ember-bg-${uid}`;
  const strokeId = `ember-stroke-${uid}`;
  const flameId = `ember-flame-${uid}`;
  const lineId = `ember-line-${uid}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={bgId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#161923" />
          <stop offset="100%" stopColor="#090a0d" />
        </linearGradient>
        <linearGradient id={strokeId} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fb923c" stopOpacity="0.7" />
          <stop offset="50%" stopColor="#f97316" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#e11d48" stopOpacity="0.55" />
        </linearGradient>
        <linearGradient id={flameId} x1="6" y1="5" x2="26" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fde047" />
          <stop offset="38%" stopColor="#fb923c" />
          <stop offset="72%" stopColor="#f97316" />
          <stop offset="100%" stopColor="#e11d48" />
        </linearGradient>
        <linearGradient id={lineId} x1="8" y1="23" x2="25" y2="23" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fb923c" />
          <stop offset="100%" stopColor="#f43f5e" />
        </linearGradient>
      </defs>
      <rect
        x="1"
        y="1"
        width="30"
        height="30"
        rx="7"
        fill={`url(#${bgId})`}
        stroke={`url(#${strokeId})`}
        strokeWidth="1.25"
      />
      <circle cx="16" cy="15" r="9.5" fill="#f97316" fillOpacity="0.1" />
      <path
        d="M8.5 9.25L16.25 15.25L8.5 21.25"
        stroke={`url(#${flameId})`}
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M19.5 7.5L23.75 12.25L19.5 17L15.25 12.25L19.5 7.5Z" fill={`url(#${flameId})`} />
      <path d="M19.5 9.6L21.7 12.25L19.5 14.9L17.3 12.25L19.5 9.6Z" fill="#fff7ed" fillOpacity="0.92" />
      <rect x="16" y="20" width="8.5" height="2.6" rx="1.3" fill={`url(#${lineId})`} />
    </svg>
  );
}
