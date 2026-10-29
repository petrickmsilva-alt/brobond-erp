// ============================================================================
// COMMERCE — FILA DE SINCRONIZAÇÃO & OBSERVABILIDADE. Rota /commerce/fila.
//
// Outbox at-least-once (empresa + tipo + chave) com backoff visível, falhas de
// publicação recentes e webhooks do gateway — tudo lido do servidor; aqui não
// se reprocessa “no escuro”: o retry real é o agendador/outbox.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, EmptyState, PageHeader, Spinner, Badge } from '../../components/ui';
import { DataTable, FilterBar, type DataTableColumn } from '../../components/ui-kit-negocios';
import { EstadoBadge, ROTULO_PUBLICACAO, TONE_OUTBOX, TONE_PUBLICACAO, dataHora, rotuloCanal } from './shared';

type Eventos = {
  outbox: {
    id: number;
    tipo: string;
    chave: string;
    estado: string;
    tentativas: number;
    ultimo_erro: string | null;
    proxima_tentativa_em: string | null;
    atualizado_em: string | null;
  }[];
  publicacoes: {
    id: number;
    produto_id: number;
    canal: string;
    estado: string;
    tentativas: number;
    ultimo_erro: string | null;
    atualizado_em: string | null;
  }[];
  webhooks: { id: number; provider: string; status: string; erro: string | null; criado_em: string | null; processado_em: string | null }[];
};

const ROTULO_TIPO: Record<string, string> = {
  conversao: 'Conversão',
  publicacao: 'Publicação',
  sincronizacao: 'Sincronização',
  alerta: 'Alerta',
};

