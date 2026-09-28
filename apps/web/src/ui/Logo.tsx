/** The مُنَسِّق / MONASIQ logo. `white` for dark or brand-coloured backgrounds. Decorative when its link already names it. */
export function Logo({ white, height = 36, className }: { white?: boolean; height?: number; className?: string }) {
  return <img src={white ? "/logo-white.png" : "/logo.png"} alt="مُنَسِّق" height={height} width={Math.round(height * 2.577)} className={["logo", className].filter(Boolean).join(" ")} />;
}
