import { APP_NAME } from "../brand";
import { LogoMark } from "../components/Logo";

export default function NoAccess() {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center gap-6 overflow-hidden px-6 text-center">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-white/[0.06] blur-[110px]" />
      <LogoMark size={72} />
      <h1 className="font-display text-4xl font-extrabold tracking-tight md:text-5xl">
        {APP_NAME} is invite-only
      </h1>
      <p className="max-w-md text-bone-dim">Open the personal link you were sent and you'll be let straight in. No account, no password. If yours stopped working, ask for a new one.</p>
    </div>
  );
}