export default function CommerceFilaPage() {
  const [dados, setDados] = useState<Eventos | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [reenfileirando, setReenfileirando] = useState<number | null>(null);
  const [erro, setErro] = useState('');
  const [tipo, setTipo] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await apiFetch<Eventos>('/commerce/eventos'));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a fila.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const outbox = (dados?.outbox ?? []).filter((o) => !tipo || o.tipo === tipo);
  const pendentes = (dados?.outbox ?? []).filter((o) => ['PENDENTE', 'PROCESSANDO'].includes(o.estado)).length;
  const erros = (dados?.outbox ?? []).filter((o) => o.estado === 'ERRO').length;

  async function reprocessar(id: number) {
    setReenfileirando(id);
    try {
      await apiFetch(`/commerce/outbox/${id}/reprocessar`, { method: 'POST' });
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível reenfileirar o evento.');
    } finally {
      setReenfileirando(null);
    }
  }

  const colunasOutbox: DataTableColumn<Eventos['outbox'][number]>[] = [
    {
      key: 'tipo',
      header: 'Tipo',
      render: (o) => (
        <div>
          <div className="font-medium">{ROTULO_TIPO[o.tipo] ?? o.tipo}</div>
          <div className="truncate font-mono text-xs text-muted" title={o.chave}>{o.chave}</div>
        </div>
      ),
    },
    {
      key: 'estado',
      header: 'Estado',
      render: (o) => <Badge tone={TONE_OUTBOX[o.estado] ?? 'slate'}>{o.estado}</Badge>,
    },
    { key: 'tentativas', header: 'Tentativas', align: 'right', render: (o) => <span className="tabular-nums">{o.tentativas}</span> },
    {
      key: 'proxima',
      header: 'Próxima tentativa',
      render: (o) => <span className="text-sm text-muted">{o.proxima_tentativa_em ? dataHora(o.proxima_tentativa_em) : '—'}</span>,
    },
    {
      key: 'erro',
      header: 'Última mensagem',
      render: (o) =>
        o.ultimo_erro ? (
          <span className="line-clamp-2 max-w-lg text-xs text-danger" title={o.ultimo_erro}>
            {o.ultimo_erro}
          </span>
        ) : (
          <span className="text-muted">—</span>
        ),
    },
    { key: 'atualizado', header: 'Atualizado', render: (o) => <span className="text-sm text-muted">{dataHora(o.atualizado_em)}</span> },
    { key: 'acao', header: 'Recuperação', render: (o) => o.estado === 'ERRO' ? (
      <button type="button" className="btn-secondary" disabled={reenfileirando !== null}
        onClick={() => void reprocessar(o.id)} aria-label={`Reenfileirar evento ${o.id}`}>
        {reenfileirando === o.id ? 'Reenfileirando…' : 'Reenfileirar'}
      </button>
    ) : <span className="text-muted">—</span> },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fila de sincronização"
        description="Outbox do commerce com registro único por chave e retry automático. Entregas externas podem ser repetidas; consumidores precisam ser idempotentes."
        actions={
          <>
            <Link className="btn-ghost" to="/commerce/eventos">
              <Activity className="h-4 w-4" aria-hidden="true" /> Eventos
            </Link>
            <Link className="btn-ghost" to="/commerce/erros">
              Erros
            </Link>
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
          </>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Pendentes/Processando</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${pendentes ? 'text-warning' : ''}`}>{pendentes}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Com erro esgotado</div>
          <div className={`mt-1 text-2xl font-semibold tabular-nums ${erros ? 'text-danger' : ''}`}>{erros}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="text-xs uppercase tracking-wide text-muted">Processados (retidos na lista)</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums text-success">
            {(dados?.outbox ?? []).filter((o) => o.estado === 'PROCESSADO').length}
          </div>
        </div>
      </div>

      <FilterBar>
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Tipo</span>
          <select className="input w-48" value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(ROTULO_TIPO).map(([v, r]) => (
              <option key={v} value={v}>
                {r}
              </option>
            ))}
          </select>
        </label>
      </FilterBar>

      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando fila…" />
      ) : (
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="outbox">
          <h2 id="outbox" className="text-sm font-semibold uppercase tracking-wide text-muted">Outbox</h2>
          <div className="mt-3">
            <DataTable
              caption="Itens do outbox do commerce"
              columns={colunasOutbox}
              rows={outbox}
              getRowKey={(o) => o.id}
              empty="Fila vazia — nenhum trabalho registrado."
            />
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="pub-recentes">
          <h2 id="pub-recentes" className="text-sm font-semibold uppercase tracking-wide text-muted">Publicações recentes</h2>
          {(dados?.publicacoes.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted">Nenhuma publicação registrada ainda.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {dados!.publicacoes.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    Produto #{p.produto_id} · {rotuloCanal(p.canal)}
                  </span>
                  <span className="flex items-center gap-2">
                    <EstadoBadge estado={p.estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
                    <span className="text-xs text-muted">{dataHora(p.atualizado_em)}</span>
                  </span>
                  {p.ultimo_erro && (
                    <span className="w-full text-xs text-danger" title={p.ultimo_erro}>
                      {p.ultimo_erro}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="webhooks">
          <h2 id="webhooks" className="text-sm font-semibold uppercase tracking-wide text-muted">Webhooks de pagamento</h2>
          {(dados?.webhooks.length ?? 0) === 0 ? (
            <p className="mt-3 text-sm text-muted">Nenhum webhook recebido ainda.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {dados!.webhooks.map((w) => (
                <li key={w.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span className="font-medium">{w.provider}</span>
                  <span className="flex items-center gap-2">
                    <Badge tone={w.status === 'processado' ? 'green' : w.status === 'erro' ? 'red' : 'slate'}>{w.status}</Badge>
                    <span className="text-xs text-muted">{dataHora(w.criado_em)}</span>
                  </span>
                  {w.erro && (
                    <span className="w-full text-xs text-danger" title={w.erro}>
                      {w.erro}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <p className="flex items-center gap-2 text-xs text-muted">
        <Activity className="h-4 w-4" aria-hidden="true" />
        Retry é do servidor (backoff exponencial até 10 tentativas). Reenfileirar registra a recuperação; o agendador continua responsável pelo processamento.
      </p>
    </div>
  );
}
