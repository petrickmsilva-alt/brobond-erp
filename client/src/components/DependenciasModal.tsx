// ============================================================================
// "Ver vínculos" — diagnóstico de dependências antes da exclusão.
//
// Substitui o antigo toast genérico ("este registro está em uso em outro
// módulo") por uma explicação concreta: QUAIS módulos apontam para o registro,
// QUANTOS são, QUAIS ids e POR QUE a exclusão está bloqueada.
//
// Reusa os componentes do design system (Modal, Alert, Badge) — nenhuma
// biblioteca visual nova.
// ============================================================================
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  BookOpen,
  Boxes,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cog,
  Contact,
  Factory,
  FileSignature,
  FileText,
  Globe,
  Handshake,
  History,
  Landmark,
  Layers,
  Link2,
  ListChecks,
  Package,
  Paperclip,
  Power,
  Printer,
  ShoppingBag,
  ShoppingCart,
  Tag,
  Tags,
  Truck,
  Undo2,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Alert, Badge, Modal } from './ui';

export type TipoVinculo = 'composicao' | 'historico' | 'operacional' | 'trilha' | 'anexo';

export type VinculoDependencia = {
  modulo: string;
  icone: string;
  tabela: string;
  colunas: string[];
  recurso: string | null;
  quantidade: number;
  ids: number[];
  idsTruncados: boolean;
  unidade: [string, string];
  tipo: TipoVinculo;
  politica: 'seguir' | 'proteger' | 'desvincular';
  acao: 'NO_ACTION' | 'RESTRICT' | 'CASCADE' | 'SET_NULL' | 'SET_DEFAULT' | 'LOGICO';
  impeditivo: boolean;
  protegido: boolean;
  bloqueia: boolean;
  motivo: string;
};

export type DiagnosticoDependencias = {
  recurso: string;
  recursoLabel: string;
  singular: string;
  id: number;
  empresaId: number;
  rotulo: string;
  status: string | null;
  origem: 'postgresql' | 'memoria';
  bloqueado: boolean;
  podeExcluir: boolean;
  titulo: string;
  resumo: string;
  orientacao: string;
  totalRegistros: number;
  totalBloqueantes: number;
  modulos: string[];
  modulosBloqueantes: string[];
  vinculos: VinculoDependencia[];
  geradoEm: string;
};

const ICONES: Record<string, LucideIcon> = {
  vendas: ShoppingCart,
  compras: ShoppingBag,
  estoque: Boxes,
  financeiro: Wallet,
  caixa: Banknote,
  fiscal: FileText,
  expedicao: Truck,
  producao: Factory,
  impressao: Printer,
  comercial: Tag,
  produtos: Package,
  propostas: FileSignature,
  catalogo: BookOpen,
  portal: Globe,
  usuarios: Users,
  empresas: Landmark,
  clientes: Contact,
  fornecedores: Building2,
  devolucoes: Undo2,
  auditoria: History,
  anexos: Paperclip,
  itens: ListChecks,
  representantes: Handshake,
  colecoes: Layers,
  categorias: Tags,
  integracoes: Link2,
  sistema: Cog,
};

function Icone({ nome, className }: { nome: string; className?: string }) {
  const Icon = ICONES[nome] ?? CircleAlert;
  return <Icon className={className ?? 'h-5 w-5'} aria-hidden="true" />;
}

const TOM_TIPO: Record<TipoVinculo, 'red' | 'amber' | 'blue' | 'slate' | 'green'> = {
  historico: 'red',
  operacional: 'amber',
  composicao: 'blue',
  trilha: 'slate',
  anexo: 'slate',
};

const ROTULO_TIPO: Record<TipoVinculo, string> = {
  historico: 'Histórico',
  operacional: 'Operacional',
  composicao: 'Composição',
  trilha: 'Trilha',
  anexo: 'Anexo',
};

function quantidadeTexto(v: VinculoDependencia) {
  const n = v.quantidade;
  const unidade = n === 1 ? v.unidade[0] : v.unidade[1];
  return `${n} ${unidade}`;
}

/**
 * Agrupa os vínculos por módulo — é a primeira coisa que o usuário precisa
 * saber: "onde este registro está sendo usado".
 */
export function agruparPorModulo(diag: DiagnosticoDependencias) {
  const mapa = new Map<string, { modulo: string; icone: string; total: number; bloqueia: boolean; vinculos: VinculoDependencia[] }>();
  for (const v of diag.vinculos) {
    const atual = mapa.get(v.modulo) ?? { modulo: v.modulo, icone: v.icone, total: 0, bloqueia: false, vinculos: [] };
    atual.total += v.quantidade;
    atual.bloqueia = atual.bloqueia || v.bloqueia;
    atual.vinculos.push(v);
    mapa.set(v.modulo, atual);
  }
  return [...mapa.values()].sort((a, b) => {
    if (a.bloqueia !== b.bloqueia) return a.bloqueia ? -1 : 1;
    return a.modulo.localeCompare(b.modulo, 'pt-BR');
  });
}

