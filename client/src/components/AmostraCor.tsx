// ============================================================================
// AMOSTRA VISUAL DA COR
//
// Um único componente para TODA amostra de cor do ERP: linha da listagem,
// cartão do modo visual e prévia do cadastro. Regras:
//   • respeita o HEX real (nunca aproxima nem inventa cor);
//   • tamanho consistente entre linhas (a tabela não "pula");
//   • borda neutra — indispensável para branco/off-white e cores claras;
//   • acessível: a cor nunca é a única informação. O nome e o HEX aparecem nas
//     colunas vizinhas e a amostra tem rótulo próprio (role="img" + aria-label);
//   • HEX ausente ou inválido vira uma hachura neutra — sem cor falsa.
// ============================================================================
import { corSegura } from '../lib/hex';

export type AmostraTamanho = 'sm' | 'md' | 'lg';

const DIMENSAO: Record<AmostraTamanho, string> = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
  lg: 'h-12 w-full',
};

const HACHURA = 'repeating-linear-gradient(45deg, rgb(var(--line)) 0 6px, rgb(var(--surface)) 6px 12px)';

export function AmostraCor({
  hex,
  nome,
  tamanho = 'sm',
  className = '',
}: {
  /** Código hexadecimal do registro (pode vir vazio ou inválido). */
  hex?: string | null;
  /** Nome da cor — entra no rótulo acessível. */
  nome?: string | null;
  tamanho?: AmostraTamanho;
  className?: string;
}) {
  const cor = corSegura(hex);
  const alvo = nome ? ` da cor ${nome}` : ' da cor';
  const rotulo = cor ? `Amostra${alvo}: ${cor}` : `Amostra${alvo}: sem código HEX`;

  return (
    <span
      role="img"
      aria-label={rotulo}
      title={rotulo}
      className={`inline-block shrink-0 rounded-md border border-slate-300 shadow-inner dark:border-navy-600 ${DIMENSAO[tamanho]} ${className}`}
      style={
        cor
          ? { backgroundColor: cor }
          : { backgroundImage: HACHURA }
      }
    />
  );
}
