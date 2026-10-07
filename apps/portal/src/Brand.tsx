export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand eduson-brand">
      <span className="brand-mark">
        <img
          src="/brand/richie-space-v1.webp"
          srcSet="/brand/richie-space-128-v1.webp 128w, /brand/richie-space-256-v1.webp 256w"
          sizes="52px"
          alt="Ричи в скафандре"
          width={52}
          height={52}
          decoding="async"
        />
      </span>
      {!compact && (
        <span className="brand-wordmark">
          Eduson <span className="brand-kids">Kids</span>
        </span>
      )}
    </div>
  );
}
