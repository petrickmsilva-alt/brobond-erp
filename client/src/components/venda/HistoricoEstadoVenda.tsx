import { useCallback, useEffect, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge } from '../ui';
import { SecaoVenda } from './VendaCampos';
import { formatDateTime } from '../../lib/format';

/** Rótulos do estado do pedido — espelham o recurso `vendas` (server/resources.ts). */
const STATUS_LABEL: Record<string, string> = {
  cotacao: 'Cotação',
  pendente_aprovacao: 'Aguardando aprovação',
  aberta: 'Aberta',
  faturada: 'Faturada',
  entregue: 'Entregue',
  cancelada: 'Cancelada',
};

const STATUS_TONE: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  cotacao: 'slate',
  pendente_aprovacao: 'amber',
  aberta: 'amber',
  faturada: 'green',
  entregue: 'blue',
  cancelada: 'red',
};

/** Rótulo curto do canal que disparou a transição. */
const ORIGEM_LABEL: Record<string, string> = {
  erp: 'ERP',
  expedicao: 'Expedição',
  fiscal: 'Fiscal',
  pdv: 'PDV',
  portal: 'Portal',
  marketplace: 'Marketplace',
  aprovacao: 'Aprovação',
  devolucao: 'Devolução',
  sistema: 'Sistema',
};

export interface TransicaoEstado {
  id: number;
  status_anterior: string | null;
  status_novo: string;
  origem: string;
  motivo: string | null;
  referencia_externa: string | null;
  usuario_nome: string | null;
  criado_em: string;
}

const labelDe = (status: string | null) => (status ? STATUS_LABEL[status] || status : 'Criação');

/**
 * Mensagem legível do erro da API sem importar `ApiError`.
 *
 * A tela é montada dentro de `OrderPage`, cujos testes mockam `../lib/api` com
 * apenas `{ api, setToken }`. Importar `ApiError` só para o `instanceof` faria
 * o mock devolver `undefined` no acesso ao módulo e derrubaria a suíte. O
 * contrato útil é só "tem mensagem de texto?", então checamos por estrutura.
 */
const mensagemDeErro = (e: unknown): string => {
  const msg = (e as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg ? msg : 'Não foi possível carregar o histórico de estados.';
};

/**
 * Linha do tempo da máquina de estados do pedido (migration 0109).
 *
 * Lê `/api/oms/vendas/:id/status-historico`. É somente leitura: a escrita da
 * trilha acontece no backend, nos mesmos pontos que mudam `vendas.status`.
 */
export function HistoricoEstadoVenda({ etapa, vendaId }: { etapa: number; vendaId: number }) {
  const [linhas, setLinhas] = useState<TransicaoEstado[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro(null);
    try {
      const dados = await api.get<TransicaoEstado[]>(`/oms/vendas/${vendaId}/status-historico`);
      setLinhas(Array.isArray(dados) ? dados : []);
    } catch (e) {
      setErro(mensagemDeErro(e));
      setLinhas([]);
    } finally {
      setCarregando(false);
    }
  }, [vendaId]);

  useEffect(() => {
    if (vendaId) void carregar();
  }, [vendaId, carregar]);

  return (
    <SecaoVenda
      etapa={etapa}
      titulo="Histórico de estados"
      subtitulo="Trilha imutável do ciclo do pedido: quem mudou, de qual estado para qual, por qual canal e por quê."
      direita={
        <button
          type="button"
          onClick={() => void carregar()}
          disabled={carregando}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 dark:border-navy-700 dark:text-navy-200 dark:hover:bg-navy-800"
        >
          {carregando ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <History className="h-3.5 w-3.5" />}
          Atualizar
        </button>
      }
    >
      {erro && <p className="text-sm text-red-600 dark:text-red-400">{erro}</p>}
      {!erro && linhas && linhas.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-navy-300">
          Nenhuma transição registrada ainda. A trilha começa a partir da próxima mudança de estado do pedido.
        </p>
      )}
      {!erro && linhas && linhas.length > 0 && (
        <ol className="relative ml-2 border-l border-slate-200 dark:border-navy-700">
          {linhas.map((l) => (
            <li key={l.id} className="mb-4 ml-4 last:mb-0">
              <span
                aria-hidden="true"
                className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-brand-500 ring-4 ring-white dark:ring-navy-900"
              />
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-500 dark:text-navy-300">{labelDe(l.status_anterior)}</span>
                <span aria-hidden="true" className="text-slate-400">→</span>
                <Badge tone={STATUS_TONE[l.status_novo] || 'slate'}>{labelDe(l.status_novo)}</Badge>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 dark:bg-navy-800 dark:text-navy-200">
                  {ORIGEM_LABEL[l.origem] || l.origem}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-navy-300">
                {formatDateTime(l.criado_em)}
                {l.usuario_nome ? ` · ${l.usuario_nome}` : ''}
                {l.referencia_externa ? ` · ref. ${l.referencia_externa}` : ''}
              </p>
              {l.motivo && <p className="mt-0.5 text-xs text-slate-600 dark:text-navy-200">{l.motivo}</p>}
            </li>
          ))}
        </ol>
      )}
    </SecaoVenda>
  );
}
