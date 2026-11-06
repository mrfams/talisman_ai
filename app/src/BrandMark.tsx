/** The mark: a compass-talisman, drawn rather than a gradient square. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden
      style={{ color: "var(--accent)", flex: "none" }}
    >
      <path
        d="M12 2.75 21.25 12 12 21.25 2.75 12Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M12 7.4 16.6 12 12 16.6 7.4 12Z" fill="currentColor" opacity="0.9" />
      <circle cx="12" cy="12" r="1.5" fill="var(--canvas-2)" />
      <circle cx="12" cy="4.2" r="0.9" fill="var(--mint)" />
    </svg>
  );
}
