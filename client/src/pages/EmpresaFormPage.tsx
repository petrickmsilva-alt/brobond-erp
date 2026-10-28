// ============================================================================
// EMPRESAS — cadastro e edição em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: `/empresas/novo` e
// `/empresas/:id/editar` são páginas. A listagem apenas navega.
//
// Quem decide continua sendo o servidor: `empresas` é recurso adminOnly e a
// exclusão é guardada por vínculos (empresa padrão, acessos, dados). Esta tela
// não reproduz regra nenhuma — mostra a mensagem do servidor como veio.
// ============================================================================
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ListResult } from '../lib/meta';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';

type Empresa = {
  id: number;
  nome: string;
  razao_social?: string | null;
  nome_fantasia?: string | null;
  cnpj?: string | null;
  telefone?: string | null;
  email?: string | null;
  ativo?: boolean | null;
};

const CAMPOS: Array<{ nome: keyof Formulario; rotulo: string; tipo?: string; obrigatorio?: boolean }> = [
  { nome: 'nome', rotulo: 'Nome', obrigatorio: true },
  { nome: 'razao_social', rotulo: 'Razão social' },
  { nome: 'nome_fantasia', rotulo: 'Nome fantasia' },
  { nome: 'cnpj', rotulo: 'CNPJ' },
  { nome: 'telefone', rotulo: 'Telefone' },
  { nome: 'email', rotulo: 'E-mail', tipo: 'email' },
];

type Formulario = { nome: string; razao_social: string; nome_fantasia: string; cnpj: string; telefone: string; email: string; ativo: boolean };

const VAZIO: Formulario = { nome: '', razao_social: '', nome_fantasia: '', cnpj: '', telefone: '', email: '', ativo: true };

function paraFormulario(e: Empresa): Formulario {
  return {
    nome: String(e.nome || ''),
    razao_social: String(e.razao_social || ''),
    nome_fantasia: String(e.nome_fantasia || ''),
    cnpj: String(e.cnpj || ''),
    telefone: String(e.telefone || ''),
    email: String(e.email || ''),
    ativo: e.ativo !== false,
  };
}

export default function EmpresaFormPage({ modo = 'novo' }: { modo?: 'novo' | 'editar' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { id } = useParams();

  const [carregando, setCarregando] = useState(modo === 'editar');
  const [registro, setRegistro] = useState<Empresa | null>(null);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (modo !== 'editar') return;
    let vivo = true;
    (async () => {
      setCarregando(true);
      try {
        const d = await api.get<ListResult<Empresa>>('/empresas?page=1&pageSize=200&sort=nome&dir=asc');
        const achado = d.rows.find((e) => Number(e.id) === Number(id)) ?? null;
        if (!vivo) return;
        if (!achado) {
          setErro('Empresa não encontrada.');
          return;
        }
        setRegistro(achado);
        setForm(paraFormulario(achado));
      } catch (e) {
        if (vivo) setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a empresa.');
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [id, modo]);

  async function salvar() {
    if (!form.nome.trim()) {
      setErro('Informe o nome da empresa.');
      return;
    }
    const corpo: Record<string, unknown> = {
      nome: form.nome.trim(),
      razao_social: form.razao_social.trim() || null,
      nome_fantasia: form.nome_fantasia.trim() || null,
      cnpj: form.cnpj.trim() || null,
      telefone: form.telefone.trim() || null,
      email: form.email.trim() || null,
    };
    setSalvando(true);
    setErro('');
    try {
      if (modo === 'editar' && registro) await api.put(`/empresas/${registro.id}`, { ...corpo, ativo: form.ativo });
      else await api.post('/empresas', corpo);
      toast.success(modo === 'editar' ? 'Empresa atualizada.' : 'Empresa criada.');
      navigate('/empresas');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível salvar a empresa.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={modo === 'editar' ? `Editar ${registro?.nome ?? 'empresa'}` : 'Nova empresa'}
        description="A empresa criada aqui entra no seletor do topo assim que o acesso for concedido a alguém."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/empresas')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void salvar()} disabled={salvando || carregando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        }
      />

      {carregando && <Spinner label="Carregando empresa..." />}
      {erro && <Alert tone="red">{erro}</Alert>}

      {!carregando && (
        <div className="card mx-auto max-w-3xl p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {CAMPOS.map((c) => (
              <div key={c.nome} className={c.nome === 'nome' ? 'sm:col-span-2' : ''}>
                <label className="label" htmlFor={`empresa-${c.nome}`}>
                  {c.rotulo}
                  {c.obrigatorio ? ' *' : ''}
                  <input
                    id={`empresa-${c.nome}`}
                    type={c.tipo || 'text'}
                    className="input"
                    value={String(form[c.nome] ?? '')}
                    onChange={(ev) => setForm((f) => ({ ...f, [c.nome]: ev.target.value }))}
                  />
                </label>
              </div>
            ))}
            {modo === 'editar' && (
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={form.ativo} onChange={(ev) => setForm((f) => ({ ...f, ativo: ev.target.checked }))} />
                Empresa ativa
              </label>
            )}
          </div>
          <p className="mt-3 text-xs text-slate-400">
            Desativar é diferente de excluir: a empresa desativada mantém o histórico e pode ser reativada. A exclusão é
            recusada pelo servidor quando há vínculos.
          </p>
        </div>
      )}
    </div>
  );
}
