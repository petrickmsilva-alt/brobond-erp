// ============================================================================
// COMMERCE — OFERTAS (preço por canal com vigência). Rota /commerce/ofertas.
//
// Cada oferta é uma linha de `commerce_precos`: preço, preço promocional,
// vigência, canal e tenant. A PRECEDÊNCIA (linha vigente > preço de tabela;
// promo só quando menor) é calculada no servidor — `preco_efetivo` vem pronto
// da API e a tela nunca decide dinheiro.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Percent, Plus, RefreshCw } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { DataTable, FilterBar, SearchInput, type DataTableColumn } from '../../components/ui-kit-negocios';
import { CANAIS_PUBLICACAO, EstadoBadge, ROTULO_PUBLICACAO, TONE_PUBLICACAO, grana, rotuloCanal } from './shared';

export type Oferta = {
  id: number;
  produto_id: number;
  sku: string;
  nome: string;
  preco_base: number;
  canal: string;
  preco: number;
  preco_promo: number | null;
  vigencia_inicio: string | null;
  vigencia_fim: string | null;
  vigente: boolean;
  preco_efetivo: { preco: number; promo: number | null; origem: string };
  publicacao_estado: string | null;
  publicacao_id: number | null;
  atualizado_em: string | null;
};

const TONE_VIGENCIA: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  vigente: 'green',
  futura: 'amber',
  vencida: 'amber',
  sem_vigencia: 'blue',
};

function situacao(o: Oferta): { chave: string; rotulo: string } {
  if (!o.vigencia_inicio && !o.vigencia_fim) return { chave: 'sem_vigencia', rotulo: 'Sem vigência (sempre ativa)' };
  if (!o.vigente) {
    const hoje = new Date().toISOString().slice(0, 10);
    if (o.vigencia_inicio && o.vigencia_inicio > hoje) return { chave: 'futura', rotulo: 'Vigência futura — vale a tabela' };
    return { chave: 'vencida', rotulo: 'Vigência encerrada — vale a tabela' };
  }
  return { chave: 'vigente', rotulo: 'Vigente' };
}

