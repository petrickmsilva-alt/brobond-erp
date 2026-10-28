// ============================================================================
// CUSTO DE FABRICAÇÃO — criação de ficha técnica em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: "Nova ficha técnica" navega para
// `/custo/nova`. Depois de criar, a ficha abre em `/fichas/:id`, onde os
// insumos são adicionados.
//
// A tela NÃO calcula custo nem preço: `custo_calculado` e `preco_sugerido` vêm
// do servidor (fórmula canônica em `server/src/custoRecebimento.ts` e no motor
// de fichas). Aqui só entram mão de obra, indiretos e margem.
// ============================================================================
import { useState } from 'react';
import { Loader2, Save, Tag } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, PageHeader, useToast } from '../components/ui';
import { ProductSelector } from '../components/ProductSelector';

type Ficha = { id: number };

export default function NovaFichaPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const podeCriar = user?.perfil !== 'operador';

  const [form, setForm] = useState({ produto_id: '', mao_obra: '0', custos_indiretos: '0', margem_pct: '0' });
  const [erro, setErro] = useState('');
  const [criando, setCriando] = useState(false);

  async function criar() {
    if (!form.produto_id) {
      setErro('Selecione o produto.');
      return;
    }
    const n = (v: string) => Number(String(v).replace(',', '.')) || 0;
    setCriando(true);
    setErro('');
    try {
      const criado = await api.post<Ficha>('/fichas', {
        produto_id: Number(form.produto_id),
        mao_obra: n(form.mao_obra),
        custos_indiretos: n(form.custos_indiretos),
        margem_pct: n(form.margem_pct),
      });
      toast.success('Ficha criada. Adicione os insumos e aplique o preço ao produto.');
      navigate(`/fichas/${criado.id}`);
    } catch (e) {
      setErro((e as Error).message || 'Não foi possível criar a ficha (o produto pode já ter uma).');
    } finally {
      setCriando(false);
    }
  }

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Tag className="h-5 w-5 text-navy-600" />
            Nova ficha técnica
          </span>
        }
        description="Depois de criar, você adiciona os insumos na página da ficha. O custo é calculado pelo servidor com o custo médio de cada insumo."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/custo')} disabled={criando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-accent" onClick={() => void criar()} disabled={criando || !podeCriar}>
              {criando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {criando ? 'Criando...' : 'Criar ficha'}
            </button>
          </div>
        }
      />

      {!podeCriar && (
        <Alert tone="amber">
          Seu perfil não cria ficha técnica. Peça a um gerente ou administrador — a listagem e o detalhe continuam
          disponíveis.
        </Alert>
      )}

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="card mx-auto max-w-2xl space-y-4 p-5">
        <label className="block">
          <span className="label">Produto</span>
          <ProductSelector
            value={form.produto_id}
            aria-label="Produto da ficha de custo"
            onChange={(_id, product) =>
              setForm((f) => ({
                ...f,
                produto_id: product ? String(product.produto_pai_id ?? product.id) : '',
              }))
            }
          />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="block" htmlFor="ficha-mao-obra">
            <span className="label">Mão de obra (R$)</span>
            <input id="ficha-mao-obra" className="input" value={form.mao_obra} onChange={(e) => setForm((f) => ({ ...f, mao_obra: e.target.value }))} inputMode="decimal" />
          </label>
          <label className="block" htmlFor="ficha-indiretos">
            <span className="label">Indiretos (R$)</span>
            <input id="ficha-indiretos" className="input" value={form.custos_indiretos} onChange={(e) => setForm((f) => ({ ...f, custos_indiretos: e.target.value }))} inputMode="decimal" />
          </label>
          <label className="block" htmlFor="ficha-margem">
            <span className="label">Margem (%)</span>
            <input id="ficha-margem" className="input" value={form.margem_pct} onChange={(e) => setForm((f) => ({ ...f, margem_pct: e.target.value }))} inputMode="decimal" />
          </label>
        </div>
        <p className="text-xs text-slate-400">
          Custo unitário = Σ(insumo × (1 + perda%) × custo médio) + mão de obra + indiretos. Preço sugerido = custo × (1 +
          margem%). Nenhum desses números é calculado nesta tela.
        </p>
      </div>
    </div>
  );
}
