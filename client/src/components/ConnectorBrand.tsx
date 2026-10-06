/**
 * Logomarcas dos canais do Hub Omnichannel.
 *
 * São SVGs VETORIAIS vendorizados no próprio bundle — "alta definição"
 * de verdade (nitidez em qualquer densidade de tela, de 24px a 256px) e
 * sem dependência de CDN externo: o painel do ERP continua íntegro
 * atrás de firewall corporativo, offline (PWA) e sob CSP restrita.
 *
 * Cada marca usa a paleta oficial do canal:
 *   • Mercado Livre — amarelo #FFE600 sobre azul institucional #2D3277;
 *   • Mercado Pago  — azul #00B1EA com o aperto de mão em branco;
 *   • Nuvemshop     — nuvem branca sobre o gradiente azul/violeta;
 *   • Instagram     — glifo da câmera sobre o gradiente oficial da Meta.
 */
import type { CSSProperties } from 'react';

export type ConnectorBrandId = 'MERCADOLIVRE' | 'MERCADOPAGO' | 'NUVEMSHOP' | 'INSTAGRAM';

type BrandProps = {
  /** Classe aplicada ao <svg> (controle de tamanho: h-12 w-12 etc.). */
  className?: string;
  style?: CSSProperties;
};

/** Aperto de mão do Mercado Livre/Mercado Pago, em uma única curva. */
function Handshake({ fill }: { fill: string }) {
  return (
    <g fill={fill}>
      <path d="M24 17.6c-2.6-1.9-5.4-2.6-8.3-1.9-1 .2-1.8.7-2.6 1.3l-4.4 3.5a1.5 1.5 0 0 0-.4 1.9l1.9 3.4c.3.6 1.1.8 1.7.4l2.6-1.7 4.6 4.1c.5.5 1.3.5 1.8.1l.5-.4 2.1 1.9c.6.5 1.4.5 1.9 0l.5-.5 1.6 1.4c.6.5 1.5.4 2-.2l.4-.5 1 .8c.6.5 1.6.4 2.1-.3l3.3-4.3c.4-.5.4-1.2 0-1.7l-5-6.1c-.8-1-1.9-1.6-3.1-1.8-1.5-.3-3-.1-4.4.6z" />
      <path d="M22.2 20.3c-1.6 1.2-3 2.3-4.3 3.3a1.6 1.6 0 0 0 1.9 2.6l3.8-2.8c.7-.5 1.7-.4 2.3.2l.9.9a1.3 1.3 0 0 0 1.9-1.7l-2.5-2.6a2.6 2.6 0 0 0-3.1-.4z" opacity=".55" />
    </g>
  );
}

function MercadoLivreMark({ className, style }: BrandProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} style={style} role="img" aria-label="Mercado Livre" focusable="false">
      <rect width="48" height="48" rx="12" fill="#FFE600" />
      <ellipse cx="24" cy="24" rx="17" ry="12.5" fill="#FFF04C" />
      <Handshake fill="#2D3277" />
    </svg>
  );
}

function MercadoPagoMark({ className, style }: BrandProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} style={style} role="img" aria-label="Mercado Pago" focusable="false">
      <rect width="48" height="48" rx="12" fill="#00B1EA" />
      <ellipse cx="24" cy="24" rx="17" ry="12.5" fill="#2ACBFF" />
      <Handshake fill="#FFFFFF" />
    </svg>
  );
}

function NuvemshopMark({ className, style }: BrandProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} style={style} role="img" aria-label="Nuvemshop" focusable="false">
      <defs>
        <linearGradient id="brobond-nuvemshop" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2D7BFF" />
          <stop offset="100%" stopColor="#7A5CFF" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#brobond-nuvemshop)" />
      <path
        fill="#FFFFFF"
        d="M33.3 32.5H16.6a7.1 7.1 0 0 1-1-14.1 8.6 8.6 0 0 1 16.1-1 6.3 6.3 0 0 1 1.6 12.4zm-16.7-3h16.5a3.3 3.3 0 0 0 .3-6.6l-2.2-.2-.3-2.2a5.6 5.6 0 0 0-10.7-1l-.6 1.8-1.9.2a4.1 4.1 0 0 0 .4 8.2z"
      />
      <circle cx="24" cy="36" r="2.1" fill="#FFFFFF" opacity=".85" />
    </svg>
  );
}

function InstagramMark({ className, style }: BrandProps) {
  return (
    <svg viewBox="0 0 48 48" className={className} style={style} role="img" aria-label="Instagram Shopping" focusable="false">
      <defs>
        <radialGradient id="brobond-ig" cx="30%" cy="107%" r="150%">
          <stop offset="0%" stopColor="#FDF497" />
          <stop offset="25%" stopColor="#FDF497" />
          <stop offset="45%" stopColor="#FD5949" />
          <stop offset="65%" stopColor="#D6249F" />
          <stop offset="100%" stopColor="#285AEB" />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#brobond-ig)" />
      <rect x="12" y="12" width="24" height="24" rx="7" fill="none" stroke="#FFFFFF" strokeWidth="2.6" />
      <circle cx="24" cy="24" r="6" fill="none" stroke="#FFFFFF" strokeWidth="2.6" />
      <circle cx="31.4" cy="16.6" r="1.7" fill="#FFFFFF" />
    </svg>
  );
}

const MARKS: Record<ConnectorBrandId, (props: BrandProps) => JSX.Element> = {
  MERCADOLIVRE: MercadoLivreMark,
  MERCADOPAGO: MercadoPagoMark,
  NUVEMSHOP: NuvemshopMark,
  INSTAGRAM: InstagramMark,
};

/** Nome comercial exibido ao lado da marca. */
export const CONNECTOR_BRAND_LABELS: Record<ConnectorBrandId, string> = {
  MERCADOLIVRE: 'Mercado Livre',
  MERCADOPAGO: 'Mercado Pago',
  NUVEMSHOP: 'Nuvemshop',
  INSTAGRAM: 'Instagram Shopping',
};

export function isConnectorBrandId(value: unknown): value is ConnectorBrandId {
  return typeof value === 'string' && value in MARKS;
}

/**
 * Logomarca oficial de um canal. `brand` desconhecido devolve `null` —
 * a página cai no ícone genérico do módulo sem quebrar o render.
 */
export default function ConnectorBrand({ brand, className = 'h-12 w-12', style }: BrandProps & { brand: string }) {
  if (!isConnectorBrandId(brand)) return null;
  const Mark = MARKS[brand];
  return <Mark className={className} style={style} />;
}
