// ============================================================================
// COTAÇÃO DE COMPRA — formulário de CRIAÇÃO em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL: a criação de uma cotação NUNCA abre um painel sobreposto à
// listagem. O botão "Nova cotação" navega para esta rota
// (`/cotacoes-compra/novo`); após criar, o documento abre em
// `/cotacoes-compra/:id`. Nenhuma regra de negócio foi alterada: o servidor
// continua recebendo título, critério e validade e definindo o estado.
// ============================================================================
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Loader2, Save } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, PageHeader, useToast } from '../components/ui';
import { CRITERIOS } from './CotacoesCompraPage';

export default function CotacoesCompraFormPage({ modo = 'novo' }: { modo?: 'novo' | 'editar' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const perfil = user?.perfil;

  const [titulo, setTitulo] = useState('');
  const [criterio, setCriterio] = useState('menor_preco');
  const [prazo, setPrazo] = useState('');
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  async function gravar() {
    if (!titulo.trim()) {
      setErro('Dê um título à cotação.');
      return;
    }
    setErro('');
    setSalvando(true);
    try {
      const criada = await api.post<{ id: number }>('/cotacoes_compra', {
        titulo: titulo.trim(),
        criterio,
        prazo_validade: prazo || null,
      });
      toast.success('Cotação criada. Adicione os itens e convide os fornecedores.');
      navigate(`/cotacoes-compra/${criada.id}`);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Não foi possível criar a cotação.';
      setErro(msg);
      toast.error(msg);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <AlertTriangle className="h-5 w-5 text-navy-600" />
            {modo === 'novo' ? 'Nova cotação de compra' : 'Editar cotação de compra'}
          </span>
        }
        description="Peça preço a vários fornecedores, compare lado a lado e gere o pedido de compra uma única vez."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/cotacoes-compra')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-accent" onClick={gravar} disabled={salvando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {salvando ? 'Criando...' : 'Criar cotação'}
            </button>
          </div>
        }
      />

      <div className="mx-auto max-w-2xl space-y-4">
        {!['admin', 'gerente'].includes(perfil ?? '') && (
          <Alert tone="amber">
            Você pode montar cotações e registrar respostas de fornecedores, mas <strong>decidir</strong> (gerar o pedido) e cancelar exigem perfil de gerente ou administrador.
          </Alert>
        )}

        {erro && <Alert tone="red">{erro}</Alert>}

        <section className="card p-5">
          <div className="space-y-4">
            <label className="block">
              <span className="label">Título</span>
              <input
                className="input w-full"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Ex.: Cotação de tecidos — outubro"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="label">Critério de decisão</span>
              <select className="input w-full" value={criterio} onChange={(e) => setCriterio(e.target.value)}>
                {CRITERIOS.map((c) => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">{CRITERIOS.find((c) => c.value === criterio)?.hint}</p>
            </label>
            <label className="block">
              <span className="label">Validade das propostas</span>
              <input type="date" className="input w-full" value={prazo} onChange={(e) => setPrazo(e.target.value)} />
            </label>
            <Alert tone="blue">Depois de criada, adicione os itens e convide os fornecedores. Convidar já abre a cotação para respostas.</Alert>
          </div>
        </section>
      </div>
    </div>
  );
}
