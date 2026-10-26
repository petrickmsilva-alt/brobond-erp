// ============================================================================
// VALORES DAS CÉLULAS DA LISTAGEM
//
// Um único lugar decide como cada tipo de campo aparece na tabela, nos cartões
// e na lista compacta: texto truncado com tooltip, badge de status, amostra de
// cor, valor monetário alinhado à direita. A listagem em si só posiciona.
// ============================================================================
import { AlertTriangle, Camera, CheckCircle2, CircleDashed, XCircle } from 'lucide-react';
import type { Field, ResourceMeta } from '../lib/meta';
import { formatCell } from '../lib/format';
import { corSegura } from '../lib/hex';
import { ColorDot } from './ImageField';
import { AmostraCor } from './AmostraCor';
import { Badge } from './ui';
import {
  campoDaAmostra,
  estoqueMinimoDaLinha,
  larguraDaColuna,
  saldoDaLinha,
  statusMedidasDaLinha,
  temUtilizacao,
} from '../lib/lista';

/** Texto de identificação da linha (ex.: "CAM-001 — Camiseta Pima"). */
export function rowLabel(r: ResourceMeta, row: Record<string, any>): string {
  const parts = r.labelFields.map((f) => row[f]).filter((v) => v !== null && v !== undefined && String(v) !== '');
  if (r.labelFields.length === 1 && r.labelFields[0] === 'id') return `#${row.id}`;
  return parts.length ? parts.join(' — ') : `#${row.id}`;
}

/**
 * Texto longo: ellipsis + tooltip nativo. Nunca quebra o layout nem empurra a
 * coluna vizinha — o valor inteiro continua disponível no hover/foco.
 */
export function TextoTruncado({
  texto,
  className = '',
  vazio = '—',
  titulo,
}: {
  texto: string;
  className?: string;
  vazio?: string;
  titulo?: string;
}) {
  if (!texto || texto === '—') return <span className="text-slate-300">{vazio}</span>;
  return (
    <span className={`block truncate ${className}`} title={titulo ?? texto}>
      {texto}
    </span>
  );
}

function EstoqueCelula({ row }: { row: Record<string, any> }) {
  const saldo = saldoDaLinha(row);
  if (saldo === null) {
    // O saldo não faz parte do payload da listagem (contrato de estoque é
    // consultado por produto). Mostrar zero seria pior que mostrar o traço.
    return (
      <span
        className="text-slate-300"
        title="O saldo por tamanho fica na grade de estoque do produto."
        aria-label="Saldo de estoque disponível na página do produto"
      >
        —
      </span>
    );
  }
  const minimo = estoqueMinimoDaLinha(row);
  const abaixoDoMinimo = minimo !== null && minimo > 0 && saldo <= minimo;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`font-semibold tabular-nums ${abaixoDoMinimo ? 'text-brand-700' : 'text-slate-800'}`}>{saldo}</span>
      {abaixoDoMinimo && (
        <Badge tone="amber">
          <AlertTriangle className="h-3 w-3" aria-hidden="true" />
          mín. {minimo}
        </Badge>
      )}
    </span>
  );
}

/**
 * Conteúdo de uma célula. `recurso` entra só para rótulos/apresentação —
 * nenhum cálculo de negócio acontece aqui.
 */
