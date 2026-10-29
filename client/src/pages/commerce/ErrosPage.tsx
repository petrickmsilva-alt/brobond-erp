// ============================================================================
// COMMERCE — ERROS (falhas reais, agrupadas). Rota /commerce/erros.
//
// Consome a API real /commerce/erros: publicações ERROR/REJECTED, outbox ERRO,
// pedidos ERRO e webhooks com falha/assinatura inválida. Cada linha carrega a
// ação honesta (reprocessar publicação, abrir pedido, ver eventos).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../../components/ui';
import { DataTable, type DataTableColumn } from '../../components/ui-kit-negocios';
import { dataHora, rotuloCanal } from './shared';
import { useAuth } from '../../auth/AuthContext';

type Erro = {
  origem: 'publicacao' | 'outbox' | 'pedido' | 'webhook';
  id: number;
  referencia: string;
  estado: string;
  mensagem: string;
  quando: string | null;
  acao: string;
  link: string;
};

const ORIGEM_ROTULO: Record<string, string> = {
  publicacao: 'Publicação',
  outbox: 'Fila',
  pedido: 'Pedido',
  webhook: 'Webhook',
};

export default function CommerceErrosPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Erro[]>([]);
  const [total, setTotal] = useState(0);
  const [reprocessando, setReprocessando] = useState<number | null>(null);
  const [confirmando, setConfirmando] = useState<Erro | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ total: number; erros: Erro[] }>('/commerce/erros');
      setLinhas(r.erros);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os erros.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const reprocessar = async (linha: Erro) => {
    setReprocessando(linha.id);
    setErro('');
    try {
      await apiFetch(`/commerce/publicacoes/${linha.id}/reprocessar`, { method: 'POST' });
      toast.success(`Publicação #${linha.id} reenfileirada.`);
      setConfirmando(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao reprocessar.');
    } finally {
      setReprocessando(null);
    }
  };

  const colunas: DataTableColumn<Erro>[] = [
    { key: 'origem', header: 'Origem', render: (e) => <Badge tone="red">{ORIGEM_ROTULO[e.origem] ?? e.origem}</Badge> },
    {
      key: 'referencia',
      header: 'Referência',
      render: (e) =>
        e.link.startsWith('/commerce/pedidos/') || e.link.startsWith('/commerce/publicacoes/') ? (
          <Link className="font-medium hover:underline" to={e.link}>
            {e.origem === 'publicacao' ? rotuloCanal(e.referencia.split(' · ')[1] ?? '') + ' · ' + e.referencia.split(' · ')[0] : e.referencia}
          </Link>
        ) : (
          <span className="font-medium">{e.referencia}</span>
        ),
    },
    { key: 'estado', header: 'Estado', render: (e) => <Badge tone="amber">{e.estado}</Badge> },
    {
      key: 'mensagem',
      header: 'Mensagem',
      render: (e) => (
        <span className="line-clamp-3 max-w-xl text-xs text-danger" title={e.mensagem}>
          {e.mensagem}
        </span>
      ),
    },
    { key: 'quando', header: 'Quando', render: (e) => <span className="text-sm text-muted">{dataHora(e.quando)}</span> },
    {
      key: 'acoes',
      header: 'Ação',
      render: (e) => (
        <div className="flex flex-wrap gap-2">
          {e.origem === 'publicacao' && podeGerir && (
            <button
              type="button"
              className="btn-ghost"
              disabled={reprocessando === e.id}
              onClick={() => setConfirmando(e)}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Reprocessar
            </button>
          )}
          {e.origem === 'pedido' && (
            <button type="button" className="btn-ghost" onClick={() => navigate(e.link)}>
              Abrir pedido
            </button>
          )}
          {e.origem !== 'publicacao' && e.origem !== 'pedido' && (
            <Link className="btn-ghost" to={e.link}>
              {e.acao === 'eventos' ? 'Ver eventos' : 'Ver fila'}
            </Link>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Erros"
        description="Falhas REAIS do commerce em um lugar só: publicações rejeitadas, fila com erro, pedidos em ERRO e webhooks falhos. Nada é convertido em aviso."
        actions={
          <button type="button" className="btn-ghost" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
          </button>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando erros…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<AlertTriangle className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum erro"
          description="Sem falhas registradas em publicações, fila, pedidos ou webhooks."
        />
      ) : (
        <>
          <Alert tone="red">{total} falha(s) registrada(s) — cada uma com a ação correspondente.</Alert>
          <DataTable
            caption="Erros do commerce"
            columns={colunas}
            rows={linhas}
            getRowKey={(e) => `${e.origem}-${e.id}`}
            empty="Nenhum erro."
          />
        </>
      )}
      {confirmando && (
        <ConfirmacaoInline
          open
          title="Reprocessar a publicação?"
          message={`${confirmando.referencia} — a fila ignora o backoff e tenta publicar novamente agora.`}
          confirmLabel="Reprocessar agora"
          busy={reprocessando === confirmando.id}
          onCancel={() => setConfirmando(null)}
          onConfirm={() => void reprocessar(confirmando)}
        />
      )}
    </div>
  );
}
