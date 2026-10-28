// ============================================================================
// EMPRESAS — administração multiempresa (ERP-07, fecha o P1-04).
//
// O que esta tela resolve: até aqui, criar a segunda empresa do grupo exigia
// API/SQL, e o CRUD genérico de `empresas` **não tinha alçada nenhuma** — o
// menu não expunha o recurso e o servidor não restringia perfil (o `audit:menu`
// não sinalizava: ponto cego do P2-05). Agora:
//
//   • `empresas` é `adminOnly` no servidor — a tela só aparece para quem pode;
//   • criar/editar/ativar/excluir empresa acontece aqui, sem SQL manual;
//   • a EXCLUSÃO diz por que não pode (empresa padrão, com acesso de usuário ou
//     com dados) em vez de estourar erro de banco;
//   • os ACESSOS (quem entra em cada empresa) são concedidos e revogados aqui,
//     pelos endpoints de `usuario_empresas` — que são adminOnly de verdade;
//   • trocar a EMPRESA ATIVA da sessão continua no seletor do topo
//     (`POST /api/empresas/ativa`), que devolve token novo — não é esta tela.
//
// Nada aqui decide sozinho: quem manda é o servidor. Se a guarda recusar, a
// mensagem do servidor é o que aparece.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Building2, KeyRound, Pencil, Plus, Power, Trash2, Users } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { maskDocument } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PainelInline, PageHeader, Spinner, useToast } from '../components/ui';

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

type Usuario = { id: number; nome: string; email: string; perfil: string; ativo?: boolean | null };
type Acesso = { id: number; nome?: string | null };

