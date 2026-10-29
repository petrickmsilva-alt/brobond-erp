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
import { ExternalLink, RefreshCw, Save, Store, Truck } from 'lucide-react';
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

type EstadoLoja = {
  configuracao: Config | null;
  empresa_id: number; status: string; abrir_loja: boolean; vitrine_disponivel: boolean; frete_configurado: boolean; responsavel_checkout_id: number | null;
  pagamento: { origem?: string; configurado: boolean; ativo: boolean; tem_token: boolean; tem_webhook: boolean; ambiente: string | null; conexao_validada: boolean; credenciais_ambiente_detectadas: boolean };
  pendencias: { codigo: string; mensagem: string; caminho: string | null }[];
};

type Formulario = {
  checkout_usuario_id: string;
  loja_nome: string;
  loja_descricao: string;
  frete_provedor: string;
  frete_valor: string;
  frete_gratis_acima: string;
  frete_prazo_dias: string;
  checkout_expira_minutos: string;
};

const VAZIO: Formulario = {
  checkout_usuario_id: '',
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
  const [estado, setEstado] = useState<EstadoLoja | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    setEstado(null);
    try {
      const situacao = await apiFetch<EstadoLoja>('/commerce/loja/estado');
      if (!Array.isArray(situacao.pendencias) || typeof situacao.abrir_loja !== 'boolean' || !('configuracao' in situacao)) throw new Error('Estado da loja inválido.');
      const linha = situacao.configuracao;
      setConfig(linha);
      setForm({
        checkout_usuario_id: linha?.checkout_usuario_id != null ? String(linha.checkout_usuario_id) : '',
        loja_nome: linha?.loja_nome ?? '',
        loja_descricao: linha?.loja_descricao ?? '',
        frete_provedor: linha?.frete_provedor ?? 'nenhum',
        frete_valor: linha?.frete_valor != null ? String(linha.frete_valor) : '',
        frete_gratis_acima: linha?.frete_gratis_acima != null ? String(linha.frete_gratis_acima) : '',
        frete_prazo_dias: linha?.frete_prazo_dias != null ? String(linha.frete_prazo_dias) : '',
        checkout_expira_minutos: linha?.checkout_expira_minutos != null ? String(linha.checkout_expira_minutos) : '60',
      });
      setEstado(situacao);
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
    if (!podeGerir || !estado) return;
    setSalvando(true);
    setErro('');
    try {
      const corpo = {
        checkout_usuario_id: form.checkout_usuario_id.trim() ? Number(form.checkout_usuario_id) : null,
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

  const freteOk = estado?.frete_configurado === true;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Loja própria"
        description="Configuração da vitrine em /loja: identidade, frete (FreightProvider), expiração do carrinho e responsável pelas linhas de checkout."
        actions={
          estado?.abrir_loja ? <a className="btn-secondary" href="/loja" target="_blank" rel="noreferrer">
            <ExternalLink className="h-4 w-4" aria-hidden="true" /> Abrir a Loja
          </a> : <button type="button" className="btn-secondary" disabled aria-describedby="estado-loja">Abrir a Loja</button>
        }
      />

      {erro && <Alert tone="red">{erro} <button type="button" className="btn-secondary" onClick={() => void carregar()}>Tentar novamente</button></Alert>}
      <section id="estado-loja" className="rounded-xl border border-line bg-surface p-4 space-y-3" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">Estado operacional salvo</h2>
          <Badge tone={estado?.abrir_loja ? 'green' : 'amber'}>{estado?.abrir_loja ? 'CONFIGURADO' : 'PENDENTE DE CONFIGURAÇÃO'}</Badge>
          <button type="button" className="btn-secondary" onClick={() => void carregar()}><RefreshCw className="h-4 w-4" aria-hidden="true" /> Verificar novamente</button>
        </div>
        {!estado ? <p className="text-sm text-muted">Não foi possível verificar a prontidão. Abrir a Loja permanece bloqueado até a verificação.</p> : <>
          <p className="text-sm text-muted">Vitrine: {estado.vitrine_disponivel ? 'DISPONÍVEL' : 'CONFIGURAÇÃO PENDENTE'} · Responsável resolvido: {estado.responsavel_checkout_id ? `#${estado.responsavel_checkout_id}` : 'pendente'} · Empresa #{estado.empresa_id}</p>
          {estado.pendencias.length > 0 && <ul className="list-disc pl-5 space-y-2 text-sm">{estado.pendencias.map((p) => <li key={p.codigo}>{p.mensagem} {p.caminho && <a className="text-primary underline" href={p.caminho}>Ver configuração</a>}</li>)}</ul>}
          <p className="text-xs text-muted">O estado reflete dados persistidos, não alterações ainda não salvas. Configurado não comprova conexão externa ou pagamento aprovado.</p>
        </>}
      </section>

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
            <label id="responsavel" className="block text-sm">
              <span className="text-ink-soft">Responsável pelo checkout (ID do usuário)</span>
              <input className="input mt-1" type="number" min={1} step={1} value={form.checkout_usuario_id} disabled={!podeGerir} placeholder="Automático: administrador ativo da empresa" onChange={(e) => setForm((f) => ({ ...f, checkout_usuario_id: e.target.value }))} />
            </label>
            <p className="rounded-lg bg-canvas p-3 text-xs text-muted">Vazio = administrador ativo desta empresa. Um responsável explícito deve estar ativo e autorizado na empresa; o checkout nunca usa um usuário de outro tenant.</p>
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
                Frete não configurado — CONFIGURAÇÃO PENDENTE. Selecione retirada na loja, se a operação oferece retirada, ou informe a tabela real de entrega da empresa e salve. Sem isso, o checkout permanece bloqueado.
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
              <Badge tone={freteOk ? 'green' : 'red'}>{freteOk ? 'CONFIGURADO' : 'PENDENTE DE CONFIGURAÇÃO'}</Badge>
            </div>
          </div>
        </section>
      </div>

      <section id="pagamento" className="rounded-xl border border-line bg-surface p-4 space-y-3">
        <h2 className="font-semibold">Mercado Pago — gateway do checkout</h2>
        <Badge tone={estado?.pagamento.configurado ? 'green' : 'amber'}>{estado?.pagamento.configurado ? 'CONFIGURADO' : 'PENDENTE DE CONFIGURAÇÃO'}</Badge>
        {estado && <p className="text-sm text-muted">Origem {estado.pagamento.origem === 'ambiente_commerce' ? 'ambiente seguro do servidor' : 'configuração por empresa'} · Gateway {estado.pagamento.ativo ? 'ativo' : 'inativo/ausente'} · Access Token {estado.pagamento.tem_token ? 'reconhecido' : 'ausente ou inválido'} · Webhook {estado.pagamento.tem_webhook ? 'configurado' : 'pendente'} · Ambiente {estado.pagamento.ambiente ?? 'não definido'}.</p>}
        <p className="text-sm text-muted">Nenhuma credencial é exibida ou alterada aqui. O canal de relatórios e o gateway de cobrança são configurações distintas. {estado?.pagamento.credenciais_ambiente_detectadas ? 'Credencial de ambiente detectada. O servidor a reutiliza somente para a empresa vinculada à vitrine e com o segredo de webhook presente; a configuração persistida tem prioridade.' : ''}</p>
        <a className="btn-secondary" href="/conectores/mercado-pago">Consultar integração Mercado Pago</a>
        <p className="text-sm text-muted">Webhook do checkout: <code>/api/gateway/webhooks/mercadopago</code> no domínio público do ERP. Confirme no painel do Mercado Pago que os eventos de pagamento são enviados para esse endereço, não somente ao webhook de relatórios do canal.</p>
        <p className="text-xs text-muted">Se o gateway estiver pendente, o responsável pelo deploy deve verificar o vínculo COMMERCE_LOJA_EMPRESA_ID e as variáveis já provisionadas MERCADOPAGO_ACCESS_TOKEN e MERCADOPAGO_WEBHOOK_SECRET. Para configuração persistida por empresa, a API existente é PUT /api/financeiro/gateway/config (admin com reautenticação). Esta instalação não possui tela financeira de configuração do gateway. Não recrie credenciais. A validação de conexão e o teste financeiro devem ser feitos no ambiente autorizado.</p>
      </section>
      <div className="flex items-center gap-3">
        {podeGerir ? (
          <button type="button" className="btn-primary" disabled={salvando || !estado} onClick={() => void salvar()}>
            <Save className="h-4 w-4" aria-hidden="true" /> {salvando ? 'Salvando…' : 'Salvar configuração'}
          </button>
        ) : (
          <Badge tone="slate">Somente leitura para o seu perfil</Badge>
        )}
        <span className="text-xs text-muted">
          Salve e confira as pendências acima para habilitar a abertura da loja.
        </span>
      </div>
    </div>
  );
}
