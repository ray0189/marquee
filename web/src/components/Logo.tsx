import { APP_NAME } from "../brand";

/** The mark: a marquee frame with chaser bulbs. */
export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <rect x="9" y="17" width="46" height="30" rx="4" fill="none" stroke="#f4f4f6" strokeWidth="3" />
      {[16, 26, 36, 46].map((x, i) => (
        <g key={x} className="animate-bulb" style={{ animationDelay: `${i * 0.3}s` }}>
          <circle cx={x} cy="11" r="2.4" fill="#9b8cff" />
          <circle cx={x} cy="53" r="2.4" fill="#9b8cff" />
        </g>
      ))}
      <path d="M28 25.5v13l11-6.5z" fill="#f4f4f6" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="font-display text-[21px] font-bold tracking-tight text-bone">
        {APP_NAME}
      </span>
    </span>
  );
}
