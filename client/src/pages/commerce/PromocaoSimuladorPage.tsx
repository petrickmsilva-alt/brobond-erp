// ============================================================================
// COMMERCE — SIMULADOR DE PROMOÇÕES (página própria, ZERO MODAL).
// /commerce/promocoes/simulador
//
// Mostra, para um carrinho informado, o desconto de CADA promoção candidata e
// qual venceria — a MESMA regra pura do checkout (o backend recalcula). Nada é
// gravado. Serve para o gestor enxergar a precedência antes de publicar.
// ============================================================================
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Plus, Trash2, Wand2 } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../../components/ui';
import { formatMoney } from '../../lib/format';

type LinhaItem = { produto_id: string; quantidade: string; preco_unitario: string; categoria_id: string };

type Candidata = { id: number; nome: string; desconto: number; base: number };
type Resposta = {
  subtotal: number;
  canal: string | null;
  candidatas: Candidata[];
  melhor: { id: number; nome: string; desconto: number; base: number } | null;
  cupom: { codigo?: string; desconto?: number; erro?: string } | null;
  desconto_aplicado: number;
  origem: string;
  total: number;
};

const LINHA_VAZIA: LinhaItem = { produto_id: '', quantidade: '1', preco_unitario: '', categoria_id: '' };

export default function CommercePromocaoSimuladorPage() {
  const navigate = useNavigate();
  const [linhas, setLinhas] = useState<LinhaItem[]>([{ ...LINHA_VAZIA }]);
  const [canal, setCanal] = useState('');
  const [cupom, setCupom] = useState('');
  const [resultado, setResultado] = useState<Resposta | null>(null);
  const [erro, setErro] = useState('');
  const [busy, setBusy] = useState(false);

  const atualizarLinha = (idx: number, campo: keyof LinhaItem, valor: string) =>
    setLinhas((ls) => ls.map((l, i) => (i === idx ? { ...l, [campo]: valor } : l)));

  const simular = async () => {
    setBusy(true);
    setErro('');
    try {
      const itens = linhas
        .filter((l) => l.produto_id.trim() && l.preco_unitario.trim())
        .map((l) => ({
          produto_id: Number(l.produto_id),
          quantidade: Number(l.quantidade || 1),
          preco_unitario: Number(l.preco_unitario),
          categoria_id: l.categoria_id.trim() ? Number(l.categoria_id) : null,
        }));
      if (itens.length === 0) throw new ApiError(400, 'Informe ao menos um item (produto, quantidade e preço).');
      const corpo: Record<string, unknown> = { itens };
      if (canal) corpo.canal = canal;
      if (cupom.trim()) corpo.cupom = cupom.trim();
      const r = await apiFetch<Resposta>('/commerce/promocoes/simular', { method: 'POST', body: JSON.stringify(corpo) });
      setResultado(r);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao simular.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        title="Simulador de promoções"
        description="Simula o desconto de um carrinho usando a MESMA regra do checkout. Nada é gravado."
        actions={
          <button type="button" className="btn-ghost" onClick={() => navigate('/commerce/promocoes')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Promoções
          </button>
        }
      />
      {erro && <Alert tone="red">{erro}</Alert>}
      <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-ink-soft">Canal</span>
            <select className="input mt-1" value={canal} onChange={(e) => setCanal(e.target.value)}>
              <option value="">(não informado)</option>
              <option value="varejo">Varejo</option>
              <option value="atacado">Atacado</option>
            </select>
          </label>
          <label className="block text-sm">
            <span className="text-ink-soft">Cupom (opcional)</span>
            <input className="input mt-1" value={cupom} onChange={(e) => setCupom(e.target.value)} placeholder="Ex.: BEMVINDO10" />
          </label>
        </div>
        <div className="space-y-2">
          {linhas.map((l, idx) => (
            <div key={idx} className="grid grid-cols-12 items-end gap-2">
              <label className="col-span-3 text-xs">
                <span className="text-ink-soft">Produto #</span>
                <input className="input mt-1" inputMode="numeric" value={l.produto_id} onChange={(e) => atualizarLinha(idx, 'produto_id', e.target.value)} />
              </label>
              <label className="col-span-2 text-xs">
                <span className="text-ink-soft">Qtd</span>
                <input className="input mt-1" inputMode="numeric" value={l.quantidade} onChange={(e) => atualizarLinha(idx, 'quantidade', e.target.value)} />
              </label>
              <label className="col-span-3 text-xs">
                <span className="text-ink-soft">Preço un.</span>
                <input className="input mt-1" inputMode="decimal" value={l.preco_unitario} onChange={(e) => atualizarLinha(idx, 'preco_unitario', e.target.value)} />
              </label>
              <label className="col-span-3 text-xs">
                <span className="text-ink-soft">Categoria #</span>
                <input className="input mt-1" inputMode="numeric" value={l.categoria_id} onChange={(e) => atualizarLinha(idx, 'categoria_id', e.target.value)} />
              </label>
              <button
                type="button"
                className="col-span-1 btn-ghost"
                aria-label="Remover linha"
                disabled={linhas.length === 1}
                onClick={() => setLinhas((ls) => ls.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button type="button" className="btn-secondary" onClick={() => setLinhas((ls) => [...ls, { ...LINHA_VAZIA }])}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Adicionar linha
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void simular()}>
            <Wand2 className="h-4 w-4" aria-hidden="true" /> {busy ? 'Simulando…' : 'Simular'}
          </button>
        </div>
      </div>

      {busy && <Spinner label="Calculando…" />}
      {resultado && (
        <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span>
              Subtotal: <strong>{formatMoney(resultado.subtotal)}</strong>
            </span>
            <span>
              Desconto aplicado: <strong>{formatMoney(resultado.desconto_aplicado)}</strong>
            </span>
            <span>
              Origem: <Badge tone={resultado.origem === 'cupom' ? 'blue' : 'green'}>{resultado.origem}</Badge>
            </span>
            <span>
              Total: <strong>{formatMoney(resultado.total)}</strong>
            </span>
          </div>
          {resultado.melhor ? (
            <p className="text-sm">
              Vencedora: <strong>{resultado.melhor.nome}</strong> (base elegível {formatMoney(resultado.melhor.base)})
            </p>
          ) : (
            <p className="text-sm text-muted">Nenhuma promoção elegível para este carrinho.</p>
          )}
          {resultado.cupom && (
            <p className="text-sm">
              {resultado.cupom.erro ? (
                <span className="text-red-600">Cupom: {resultado.cupom.erro}</span>
              ) : (
                <span>
                  Cupom {resultado.cupom.codigo}: {formatMoney(resultado.cupom.desconto ?? 0)}
                </span>
              )}
            </p>
          )}
          <table className="w-full text-sm">
            <caption className="sr-only">Candidatas por desconto</caption>
            <thead>
              <tr className="text-left text-ink-soft">
                <th className="py-1">Promoção</th>
                <th className="py-1 text-right">Base elegível</th>
                <th className="py-1 text-right">Desconto</th>
              </tr>
            </thead>
            <tbody>
              {resultado.candidatas.length === 0 ? (
                <tr>
                  <td colSpan={3} className="py-2 text-muted">
                    Nenhuma candidata.
                  </td>
                </tr>
              ) : (
                resultado.candidatas.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="py-1">{c.nome}</td>
                    <td className="py-1 text-right">{formatMoney(c.base)}</td>
                    <td className="py-1 text-right">{formatMoney(c.desconto)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
