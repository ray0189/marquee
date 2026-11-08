import { useId } from "react";
import { APP_NAME } from "../brand";

/** The mark: a purple app tile with a rounded play symbol. Same design as public/icon.svg. */
export function LogoMark({ size = 30 }: { size?: number }) {
  const id = useId().replace(/:/g, ""); // gradient ids must be unique when the mark appears more than once
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden className="shrink-0">
      <defs>
        <linearGradient id={`${id}g`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b9adff" />
          <stop offset="1" stopColor="#6551ee" />
        </linearGradient>
        <radialGradient id={`${id}h`} cx="0.25" cy="0.12" r="0.85">
          <stop offset="0" stopColor="#fff" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="64" height="64" rx="16" fill={`url(#${id}g)`} />
      <rect width="64" height="64" rx="16" fill={`url(#${id}h)`} />
      <rect x="0.75" y="0.75" width="62.5" height="62.5" rx="15.25" fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1.5" />
      <path d="M26.5 21.5 L44 32 L26.5 42.5 Z" fill="#fff" stroke="#fff" strokeWidth="6" strokeLinejoin="round" />
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