export default function CommerceOfertasPage() {
  const navigate = useNavigate();
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [linhas, setLinhas] = useState<Oferta[]>([]);
  const [total, setTotal] = useState(0);
  const [canal, setCanal] = useState('');
  const [apenasVigentes, setApenasVigentes] = useState(false);
  const [busca, setBusca] = useState('');
  const [buscaAplicada, setBuscaAplicada] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const params = new URLSearchParams();
      if (canal) params.set('canal', canal);
      if (apenasVigentes) params.set('vigentes', '1');
      const r = await apiFetch<{ total: number; ofertas: Oferta[] }>(`/commerce/ofertas?${params.toString()}`);
      const q = buscaAplicada.toLowerCase();
      const filtradas = q
        ? r.ofertas.filter((o) => o.nome.toLowerCase().includes(q) || o.sku.toLowerCase().includes(q))
        : r.ofertas;
      setLinhas(filtradas);
      setTotal(r.total);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as ofertas.');
    } finally {
      setCarregando(false);
    }
  }, [canal, apenasVigentes, buscaAplicada]);

  useEffect(() => {
    const t = window.setTimeout(() => setBuscaAplicada(busca.trim()), 250);
    return () => window.clearTimeout(t);
  }, [busca]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const colunas: DataTableColumn<Oferta>[] = [
    {
      key: 'produto',
      header: 'Produto',
      render: (o) => (
        <div className="min-w-0">
          <Link className="truncate font-medium hover:underline" to={`/commerce/produtos/${o.produto_id}`}>
            {o.nome}
          </Link>
          <div className="text-xs text-muted">{o.sku}</div>
        </div>
      ),
    },
    { key: 'canal', header: 'Canal', render: (o) => <Badge tone="blue">{rotuloCanal(o.canal)}</Badge> },
    {
      key: 'preco',
      header: 'Preço',
      align: 'right',
      render: (o) => (
        <div className="tabular-nums">
          <span className="font-medium">{grana(o.preco)}</span>
          {o.preco_promo != null && <span className="ml-2 text-xs text-success">promo {grana(o.preco_promo)}</span>}
        </div>
      ),
    },
    {
      key: 'vigencia',
      header: 'Vigência',
      render: (o) => (
        <div className="text-xs tabular-nums">
          {o.vigencia_inicio || o.vigencia_fim ? (
            <>
              {o.vigencia_inicio ?? '—'} → {o.vigencia_fim ?? 'sem fim'}
            </>
          ) : (
            <span className="text-muted">sem vigência</span>
          )}
          <div>
            <Badge tone={TONE_VIGENCIA[situacao(o).chave]}>{situacao(o).rotulo}</Badge>
          </div>
        </div>
      ),
    },
    {
      key: 'efetivo',
      header: 'Preço final (servidor)',
      align: 'right',
      render: (o) => (
        <div className="tabular-nums">
          <span className="font-semibold">{grana(o.preco_efetivo.preco)}</span>
          {o.preco_efetivo.promo != null && <span className="ml-1 text-xs text-success">→ promo {grana(o.preco_efetivo.promo)}</span>}
          <div className="text-[11px] text-muted">{o.preco_efetivo.origem === 'canal' ? 'linha do canal' : 'tabela'}</div>
        </div>
      ),
    },
    {
      key: 'publicacao',
      header: 'Publicação',
      render: (o) =>
        o.publicacao_estado ? (
          <EstadoBadge estado={o.publicacao_estado} mapa={TONE_PUBLICACAO} rotulos={ROTULO_PUBLICACAO} />
        ) : (
          <span className="text-muted">não publicada</span>
        ),
    },
    {
      key: 'acoes',
      header: '',
      render: (o) => (
        <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/ofertas/${o.id}`)}>
          Abrir
        </button>
      ),
    },
  ];

  const vigentes = linhas.filter((o) => o.vigente).length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ofertas por canal"
        description="Preço, preço promocional e vigência por canal (empresa). Precedência calculada no servidor: linha vigente > tabela; promoção só quando menor. Salvar já reenfileira o canal publicado."
        actions={
          <>
            <button type="button" className="btn-ghost" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Atualizar
            </button>
            <button type="button" className="btn-primary" onClick={() => navigate('/commerce/ofertas/novo')}>
              <Plus className="h-4 w-4" aria-hidden="true" /> Nova oferta
            </button>
          </>
        }
      />
      <FilterBar>
        <SearchInput value={busca} onChange={setBusca} placeholder="Buscar produto ou SKU…" label="Buscar ofertas" />
        <label className="text-sm">
          <span className="mr-2 text-ink-soft">Canal</span>
          <select className="input w-48" value={canal} onChange={(e) => setCanal(e.target.value)}>
            <option value="">Todos</option>
            {CANAIS_PUBLICACAO.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.rotulo}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={apenasVigentes} onChange={(e) => setApenasVigentes(e.target.checked)} />
          Somente vigentes
        </label>
        <Badge tone="slate">{total} oferta(s) · {vigentes} vigente(s) nesta página</Badge>
      </FilterBar>
      {erro && <Alert tone="red">{erro}</Alert>}
      {carregando ? (
        <Spinner label="Carregando ofertas…" />
      ) : linhas.length === 0 ? (
        <EmptyState
          icon={<Percent className="h-6 w-6" aria-hidden="true" />}
          title="Nenhuma oferta de canal"
          description="Sem linhas de preço por canal, todos os canais usam o preço de tabela do produto. Crie a primeira oferta."
        />
      ) : (
        <DataTable
          caption="Ofertas por canal"
          columns={colunas}
          rows={linhas}
          getRowKey={(o) => o.id}
          empty="Nenhuma oferta com este filtro."
        />
      )}
    </div>
  );
}