export function ValorCampo({ f, row, recurso }: { f: Field; row: Record<string, any>; recurso: string }) {
  if (f.name === 'estoque') return <EstoqueCelula row={row} />;

  // Coluna sintética AMOSTRA: a cor com presença visual. O nome e o HEX ficam
  // em colunas próprias — a cor nunca é a única informação da linha.
  if (f.name === 'amostra') {
    const campo = campoDaAmostra(recurso);
    if (!campo) return <span className="text-slate-300">—</span>;
    return <AmostraCor hex={row[campo]} nome={row.nome ?? null} />;
  }

  // Coluna sintética UTILIZAÇÃO: contagem REAL vinda do servidor. Zero (ou
  // ausência do dado) é "—", nunca um número inventado. Grades têm duas
  // origens de uso (produtos da empresa ativa + categorias que a usam como
  // padrão): o rótulo do servidor já traz as duas, e só as duas zeradas é que
  // significam "sem utilização".
  if (f.name === 'uso_vinculado') {
    const n = Number(row.uso_vinculado);
    if (!temUtilizacao(row)) {
      return (
        <span className="text-slate-300" title="Nenhum registro usa este cadastro na empresa ativa." aria-label="Sem utilização">
          —
        </span>
      );
    }
    return (
      <span className="tabular-nums text-slate-700 dark:text-slate-200">
        {row.uso_vinculado_label ?? (Number.isFinite(n) ? String(n) : '—')}
      </span>
    );
  }

  // Coluna sintética MEDIDAS (grades): estado REAL da tabela de medidas,
  // anotado pelo servidor com a mesma regra de completude do módulo de medidas.
  if (f.name === 'medidas_status') {
    const status = statusMedidasDaLinha(row);
    if (!status) {
      return (
        <span className="text-slate-300" title="Sem informação da tabela de medidas." aria-label="Sem informação">
          —
        </span>
      );
    }
    if (status === 'sem_tabela') {
      return (
        <Badge tone="slate">
          <CircleDashed className="h-3 w-3" aria-hidden="true" /> Sem tabela
        </Badge>
      );
    }
    const pct = Number(row.medidas_pct);
    if (status === 'completa') {
      return (
        <Badge tone="green">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Completa
        </Badge>
      );
    }
    return (
      <Badge tone="amber">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" /> Parcial
        {Number.isFinite(pct) ? ` · ${pct}%` : ''}
      </Badge>
    );
  }

  const { max } = larguraDaColuna(f, recurso);
  const v = row[f.name];

  if (f.type === 'boolean') {
    // Status: texto + ícone, nunca só a cor (leitura para daltônicos e para
    // quem imprime a listagem).
    if (f.name === 'ativo') {
      return v ? (
        <Badge tone="green">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Ativo
        </Badge>
      ) : (
        <Badge tone="slate">
          <XCircle className="h-3 w-3" aria-hidden="true" /> Inativo
        </Badge>
      );
    }
    return v ? <Badge tone="green">Sim</Badge> : <Badge tone="slate">Não</Badge>;
  }

  if (f.type === 'select' && f.options) {
    const opt = f.options.find((o) => o.value === String(v));
    if (opt?.tone) return <Badge tone={opt.tone}>{opt.label}</Badge>;
    return <TextoTruncado texto={String(opt?.label ?? (v ?? '—'))} className={max} />;
  }

  if (f.type === 'color') {
    // Com coluna AMOSTRA dedicada, o HEX aqui é texto (evita duas amostras na
    // mesma linha). Sem a coluna, mantém a "bolinha" histórica ao lado do valor.
    if (campoDaAmostra(recurso)) {
      if (!v) return <span className="text-slate-300">—</span>;
      // Canônico quando válido; valor legado aparece como está (nunca inventado).
      const texto = corSegura(v) ?? String(v).trim();
      return <TextoTruncado texto={texto} className="font-mono text-xs uppercase" />;
    }
    return <ColorDot hex={v} label={v} />;
  }

  if (f.type === 'multiref') {
    const label = row[`${f.name}__label`];
    const texto = label || (Array.isArray(v) ? `${v.length} item(ns)` : '—');
    return <TextoTruncado texto={String(texto)} className={`text-slate-600 ${max}`} />;
  }

  const texto = formatCell(f, row);

  if (f.type === 'ref' && texto !== '—') {
    const hex = row[`${f.name}__color`];
    if (hex) {
      // Amostra da cor + rótulo truncado (o texto inteiro fica no tooltip).
      return (
        <span className={`inline-flex max-w-full items-center gap-1.5 ${max}`} title={texto}>
          <ColorDot hex={hex} label={null} />
          <span className="truncate font-medium text-slate-800">{texto}</span>
        </span>
      );
    }
    return <TextoTruncado texto={texto} className={`font-medium text-slate-800 ${max}`} />;
  }

  if (texto === '—') return <span className="text-slate-300">—</span>;

  // SKU/códigos e o id da linha: monoespaçado ajuda a comparar caractere a
  // caractere (o id continua discreto, como na listagem anterior).
  if (f.name === 'id') return <span className="font-mono text-xs text-slate-400">{texto}</span>;
  const mono = f.name === 'sku' || f.name === 'codigo_barras';
  const peso = f.name === 'nome' ? 'font-semibold text-navy-900' : '';
  const numero = ['money', 'number', 'integer', 'percent'].includes(f.type) ? 'tabular-nums' : '';
  return <TextoTruncado texto={texto} className={`${max} ${mono ? 'font-mono text-xs' : ''} ${peso} ${numero}`} />;
}

/** Miniatura de "sem foto" usada nos cartões do modo visual. */
export function PlaceholderFoto({ className = '' }: { className?: string }) {
  return (
    <div
      className={`flex items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200 text-slate-400 ${className}`}
      role="img"
      aria-label="Sem foto"
    >
      <Camera className="h-1/4 w-1/4" aria-hidden="true" />
    </div>
  );
}
