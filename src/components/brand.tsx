/**
 * The SAF logo mark (transparent PNG, 738x363).
 * tone="dark"  - navy + teal, for light backgrounds.
 * tone="light" - white + bright teal, for the navy sidebar / dark panels.
 * Size it with a height class; the width follows the aspect ratio.
 */
export function SafLogo({ tone = "dark", className = "h-8", decorative = false }: { tone?: "dark" | "light"; className?: string; decorative?: boolean }) {
  return (
    <img
      src={tone === "light" ? "/brand/saf-logo-light.png" : "/brand/saf-logo.png"}
      alt={decorative ? "" : "SAF"}
      width={738}
      height={363}
      className={`${className} w-auto shrink-0 select-none`}
      draggable={false}
    />
  );
}
