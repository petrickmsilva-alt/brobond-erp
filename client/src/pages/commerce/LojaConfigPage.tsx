// ============================================================================
// COMMERCE — LOJA PRÓPRIA (configuração da vitrine /loja). Rota /commerce/loja.
//
// Singleton por empresa (commerce_configuracoes): identidade da vitrine,
// FRETE via FreightProvider (nenhum | retirada | manual — "Frete não
// configurado" é estado legítimo exibido sem número), expiração do carrinho e
// responsável pelo checkout (vazio = admin ativo resolvido no servidor).
// Escrita: gerente/admin (recurso + módulo exigem gerente no backend).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Save, Store, Truck } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, PageHeader, Spinner, useToast } from '../../components/ui';
import { useAuth } from '../../auth/AuthContext';

type Config = {
  id: number;
  loja_nome: string | null;
  loja_descricao: string | null;
  frete_provedor: string;
  frete_valor: number | null;
  frete_gratis_acima: number | null;
  frete_prazo_dias: number | null;
  checkout_usuario_id: number | null;
  checkout_expira_minutos: number | null;
};

type Formulario = {
  loja_nome: string;
  loja_descricao: string;
  frete_provedor: string;
  frete_valor: string;
  frete_gratis_acima: string;
  frete_prazo_dias: string;
  checkout_expira_minutos: string;
};

const VAZIO: Formulario = {
  loja_nome: '',
  loja_descricao: '',
  frete_provedor: 'nenhum',
  frete_valor: '',
  frete_gratis_acima: '',
  frete_prazo_dias: '',
  checkout_expira_minutos: '60',
};

