import { useState } from 'react';

type Variant = 'dark' | 'light';

/**
 * Logotipo BROBOND.
 *  - variant="dark": marca em carvão/âmbar para fundos claros (/logo.png)
 *  - variant="light": marca em branco/âmbar para fundos escuros (/logo-light.png)
 * Se a imagem não carregar, cai no wordmark em texto com as cores da marca.
 */
export function Logo({
  variant = 'dark',
  className = '',
  height = 36,
  withTagline = true,
}: {
  variant?: Variant;
  className?: string;
  height?: number;
  withTagline?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = withTagline
    ? variant === 'light'
      ? '/logo-light.png'
      : '/logo.png'
    : variant === 'light'
      ? '/logo-word-light.png'
      : '/logo-word.png';

  if (failed) return <Wordmark variant={variant} className={className} />;

  return (
    <img
      src={src}
      alt="BROBOND"
      style={{ height }}
      className={`w-auto select-none object-contain ${className}`}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}

/** Wordmark em texto (fallback e uso compacto). */
export function Wordmark({ variant = 'dark', className = '' }: { variant?: Variant; className?: string }) {
  const base = variant === 'light' ? 'text-white' : 'text-charcoal';
  return (
    <span className={`inline-flex items-baseline font-extrabold tracking-[0.18em] ${base} ${className}`}>
      <span className="text-brand-500">B</span>RO<span className="text-brand-500">B</span>OND
    </span>
  );
}

/** Símbolo "B" quadrado (menu recolhido, favicon). */
export function LogoMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        style={{ width: size, height: size }}
        className={`inline-flex items-center justify-center rounded-lg bg-brand-500 font-black text-white ${className}`}
      >
        B
      </span>
    );
  }
  return (
    <img
      src="/logo-mark.png"
      alt="B"
      width={size}
      height={size}
      className={`select-none object-contain ${className}`}
      onError={() => setFailed(true)}
      draggable={false}
    />
  );
}
