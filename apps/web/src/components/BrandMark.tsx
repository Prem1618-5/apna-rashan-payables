/** The app icon as an inline SVG (no extra request). */
export function BrandMark({ size = 40, className = "" }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" className={className} aria-hidden>
      <rect width="512" height="512" rx="112" fill="var(--brand)" />
      <path d="M150 128a24 24 0 0 1 24-24h164a24 24 0 0 1 24 24v280l-35.33-24-35.33 24-35.33-24-35.34 24-35.33-24-35.33 24z" fill="var(--brand-ink)" />
      <rect x="190" y="156" width="132" height="22" rx="11" fill="var(--brand)" opacity=".22" />
      <rect x="190" y="198" width="88" height="22" rx="11" fill="var(--brand)" opacity=".22" />
      <path d="M194 290l42 42 82-86" fill="none" stroke="var(--brand)" strokeWidth="32" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