export default function CommerceLojaConfigPage() {
  const toast = useToast();
  const { user } = useAuth();
  const podeGerir = user?.perfil === 'gerente' || user?.perfil === 'admin';

  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState('');
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<{ rows?: Config[] }>(`/commerce_configuracoes?page=1&pageSize=5`);
      const linha = r.rows?.[0] ?? null;
      setConfig(linha);
      setForm({
        loja_nome: linha?.loja_nome ?? '',
        loja_descricao: linha?.loja_descricao ?? '',
        frete_provedor: linha?.frete_provedor ?? 'nenhum',
        frete_valor: linha?.frete_valor != null ? String(linha.frete_valor) : '',
        frete_gratis_acima: linha?.frete_gratis_acima != null ? String(linha.frete_gratis_acima) : '',
        frete_prazo_dias: linha?.frete_prazo_dias != null ? String(linha.frete_prazo_dias) : '',
        checkout_expira_minutos: linha?.checkout_expira_minutos != null ? String(linha.checkout_expira_minutos) : '60',
      });
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a configuração da loja.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const salvar = async () => {
    if (!podeGerir) return;
    setSalvando(true);
    setErro('');
    try {
      const corpo = {
        loja_nome: form.loja_nome.trim() || null,
        loja_descricao: form.loja_descricao.trim() || null,
        frete_provedor: form.frete_provedor,
        frete_valor: form.frete_provedor === 'manual' && form.frete_valor.trim() ? Number(form.frete_valor) : 0,
        frete_gratis_acima: form.frete_gratis_acima.trim() ? Number(form.frete_gratis_acima) : null,
        frete_prazo_dias: form.frete_prazo_dias.trim() ? Math.trunc(Number(form.frete_prazo_dias)) : null,
        checkout_expira_minutos: Math.min(1440, Math.max(5, Math.trunc(Number(form.checkout_expira_minutos) || 60))),
      };
      if (form.frete_provedor === 'manual' && !(Number(corpo.frete_valor) > 0)) {
        setErro('Com frete por tabela, informe um valor maior que zero (ou escolha retirada na loja).');
        return;
      }
      if (config) {
        await apiFetch(`/commerce_configuracoes/${config.id}`, { method: 'PUT', body: JSON.stringify(corpo) });
      } else {
        await apiFetch('/commerce_configuracoes', { method: 'POST', body: JSON.stringify(corpo) });
      }
      toast.success('Configuração da loja salva.');
      await carregar();
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao salvar a configuração.');
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) return <Spinner label="Carregando configuração da loja…" />;

  const freteOk = form.frete_provedor !== 'nenhum';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loja própria"
        description="Configuração da vitrine em /loja: identidade, frete (FreightProvider), expiração do carrinho e responsável pelas linhas de checkout."
        actions={
          <a className="btn-secondary" href="/loja" target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir a loja
          </a>
        }
      />

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="identidade">
          <h2 id="identidade" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Store className="h-4 w-4" aria-hidden="true" /> Identidade da vitrine
          </h2>
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="text-ink-soft">Nome da loja</span>
              <input
                className="input mt-1"
                value={form.loja_nome}
                disabled={!podeGerir}
                maxLength={120}
                placeholder="Ex.: BROBOND Store"
                onChange={(e) => setForm((f) => ({ ...f, loja_nome: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Descrição</span>
              <textarea
                className="input mt-1"
                rows={2}
                maxLength={500}
                disabled={!podeGerir}
                value={form.loja_descricao}
                onChange={(e) => setForm((f) => ({ ...f, loja_descricao: e.target.value }))}
              />
            </label>
            <label className="block text-sm">
              <span className="text-ink-soft">Expiração do carrinho (minutos, 5–1440)</span>
              <input
                className="input mt-1 w-40"
                type="number"
                min={5}
                max={1440}
                disabled={!podeGerir}
                value={form.checkout_expira_minutos}
                onChange={(e) => setForm((f) => ({ ...f, checkout_expira_minutos: e.target.value }))}
              />
            </label>
            <p className="rounded-lg bg-canvas p-3 text-xs text-muted">
              Responsável pelo checkout: {config?.checkout_usuario_id ? `usuário #${config.checkout_usuario_id}` : 'resolvido automaticamente (admin ativo da empresa)'}.
              O servidor recusa o checkout com instrução clara caso não exista ninguém elegível — nunca escolhe usuário
              de outra empresa.
            </p>
          </div>
        </section>

        <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="frete">
          <h2 id="frete" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
            <Truck className="h-4 w-4" aria-hidden="true" /> Frete (FreightProvider)
          </h2>
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="text-ink-soft">Provedor</span>
              <select
                className="input mt-1"
                value={form.frete_provedor}
                disabled={!podeGerir}
                onChange={(e) => setForm((f) => ({ ...f, frete_provedor: e.target.value }))}
              >
                <option value="nenhum">Não configurado (cotação indisponível)</option>
                <option value="retirada">Retirada na loja (grátis)</option>
                <option value="manual">Tabela manual (CIF)</option>
              </select>
            </label>
            {form.frete_provedor === 'nenhum' && (
              <Alert tone="amber">
                “Frete não configurado”: o carrinho mostra esta mensagem exata e o checkout recusa — nenhum valor de
                frete é inventado.
              </Alert>
            )}
            {form.frete_provedor === 'retirada' && (
              <p className="text-sm text-muted">Pedidos saem com frete R$ 0,00 e sem prazo de entrega (retirada no balcão).</p>
            )}
            {form.frete_provedor === 'manual' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-ink-soft">Valor do frete (R$)</span>
                  <input
                    className="input mt-1"
                    inputMode="decimal"
                    value={form.frete_valor}
                    disabled={!podeGerir}
                    onChange={(e) => setForm((f) => ({ ...f, frete_valor: e.target.value }))}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-soft">Frete grátis acima de (R$)</span>
                  <input
                    className="input mt-1"
                    inputMode="decimal"
                    value={form.frete_gratis_acima}
                    disabled={!podeGerir}
                    placeholder="vazio = sem isenção"
                    onChange={(e) => setForm((f) => ({ ...f, frete_gratis_acima: e.target.value }))}
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-ink-soft">Prazo (dias corridos)</span>
                  <input
                    className="input mt-1"
                    type="number"
                    min={0}
                    max={120}
                    value={form.frete_prazo_dias}
                    disabled={!podeGerir}
                    onChange={(e) => setForm((f) => ({ ...f, frete_prazo_dias: e.target.value }))}
                  />
                </label>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted">Estado atual:</span>
              <Badge tone={freteOk ? 'green' : 'red'}>{freteOk ? 'cotação ativa' : 'não configurado'}</Badge>
            </div>
          </div>
        </section>
      </div>

      <div className="flex items-center gap-3">
        {podeGerir ? (
          <button type="button" className="btn-primary" disabled={salvando} onClick={() => void salvar()}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar configuração'}
          </button>
        ) : (
          <Badge tone="slate">Somente leitura para o seu perfil</Badge>
        )}
        <span className="text-xs text-muted">
          Pagamentos da vitrine: Mercado Pago configurado em Financeiro → Gateway (obrigatório para o go-live).
        </span>
      </div>
    </div>
  );
}