const CAMPOS: Array<{ nome: keyof Empresa | 'razao_social' | 'nome_fantasia' | 'cnpj' | 'telefone' | 'email'; rotulo: string; tipo?: string; obrigatorio?: boolean }> = [
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

export default function EmpresasPage() {
  const toast = useToast();

  const [carregando, setCarregando] = useState(true);
  const [empresas, setEmpresas] = useState<Empresa[]>([]);
  const [erro, setErro] = useState('');

  const [editando, setEditando] = useState<Empresa | null>(null);
  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState<Formulario>(VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState('');

  const [excluindo, setExcluindo] = useState<Empresa | null>(null);
  const [excluindoErro, setExcluindoErro] = useState('');
  const [excluindoBusy, setExcluindoBusy] = useState(false);

  const [acessosDe, setAcessosDe] = useState<Empresa | null>(null);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [acessos, setAcessos] = useState<Record<number, number[]>>({});
  const [ocupadoAcesso, setOcupadoAcesso] = useState<number | null>(null);
  const [carregandoAcessos, setCarregandoAcessos] = useState(false);

  const empresaPadrao = useMemo(() => empresas.find((e) => Number(e.id) === 1) || null, [empresas]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Empresa>>('/empresas?page=1&pageSize=100&sort=nome&dir=asc');
      setEmpresas(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as empresas.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrirNovo = () => {
    setForm(VAZIO);
    setErroForm('');
    setEditando(null);
    setCriando(true);
  };

  const abrirEdicao = (e: Empresa) => {
    setForm(paraFormulario(e));
    setErroForm('');
    setCriando(false);
    setEditando(e);
  };

  const salvar = async () => {
    if (!form.nome.trim()) {
      setErroForm('Informe o nome da empresa.');
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
    setErroForm('');
    try {
      if (editando) await api.put(`/empresas/${editando.id}`, { ...corpo, ativo: form.ativo });
      else await api.post('/empresas', corpo);
      toast.success(editando ? 'Empresa atualizada.' : 'Empresa criada.');
      setCriando(false);
      setEditando(null);
      await carregar();
    } catch (e) {
      setErroForm(e instanceof ApiError ? e.message : 'Não foi possível salvar a empresa.');
    } finally {
      setSalvando(false);
    }
  };

  const alternarAtivo = async (e: Empresa) => {
    const ativo = e.ativo === false;
    try {
      await api.put(`/empresas/${e.id}`, { ativo });
      toast.success(ativo ? `“${e.nome}” reativada.` : `“${e.nome}” desativada.`);
      await carregar();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Não foi possível alterar a situação.');
    }
  };

  const confirmarExclusao = async () => {
    if (!excluindo) return;
    setExcluindoBusy(true);
    setExcluindoErro('');
    try {
      await api.del(`/empresas/${excluindo.id}`);
      toast.success('Empresa excluída.');
      setExcluindo(null);
      await carregar();
    } catch (e) {
      // A guarda é do SERVIDOR (empresa padrão, com acessos ou com dados) — a
      // mensagem dele é mostrada como veio, em vez de um "erro" genérico.
      setExcluindoErro(e instanceof ApiError ? e.message : 'Não foi possível excluir a empresa.');
    } finally {
      setExcluindoBusy(false);
    }
  };

  const abrirAcessos = async (e: Empresa) => {
    setAcessosDe(e);
    setCarregandoAcessos(true);
    setAcessos({});
    try {
      const d = await api.get<ListResult<Usuario>>('/usuarios?page=1&pageSize=100&sort=nome&dir=asc');
      setUsuarios(d.rows);
      // Uma consulta por usuário (o endpoint de concessões é por usuário). Em
      // lote para não abrir 100 conexões de uma vez.
      const mapa: Record<number, number[]> = {};
      const lote = 8;
      for (let i = 0; i < d.rows.length; i += lote) {
        const fatia = d.rows.slice(i, i + lote);
        const respostas = await Promise.all(
          fatia.map(async (u) => {
            try {
              const r = await api.get<{ empresas: Acesso[] }>(`/usuarios/${u.id}/empresas`);
              return [u.id, (r.empresas || []).map((x) => Number(x.id))] as const;
            } catch {
              return [u.id, [] as number[]] as const;
            }
          })
        );
        for (const [id, ids] of respostas) mapa[id] = ids;
      }
      setAcessos(mapa);
    } catch (e2) {
      toast.error(e2 instanceof ApiError ? e2.message : 'Não foi possível carregar os usuários.');
    } finally {
      setCarregandoAcessos(false);
    }
  };

  const conceder = async (usuarioId: number) => {
    if (!acessosDe) return;
    setOcupadoAcesso(usuarioId);
    try {
      await api.post(`/usuarios/${usuarioId}/empresas`, { empresa_id: acessosDe.id });
      setAcessos((a) => ({ ...a, [usuarioId]: [...(a[usuarioId] || []), acessosDe.id] }));
      toast.success('Acesso concedido.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível conceder o acesso.');
    } finally {
      setOcupadoAcesso(null);
    }
  };

  const revogar = async (usuarioId: number) => {
    if (!acessosDe) return;
    setOcupadoAcesso(usuarioId);
    try {
      await api.del(`/usuarios/${usuarioId}/empresas/${acessosDe.id}`);
      setAcessos((a) => ({ ...a, [usuarioId]: (a[usuarioId] || []).filter((id) => id !== acessosDe.id) }));
      toast.success('Acesso revogado.');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível revogar o acesso.');
    } finally {
      setOcupadoAcesso(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Empresas"
        description="Empresas do grupo. Cada cadastro, venda e lançamento pertence a UMA empresa — os dados nunca se misturam. Trocar a empresa ativa da sessão é no seletor do topo."
        actions={
          <button className="btn-primary" onClick={abrirNovo}>
            <Plus className="mr-1 h-4 w-4" /> Nova empresa
          </button>
        }
      />

      {erro && (
        <div className="mb-4">
          <Alert tone="amber">{erro}</Alert>
        </div>
      )}

      {empresaPadrao && (
        <div className="mb-4">
          <Alert tone="blue">
            <strong>{empresaPadrao.nome}</strong> é a empresa padrão (id 1): o motor analítico, as vendas
            multicanal e o provisionamento de local apontam para ela, e o servidor <strong>recusa</strong> excluí-la.
            Empresa com acessos de usuário ou com dados também não é excluída — desative em vez de excluir.
          </Alert>
        </div>
      )}

      <div className="card overflow-hidden">
        {carregando ? (
          <div className="flex justify-center p-10">
            <Spinner />
          </div>
        ) : empresas.length === 0 ? (
          <EmptyState icon={<Building2 className="h-6 w-6" />} title="Nenhuma empresa" description="Crie a primeira empresa do grupo." />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Empresa</th>
                <th>CNPJ</th>
                <th>Contato</th>
                <th>Situação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {empresas.map((e) => (
                <tr key={e.id}>
                  <td>
                    <p className="font-medium">{e.nome}</p>
                    {e.razao_social && <p className="text-xs text-slate-500 dark:text-slate-400">{e.razao_social}</p>}
                  </td>
                  <td className="tabular-nums">{e.cnpj ? maskDocument(String(e.cnpj)) : '—'}</td>
                  <td className="text-xs text-slate-500 dark:text-slate-400">
                    {[e.telefone, e.email].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td>
                    {e.ativo === false ? <Badge tone="slate">desativada</Badge> : <Badge tone="green">ativa</Badge>}
                    {Number(e.id) === 1 && <span className="ml-2 text-xs text-slate-400">padrão</span>}
                  </td>
                  <td className="text-right">
                    <div className="flex justify-end gap-1">
                      <button className="btn-ghost" title="Acessos" onClick={() => void abrirAcessos(e)}>
                        <Users className="h-4 w-4" />
                      </button>
                      <button className="btn-ghost" title="Editar" onClick={() => abrirEdicao(e)}>
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        className="btn-ghost"
                        title={e.ativo === false ? 'Reativar' : 'Desativar'}
                        onClick={() => void alternarAtivo(e)}
                        disabled={Number(e.id) === 1}
                      >
                        <Power className="h-4 w-4" />
                      </button>
                      <button
                        className="btn-ghost text-red-600"
                        title="Excluir"
                        onClick={() => {
                          setExcluindoErro('');
                          setExcluindo(e);
                        }}
                        disabled={Number(e.id) === 1}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ------------------------------------------------ criar / editar ----- */}
      <PainelInline
        open={criando || editando !== null}
        onClose={() => {
          setCriando(false);
          setEditando(null);
        }}
        title={editando ? `Editar ${editando.nome}` : 'Nova empresa'}
        subtitle="A empresa criada aqui entra no seletor do topo assim que o acesso for concedido a alguém."
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <button
              className="btn-secondary"
              onClick={() => {
                setCriando(false);
                setEditando(null);
              }}
            >
              Cancelar
            </button>
            <button className="btn-primary" onClick={() => void salvar()} disabled={salvando}>
              {salvando ? 'Salvando…' : 'Salvar'}
            </button>
          </div>
        }
      >
        {erroForm && (
          <div className="mb-3">
            <Alert tone="red">{erroForm}</Alert>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {CAMPOS.map((c) => (
            <div key={c.nome} className={c.nome === 'nome' ? 'sm:col-span-2' : ''}>
              <label className="label" htmlFor={`empresa-${c.nome}`}>
                {c.rotulo}
                {c.obrigatorio ? ' *' : ''}
              </label>
              <input
                id={`empresa-${c.nome}`}
                type={c.tipo || 'text'}
                className="input"
                value={String((form as unknown as Record<string, unknown>)[c.nome] ?? '')}
                onChange={(ev) => setForm((f) => ({ ...f, [c.nome]: ev.target.value }))}
              />
            </div>
          ))}
          {editando && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.ativo} onChange={(ev) => setForm((f) => ({ ...f, ativo: ev.target.checked }))} />
              Empresa ativa
            </label>
          )}
        </div>
      </PainelInline>

      {/* ------------------------------------------------------- exclusão ---- */}
      <ConfirmacaoInline
        open={excluindo !== null}
        title={`Excluir ${excluindo?.nome ?? ''}?`}
        message={
          excluindoErro
            ? excluindoErro
            : 'Excluir uma empresa é definitivo. Empresa com dados, com acessos de usuário ou a empresa padrão é recusada pelo servidor — nesse caso, desative.'
        }
        confirmLabel="Excluir"
        danger
        busy={excluindoBusy}
        onConfirm={() => void confirmarExclusao()}
        onCancel={() => setExcluindo(null)}
      />

      {/* -------------------------------------------------------- acessos ---- */}
      <PainelInline
        open={acessosDe !== null}
        onClose={() => setAcessosDe(null)}
        title={acessosDe ? `Quem entra em ${acessosDe.nome}` : 'Acessos'}
        subtitle="Conceder acesso permite que o usuário trabalhe com esta empresa e a escolha no seletor do topo. Revogar tira o registro, não o histórico dele nas outras empresas."
        size="lg"
      >
        {carregandoAcessos ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : usuarios.length === 0 ? (
          <EmptyState icon={<KeyRound className="h-6 w-6" />} title="Nenhum usuário cadastrado" description="Crie usuários em Administração → Usuários." />
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Usuário</th>
                  <th>Perfil</th>
                  <th>Acesso</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {usuarios.map((u) => {
                  const tem = (acessos[u.id] || []).includes(Number(acessosDe?.id));
                  return (
                    <tr key={u.id}>
                      <td>
                        <p className="font-medium">{u.nome}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">{u.email}</p>
                      </td>
                      <td>
                        <Badge tone={u.perfil === 'admin' ? 'blue' : u.perfil === 'gerente' ? 'amber' : 'slate'}>{u.perfil}</Badge>
                      </td>
                      <td>{tem ? <Badge tone="green">com acesso</Badge> : <span className="text-xs text-slate-400">sem acesso</span>}</td>
                      <td className="text-right">
                        <button
                          className={tem ? 'btn-secondary' : 'btn-primary'}
                          disabled={ocupadoAcesso === u.id}
                          onClick={() => void (tem ? revogar(u.id) : conceder(u.id))}
                        >
                          {tem ? 'Revogar' : 'Conceder'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </PainelInline>
    </div>
  );
}
