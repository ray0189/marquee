import { useId } from "react";
import { APP_NAME } from "../brand";

/** The mark: a charcoal app tile (like the app's surfaces) with a white play symbol and a soft accent glow.
 *  Same design as public/icon.svg. */
export function LogoMark({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, ""); // gradient ids must be unique when the mark appears more than once
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#26262d" />
          <stop offset="1" stopColor="#121216" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx="0.5" cy="1.05" r="0.75">
          <stop offset="0" stopColor="#9b8cff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#9b8cff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}t)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}g)`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="15.25" fill="none" stroke="#fff" strokeOpacity="0.12" strokeWidth="1.5" />
      <path d="M26.5 21.5 L44 32 L26.5 42.5 Z" fill="#f4f4f6" stroke="#f4f4f6" strokeWidth="6" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="font-display text-[21px] font-bold tracking-tight text-bone">{APP_NAME}</span>
    </span>
  );
}
