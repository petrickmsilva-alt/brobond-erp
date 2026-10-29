// ============================================================================
// COMMERCE — EVENTOS (observabilidade unificada). Rota /commerce/eventos.
//
// Consome a API real /commerce/eventos (fila de sync + publicações + webhooks
// de pagamento) e apresenta UMA linha do tempo cronológica. Não é rota vazia:
// cada linha vem do banco do servidor.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { TONE_OUTBOX, TONE_PUBLICACAO, dataHora, rotuloCanal } from './shared';

type Eventos = {
  outbox: { id: number; tipo: string; chave: string; estado: string; tentativas: number; ultimo_erro: string | null; atualizado_em: string | null }[];
  publicacoes: { id: number; produto_id: number; canal: string; estado: string; tentativas: number; ultimo_erro: string | null; atualizado_em: string | null }[];
  webhooks: { id: number; provider: string; status: string; erro: string | null; criado_em: string | null; processado_em: string | null }[];
};

type Evento = {
  chave: string;
  origem: 'fila' | 'publicacao' | 'webhook';
  referencia: string;
  estado: string;
  tentativas: number | null;
  erro: string | null;
  quando: string | null;
  link: string | null;
};

const ORIGENS = ['', 'fila', 'publicacao', 'webhook'];
const ORIGEM_ROTULO: Record<string, string> = { fila: 'Fila', publicacao: 'Publicação', webhook: 'Webhook' };

const TONE_WEBHOOK: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  recebido: 'blue',
  processado: 'green',
  erro: 'red',
  ignorado: 'slate',
};

export default function CommerceEventosPage() {
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [origem, setOrigem] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Eventos>('/commerce/eventos');
      const linha: Evento[] = [
        ...r.outbox.map((o) => ({
          chave: `outbox-${o.id}`,
          origem: 'fila' as const,
          referencia: `${o.tipo} · ${o.chave}`,
          estado: o.estado,
          tentativas: o.tentativas,
          erro: o.ultimo_erro,
          quando: o.atualizado_em,
          link: '/commerce/fila',
        })),
        ...r.publicacoes.map((p) => ({
          chave: `pub-${p.id}`,
          origem: 'publicacao' as const,
          referencia: `Produto #${p.produto_id} · ${rotuloCanal(p.canal)}`,
          estado: p.estado,
          tentativas: p.tentativas,
          erro: p.ultimo_erro,
          quando: p.atualizado_em,
          link: `/commerce/publicacoes/${p.id}`,
        })),
        ...r.webhooks.map((w) => ({
          chave: `wh-${w.id}`,
          origem: 'webhook' as const,
          referencia: w.provider || 'gateway',
          estado: w.status,
          tentativas: null,
          erro: w.erro,
          quando: w.processado_em ?? w.criado_em,
          link: null,
        })),
      ];
      linha.sort((a, b) => String(b.quando ?? '').localeCompare(String(a.quando ?? '')));
      setEventos(linha);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os eventos.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const visiveis = useMemo(() => (origem ? eventos.filter((e) => e.origem === origem) : eventos), [eventos, origem]);

  const colunas: DataTableColumn<Evento>[] = [
    { key: 'origem', header: 'Origem', render: (e) => <Badge tone={e.origem === 'webhook' ? 'blue' : e.origem === 'publicacao' ? 'amber' : 'slate'}>{ORIGEM_ROTULO[e.origem]}</Badge> },
    {
      key: 'referencia',
      header: 'Referência',
      render: (e) =>
        e.link ? (
          <Link className="font-medium hover:underline" to={e.link}>
            {e.referencia}
          </Link>
        ) : (
          <span className="font-medium">{e.referencia}</span>
        ),
    },
    {
      key: 'estado',
      header: 'Estado',
      render: (e) => (
        <Badge
          tone={
            e.origem === 'webhook'
              ? (TONE_WEBHOOK[e.estado] ?? 'slate')
              : (e.origem === 'fila' ? TONE_OUTBOX[e.estado] : TONE_PUBLICACAO[e.estado]) ?? 'slate'
          }
        >
          {e.estado}
        </Badge>
      ),
    },
    {
      key: 'tentativas',
      header: 'Tentativas',
      align: 'right',
      render: (e) => <span className="tabular-nums">{e.tentativas ?? '—'}</span>,
    },
    {
      key: 'erro',
      header: 'Mensagem',
      render: (e) =>
        e.erro ? (
          <span className="line-clamp-2 max-w-md text-xs text-danger" title={e.erro}>
            {e.erro}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    { key: 'quando', header: 'Quando', render: (e) => <span className="text-sm text-muted">{dataHora(e.quando)}</span> },
  ];

  const falhas = eventos.filter((e) => e.erro).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Eventos"
        description="Linha do tempo real: fila de sincronização, publicações multicanal e webhooks de pagamento — tudo vindo da API /commerce/eventos."
      />
      <FilterBar>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Origem</span>
          <select className="input w-44" value={origem} onChange={(e) => setOrigem(e.target.value)}>
            {ORIGENS.map((v) => (
              <option key={v || 'todas'} value={v}>
                {v ? ORIGEM_ROTULO[v] : 'Todas'}
              </option>
            ))}
          </select>
        </label>
        <Badge tone={falhas ? 'red' : 'green'}>{falhas ? `${falhas} com falha` : 'Sem falhas'}</Badge>
        <Link className="btn-ghost" to="/commerce/erros">
          Ver só erros
        </Link>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando eventos…" />
      ) : visiveis.length === 0 ? (
        <EmptyState
          icon={<Activity className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum evento"
          description="Os eventos aparecem assim que o checkout, a fila ou um webhook roda."
        />
      ) : (
        <DataTable
          caption="Linha do tempo de eventos do commerce"
          columns={colunas}
          rows={visiveis}
          getRowKey={(e) => e.chave}
          empty="Nenhum evento com este filtro."
        />
      )}
    </div>
  );
}
