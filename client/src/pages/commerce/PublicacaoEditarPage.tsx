// ============================================================================
// COMMERCE — EDITAR PUBLICAÇÃO (conteúdo do canal). Rota /commerce/publicacoes/:id/editar.
//
// Editar uma publicação é editar o que VAI para o canal: preço/preço
// promocional/vigência daquele canal (PUT /produtos/:id/precos) e os
// metadados por canal da vitrine (PUT /produtos/:id). Salvar já reenfileira
// nova versão quando o canal tem histórico; "Salvar e reprocessar" força o
// retry na hora. Preço final é sempre calculado no servidor.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Save } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../../components/ui';
import { rotuloCanal } from './shared';

type Detalhe = {
  publicacao: { id: number; produto_id: number; canal: string; versao: number; estado: string };
  produto: { id: number; sku: string; nome: string; preco_base: number };
  preco: {
    linha: { preco: number; preco_promo: number | null; vigencia_inicio: string | null; vigencia_fim: string | null } | null;
  };
  metadados: Record<string, unknown>;
};

export default function CommercePublicacaoEditarPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [preco, setPreco] = useState('');
  const [precoPromo, setPrecoPromo] = useState('');
  const [vigenciaInicio, setVigenciaInicio] = useState('');
  const [vigenciaFim, setVigenciaFim] = useState('');
  const [metadados, setMetadados] = useState('{}');

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Detalhe>(`/commerce/publicacoes/${id}`);
      setDetalhe(r);
      const linha = r.preco.linha;
      setPreco(linha ? String(linha.preco) : String(r.produto.preco_base));
      setPrecoPromo(linha?.preco_promo != null ? String(linha.preco_promo) : '');
      setVigenciaInicio(linha?.vigencia_inicio ?? '');
      setVigenciaFim(linha?.vigencia_fim ?? '');
      setMetadados(JSON.stringify(r.metadados ?? {}, null, 2));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a publicação.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async (reprocessar: boolean) => {
    if (!detalhe) return;
    setSalvando(true);
    setErro('');
    try {
      const valor = Number(preco);
      if (!Number.isFinite(valor) || valor < 0) throw new ApiError(400, 'Informe um preço maior ou igual a zero.');
      const promo = precoPromo.trim() ? Number(precoPromo) : null;
      if (promo !== null && (!Number.isFinite(promo) || promo < 0)) throw new ApiError(400, 'Preço promocional inválido.');
      if (promo !== null && promo >= valor) throw new ApiError(400, 'O preço promocional precisa ser menor que o preço do canal.');
      if (vigenciaFim && vigenciaInicio && vigenciaFim < vigenciaInicio) {
        throw new ApiError(400, 'A vigência final não pode ser anterior ao início.');
      }
      let metadadosObj: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(metadados.trim() || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('objeto');
        metadadosObj = parsed as Record<string, unknown>;
      } catch {
        setErro('Metadados precisam ser um JSON válido no formato {"ml_category_id": "MLB123"}.');
        return;
      }

      await apiFetch(`/commerce/produtos/${detalhe.produto.id}/precos`, {
        method: 'PUT',
        body: JSON.stringify({
          canal: detalhe.publicacao.canal,
          preco: valor,
          preco_promo: promo,
          vigencia_inicio: vigenciaInicio || null,
          vigencia_fim: vigenciaFim || null,
        }),
      });
      await apiFetch(`/commerce/produtos/${detalhe.produto.id}`, {
        method: 'PUT',
        body: JSON.stringify({ canal_metadados: metadadosObj }),
      });
      if (reprocessar) {
        await apiFetch(`/commerce/publicacoes/${id}/reprocessar`, { method: 'POST' });
      }
      toast.success(reprocessar ? 'Conteúdo salvo e publicação reenfileirada.' : 'Conteúdo salvo — canais publicados ganham nova versão na fila.');
      navigate(`/commerce/publicacoes/${id}`);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar.');
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Spinner label="Carregando publicação…" />;
  if (!detalhe) {
    return (
      <div className="space-y-4">
        <PageHeader title="Editar publicação" />
        <Alert tone="red">{erro || 'Publicação não encontrada.'}</Alert>
      </div>
    );
  }

  const rotulo = rotuloCanal(detalhe.publicacao.canal);

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title={`Editar publicação · ${rotulo}`}
        description={`${detalhe.produto.nome} — preço do canal, vigência e metadados. O preço final é recalculado no servidor; salvar gera nova versão na fila.`}
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/publicacoes/${id}`)}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Detalhe
          </button>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}

      <form
        className="space-y-4 rounded-xl border border-line bg-surface p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void salvar(false);
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Preço do canal ({rotulo}) *</span>
            <input className="input mt-1" inputMode="decimal" required value={preco} onChange={(e) => setPreco(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Preço promocional (vazio = sem promoção)</span>
            <input className="input mt-1" inputMode="decimal" value={precoPromo} onChange={(e) => setPrecoPromo(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Vigência — início</span>
            <input type="date" className="input mt-1" value={vigenciaInicio} onChange={(e) => setVigenciaInicio(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Vigência — fim (vazio = sem fim)</span>
            <input type="date" className="input mt-1" value={vigenciaFim} min={vigenciaInicio || undefined} onChange={(e) => setVigenciaFim(e.target.value)} />
          </label>
        </div>

        <label className="block text-sm">
          <span className="text-ink-soft">Metadados por canal (JSON)</span>
          <textarea
            className="input mt-1 font-mono text-xs"
            rows={6}
            spellCheck={false}
            value={metadados}
            onChange={(e) => setMetadados(e.target.value)}
            placeholder={'{"ml_category_id": "MLB123"}'}
          />
          <span className="mt-1 block text-xs text-muted">
            Ex.: ml_category_id exigido pelo Mercado Livre — sem ele a publicação responde o erro real da API.
          </span>
        </label>

        <div className="flex flex-wrap gap-3">
          <button type="submit" className="btn-primary" disabled={salvando}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar'}
          </button>
          <button type="button" className="btn-secondary" disabled={salvando} onClick={() => void salvar(true)}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Salvar e reprocessar
          </button>
          <button type="button" className="btn-ghost" onClick={() => navigate(`/commerce/publicacoes/${id}`)}>
            Cancelar
          </button>
        </div>
      </form>
    </div>
  );
}