export function DependenciasModal({
  diag,
  onClose,
  onAbrirModulo,
  acaoRecomendada,
  mensagem,
}: {
  diag: DiagnosticoDependencias | null;
  onClose: () => void;
  /** Leva ao módulo do vínculo (quando ele é um recurso navegável). */
  onAbrirModulo?: (recurso: string) => void;
  /**
   * Saída alternativa ao DELETE bloqueado, oferecida pelo dono do cadastro —
   * ex.: "Desativar cor" quando a regra do ERP recomenda desativar em vez de
   * excluir. O diagnóstico continua sendo somente leitura: quem age é a tela,
   * pelo fluxo normal do recurso (PUT `{ ativo: false }`).
   */
  acaoRecomendada?: { rotulo: string; onClick: () => void; descricao?: string };
  /**
   * Frase de abertura na voz do cadastro (ex.: "Não é possível excluir esta cor
   * porque existem registros vinculados."). Substitui o resumo técnico; os
   * números, os módulos e o motivo continuam vindo do diagnóstico do servidor.
   */
  mensagem?: string | null;
}) {
  const [detalhado, setDetalhado] = useState(false);
  const grupos = useMemo(() => (diag ? agruparPorModulo(diag) : []), [diag]);
  if (!diag) return null;

  const bloqueados = grupos.filter((g) => g.bloqueia);
  const acompanhamento = grupos.filter((g) => !g.bloqueia);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Exclusão bloqueada por vínculos"
      subtitle={diag.titulo}
      footer={
        <>
          {acaoRecomendada && (
            <button type="button" className="btn-accent" onClick={acaoRecomendada.onClick} title={acaoRecomendada.descricao ?? acaoRecomendada.rotulo}>
              <Power className="h-4 w-4" aria-hidden="true" />
              {acaoRecomendada.rotulo}
            </button>
          )}
          <button className="btn-secondary" onClick={onClose}>
            Fechar
          </button>
          <button className="btn-primary" onClick={() => setDetalhado((v) => !v)} aria-expanded={detalhado}>
            {detalhado ? 'Ocultar vínculos' : 'Ver vínculos'}
            {detalhado ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <Alert tone="red">
          <div className="space-y-1">
            <p className="font-semibold">{mensagem || diag.resumo}</p>
            <p>{diag.orientacao}</p>
          </div>
        </Alert>

        <section aria-label="Módulos com vínculos">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            {bloqueados.length ? 'Vínculos que impedem a exclusão' : 'Vínculos registrados'}
          </h3>
          <ul className="space-y-2">
            {bloqueados.map((g) => (
              <li
                key={g.modulo}
                className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50/60 px-3 py-2.5 dark:border-red-900/40 dark:bg-red-950/20"
              >
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-red-600 ring-1 ring-red-200 dark:bg-navy-900 dark:ring-red-900/50">
                  <Icone nome={g.icone} className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-navy-900 dark:text-white">{g.modulo}</span>
                    <Badge tone="red">
                      {g.total} {g.total === 1 ? 'registro' : 'registros'}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-slate-600 dark:text-navy-300">
                    {g.vinculos.filter((v) => v.bloqueia).map((v) => v.motivo).filter((m, i, a) => a.indexOf(m) === i).join(' · ')}
                  </p>
                </div>
                {onAbrirModulo && g.vinculos.some((v) => v.recurso) && (
                  <div className="flex shrink-0 flex-col gap-1">
                    {[...new Set(g.vinculos.filter((v) => v.recurso).map((v) => v.recurso!))].slice(0, 2).map((recurso) => (
                      <button key={recurso} className="btn-ghost text-xs" onClick={() => onAbrirModulo(recurso)}>
                        Abrir módulo <ArrowRight className="h-3.5 w-3.5" />
                      </button>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>

        {acompanhamento.length > 0 && (
          <section aria-label="Vínculos de acompanhamento">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Também vinculados (não impedem a exclusão)
            </h3>
            <ul className="space-y-1.5">
              {acompanhamento.map((g) => (
                <li
                  key={g.modulo}
                  className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2 dark:border-navy-800 dark:bg-navy-800/30"
                >
                  <Icone nome={g.icone} className="h-4 w-4 text-slate-500" />
                  <span className="font-medium text-slate-700 dark:text-slate-200">{g.modulo}</span>
                  <Badge tone="slate">
                    {g.total} {g.total === 1 ? 'registro' : 'registros'}
                  </Badge>
                  <span className="ml-auto text-xs text-slate-500">
                    {[...new Set(g.vinculos.map((v) => ROTULO_TIPO[v.tipo]))].join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {detalhado && (
          <section aria-label="Detalhe dos vínculos" className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Detalhe técnico</h3>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-navy-800">
              <table className="min-w-full divide-y divide-slate-200 text-left dark:divide-navy-800">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-navy-800/50">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Módulo / vínculo</th>
                    <th className="px-3 py-2 font-semibold">Tipo</th>
                    <th className="px-3 py-2 font-semibold">Registros</th>
                    <th className="px-3 py-2 font-semibold">Ids</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {diag.vinculos.map((v) => (
                    <tr key={`${v.tabela}-${v.colunas.join('-')}`} className={v.bloqueia ? '' : 'opacity-70'}>
                      <td className="px-3 py-2">
                        <div className="font-medium text-slate-800 dark:text-slate-100">{v.modulo}</div>
                        <div className="font-mono text-[11px] text-slate-500">
                          {v.tabela}.{v.colunas.join(' + ')}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">{v.motivo}</div>
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Badge tone={TOM_TIPO[v.tipo]}>{ROTULO_TIPO[v.tipo]}</Badge>
                        {v.bloqueia && (
                          <div className="mt-1">
                            <Badge tone="red">Bloqueia</Badge>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top text-slate-700 dark:text-slate-200">{quantidadeTexto(v)}</td>
                      <td className="px-3 py-2 align-top">
                        <span className="font-mono text-xs text-slate-600 dark:text-slate-300">
                          {v.ids.length ? `#${v.ids.join(', #')}` : '—'}
                          {v.idsTruncados ? ` +${v.quantidade - v.ids.length}` : ''}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <p className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-navy-800/40">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Nada foi apagado. O diagnóstico é somente leitura e mostra apenas vínculos da empresa ativa
            {diag.origem === 'postgresql' ? ' (relações lidas do catálogo do PostgreSQL)' : ' (mapa de relações do modo demonstração)'}.
          </span>
        </p>
      </div>
    </Modal>
  );
}
