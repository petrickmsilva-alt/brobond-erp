// ============================================================================
// REPRESENTANTE — PÁGINA DO CADASTRO (ficha + painel)
//
// A rota `/representantes/:id` é uma PÁGINA, no padrão LISTA → PÁGINA do
// BROBOND ERP: nada de modal, drawer, sheet, overlay ou portal.
//
// A página NÃO calcula indicador: ela apresenta o que o servidor derivou das
// fontes oficiais em UM contrato (`GET /api/comercial/representantes/:id/painel`):
//   • cadastro (identidade, documento PF/PJ, contato, endereço);
//   • estrutura comercial — território, equipes e hierarquia, que continuam
//     vivendo em `territorios`, `equipe_membros` e `representante_hierarquia`;
//   • carteira temporal (`representante_cliente`), com vigência;
//   • metas e realizado (derivado das vendas faturadas);
//   • comissão (padrão do cadastro + apuração/efetivação do motor);
//   • indicadores e ranking (mesma fonte do Painel Comercial).
//
// O cadastro completo abre em `/representantes/:id/editar`.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Briefcase,
  Building2,
  IdCard,
  Loader2,
  Mail,
  MapPinned,
  Network,
  Pencil,
  Phone,
  RefreshCw,
  Target,
  TrendingUp,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { Card, CardHeader, StatCard } from '../components/ui-kit-negocios';
import { formatPhone } from '../lib/format';

type ClienteCarteira = {
  cliente_id: number;
  cliente: string;
  cliente_ativo: boolean | null;
  inicio: string | null;
  fim: string | null;
  status: string;
  participacao_pct: number;
  vigente: boolean;
};

type Equipe = {
  equipe_id: number;
  equipe: string;
  papel: string;
  participacao_pct: number;
  entrada: string | null;
  saida: string | null;
  status: string;
  vigente: boolean;
};

type MetaLinha = {
  meta_id: number;
  metrica: string;
  periodo_inicio: string | null;
  periodo_fim: string | null;
  status: string;
  meta: number;
  realizado: number;
  atingimento_pct: number | null;
  falta: number;
};

type Painel = {
  representante: {
    id: number;
    codigo: string | null;
    nome: string | null;
    tipo_pessoa: string;
    tipo_representante: string;
    cpf: string | null;
    cnpj: string | null;
    razao_social: string | null;
    nome_fantasia: string | null;
    cargo: string | null;
    registro_profissional: string | null;
    orgao_registro: string | null;
    data_nascimento: string | null;
    admissao: string | null;
    desligamento: string | null;
    ativo: boolean;
    comissao_pct: number;
    contato: { telefone: string | null; celular: string | null; whatsapp: string | null; email: string | null };
    endereco: {
      cep: string | null;
      logradouro: string | null;
      numero: string | null;
      complemento: string | null;
      bairro: string | null;
      cidade: string | null;
      uf: string | null;
      pais: string | null;
    };
    regiao_legado: string | null;
  };
  estrutura: {
    territorio: { id: number; nome: string; codigo?: string | null; tipo?: string | null; uf?: string | null; cidade?: string | null } | null;
    equipes: Equipe[];
    hierarquia: {
      supervisores: { representante_id: number; nome: string; nivel: string; inicio: string | null }[];
      subordinados: { representante_id: number; nome: string; nivel: string; inicio: string | null }[];
    };
  };
  carteira: {
    vigentes: number;
    encerrados: number;
    cancelados: number;
    total: number;
    clientes_ativos: number;
    clientes_inativos: number;
    clientes: ClienteCarteira[];
  };
  metas: { total: number; ativas: number; linhas: MetaLinha[] };
  comissao: {
    padrao_pct: number;
    apurado_total: number;
    estornado_total: number;
    efetivado_total: number;
    apuracoes: number;
    eventos: number;
  };
  indicadores: {
    vendas: number;
    faturamento: number;
    pedidos: number;
    clientes: number;
    pecas: number;
    ticket_medio: number;
    comissao: number;
    meta: number | null;
    atingimento_pct: number | null;
  };
  ranking: { posicao: number | null; total: number; faturamento: number };
};

const moeda = (v: number) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v || 0);
const numero = (v: number) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v || 0);
const dataBR = (iso: string | null) => {
  if (!iso) return '—';
  const [a, m, d] = iso.slice(0, 10).split('-');
  return a && m && d ? `${d}/${m}/${a}` : iso;
};
const documento = (v: string | null) => {
  if (!v) return '—';
  const d = v.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return v;
};
const cep = (v: string | null) => (v && v.length === 8 ? `${v.slice(0, 5)}-${v.slice(5)}` : v || '—');

const ROTULO_METRICA: Record<string, string> = {
  faturamento: 'Faturamento',
  quantidade: 'Quantidade (peças)',
  margem: 'Margem',
  pedidos: 'Pedidos',
  clientes: 'Clientes atendidos',
};

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{rotulo}</dt>
      <dd className="mt-0.5 text-sm text-slate-800 dark:text-navy-100">{children}</dd>
    </div>
  );
}

export default function RepresentanteDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [painel, setPainel] = useState<Painel | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [naoEncontrado, setNaoEncontrado] = useState(false);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    if (!id) return;
    setCarregando(true);
    setNaoEncontrado(false);
    try {
      const dados = await api.get<Painel>(`/comercial/representantes/${id}/painel`);
      setPainel(dados);
      setErro('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setNaoEncontrado(true);
        return;
      }
      setErro(e instanceof ApiError ? e.message : 'Não foi possível abrir o painel do representante.');
    } finally {
      setCarregando(false);
    }
  }, [id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  if (!id) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Representante" description="Selecione um representante na lista." />
        <Link to="/representantes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  if (carregando) {
    return (
      <div className="p-4 sm:p-6">
        <Spinner label="Carregando representante..." />
      </div>
    );
  }

  if (naoEncontrado) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Representante não encontrado" description="O registro não existe ou não pertence à empresa ativa." />
        <Alert tone="amber">
          Não encontramos este representante na empresa ativa. Ele pode ter sido excluído ou pertencer a outra empresa. Volte para a lista para escolher um
          registro válido.
        </Alert>
        <Link to="/representantes" className="btn-secondary mt-4 inline-flex">
          <ArrowLeft className="h-4 w-4" /> Voltar para a lista
        </Link>
      </div>
    );
  }

  if (erro || !painel) {
    return (
      <div className="p-4 sm:p-6">
        <PageHeader title="Representante" description="Não foi possível abrir o painel." />
        <Alert tone="red">{erro || 'Painel indisponível.'}</Alert>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link to="/representantes" className="btn-secondary inline-flex">
            <ArrowLeft className="h-4 w-4" /> Voltar para a lista
          </Link>
          <button className="btn-secondary inline-flex" onClick={() => void carregar()}>
            <RefreshCw className="h-4 w-4" /> Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  const rep = painel.representante;
  const endereco = [
    [rep.endereco.logradouro, rep.endereco.numero].filter(Boolean).join(', '),
    rep.endereco.complemento,
    rep.endereco.bairro,
    [rep.endereco.cidade, rep.endereco.uf].filter(Boolean).join('/'),
    cep(rep.endereco.cep),
    rep.endereco.pais,
  ].filter(Boolean);

  const atingimento = painel.indicadores.atingimento_pct;

  return (
    <div className="p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <IdCard className="h-5 w-5" />
            </span>
            <span>
              {rep.nome}
              {rep.codigo ? <span className="ml-2 text-sm font-normal text-slate-500">({rep.codigo})</span> : null}
            </span>
            <Badge tone={rep.ativo ? 'green' : 'slate'}>{rep.ativo ? 'Ativo' : 'Inativo'}</Badge>
            {rep.desligamento ? <Badge tone="amber">Desligado em {dataBR(rep.desligamento)}</Badge> : null}
          </span>
        }
        description={`${rep.tipo_pessoa === 'PJ' ? 'Pessoa jurídica' : 'Pessoa física'} · ${rep.tipo_representante.replace(/_/g, ' ').toLowerCase()}${
          rep.cargo ? ` · ${rep.cargo}` : ''
        }`}
        actions={
          <>
            <Link to="/representantes" className="btn-secondary inline-flex" aria-label="Voltar para a lista de representantes">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">Voltar</span>
            </Link>
            <button className="btn-secondary inline-flex" onClick={() => void carregar()}>
              <RefreshCw className="h-4 w-4" /> <span className="hidden sm:inline">Atualizar</span>
            </button>
            <button className="btn-primary inline-flex" onClick={() => navigate(`/representantes/${rep.id}/editar`)}>
              <Pencil className="h-4 w-4" /> Editar cadastro
            </button>
          </>
        }
      />

      {/* ---- Indicadores ESSENCIAIS (derivados, nunca digitados) ---- */}
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Clientes na carteira" value={String(painel.carteira.vigentes)} hint={`${painel.carteira.total} vínculo(s) no histórico`} icon={UsersRound} />
        <StatCard label="Faturamento" value={moeda(painel.indicadores.faturamento)} hint={`${painel.indicadores.pedidos} pedido(s) faturado(s)`} icon={TrendingUp} />
        <StatCard
          label="Atingimento"
          value={atingimento === null ? '—' : `${numero(atingimento)}%`}
          hint={painel.indicadores.meta === null ? 'Sem meta ativa no período' : `Meta ${moeda(painel.indicadores.meta)}`}
          icon={Target}
        />
        <StatCard
          label="Comissão apurada"
          value={moeda(painel.comissao.apurado_total)}
          hint={painel.ranking.posicao ? `Ranking: ${painel.ranking.posicao}º de ${painel.ranking.total}` : 'Sem ranking no período'}
          icon={Wallet}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ---- Identificação ---- */}
        <Card className="p-4 sm:p-5">
          <CardHeader title="Identificação" subtitle="Cadastro mestre do representante" icon={IdCard} />
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo rotulo="Código">{rep.codigo || '—'}</Campo>
            <Campo rotulo="Tipo de representante">{rep.tipo_representante.replace(/_/g, ' ').toLowerCase()}</Campo>
            <Campo rotulo="Tipo de pessoa">{rep.tipo_pessoa}</Campo>
            <Campo rotulo={rep.tipo_pessoa === 'PJ' ? 'CNPJ' : 'CPF'}>{documento(rep.tipo_pessoa === 'PJ' ? rep.cnpj : rep.cpf)}</Campo>
            {rep.razao_social ? <Campo rotulo="Razão social">{rep.razao_social}</Campo> : null}
            {rep.nome_fantasia ? <Campo rotulo="Nome fantasia">{rep.nome_fantasia}</Campo> : null}
            <Campo rotulo="Cargo">{rep.cargo || '—'}</Campo>
            <Campo rotulo="Registro profissional">
              {rep.registro_profissional ? `${rep.registro_profissional}${rep.orgao_registro ? ` · ${rep.orgao_registro}` : ''}` : '—'}
            </Campo>
            <Campo rotulo="Nascimento">{dataBR(rep.data_nascimento)}</Campo>
            <Campo rotulo="Admissão">{dataBR(rep.admissao)}</Campo>
            <Campo rotulo="Desligamento">{dataBR(rep.desligamento)}</Campo>
            <Campo rotulo="Comissão padrão">{numero(rep.comissao_pct)}%</Campo>
          </dl>
        </Card>

        {/* ---- Contato + endereço ---- */}
        <Card className="p-4 sm:p-5">
          <CardHeader title="Contato e endereço" subtitle="Dados profissionais do cadastro" icon={Phone} />
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo rotulo="Telefone comercial">{rep.contato.telefone ? formatPhone(rep.contato.telefone) : '—'}</Campo>
            <Campo rotulo="Celular">{rep.contato.celular ? formatPhone(rep.contato.celular) : '—'}</Campo>
            <Campo rotulo="WhatsApp">{rep.contato.whatsapp ? formatPhone(rep.contato.whatsapp) : '—'}</Campo>
            <Campo rotulo="E-mail">{rep.contato.email ? <span className="inline-flex items-center gap-1"><Mail className="h-3.5 w-3.5" />{rep.contato.email}</span> : '—'}</Campo>
          </dl>
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-navy-800">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Endereço</dt>
            <dd className="mt-1 flex items-start gap-1.5 text-sm text-slate-800 dark:text-navy-100">
              <MapPinned className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" aria-hidden="true" />
              <span>{endereco.length ? endereco.join(' · ') : 'Endereço não informado.'}</span>
            </dd>
          </div>
        </Card>

        {/* ---- Estrutura comercial (fonte: domínios próprios) ---- */}
        <Card className="p-4 sm:p-5">
          <CardHeader title="Estrutura comercial" subtitle="Território, equipe e hierarquia — cada um no seu domínio" icon={Network} />
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo rotulo="Território">
              {painel.estrutura.territorio ? (
                <span>
                  {painel.estrutura.territorio.nome}
                  {painel.estrutura.territorio.codigo ? ` (${painel.estrutura.territorio.codigo})` : ''}
                </span>
              ) : (
                '—'
              )}
            </Campo>
            <Campo rotulo="Região (legado)">{rep.regiao_legado || '—'}</Campo>
            <Campo rotulo="Superior imediato">
              {painel.estrutura.hierarquia.supervisores.length
                ? painel.estrutura.hierarquia.supervisores.map((s) => `${s.nome} (${s.nivel})`).join(' · ')
                : '—'}
            </Campo>
            <Campo rotulo="Subordinados">
              {painel.estrutura.hierarquia.subordinados.length
                ? painel.estrutura.hierarquia.subordinados.map((s) => s.nome).join(' · ')
                : '—'}
            </Campo>
          </dl>
          <div className="mt-4 border-t border-slate-100 pt-3 dark:border-navy-800">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Equipes</dt>
            {painel.estrutura.equipes.length ? (
              <ul className="mt-1 space-y-1 text-sm">
                {painel.estrutura.equipes.map((e) => (
                  <li key={`${e.equipe_id}-${e.entrada ?? ''}`} className="flex flex-wrap items-center gap-2">
                    <UsersRound className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    <span className="font-medium">{e.equipe}</span>
                    <span className="text-slate-500">· {e.papel}</span>
                    <span className="text-slate-500">
                      · {dataBR(e.entrada)} → {e.saida ? dataBR(e.saida) : 'atual'}
                    </span>
                    <Badge tone={e.vigente ? 'green' : 'slate'}>{e.vigente ? 'Vigente' : 'Encerrada'}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-slate-500">Nenhuma equipe vinculada.</p>
            )}
          </div>
        </Card>

        {/* ---- Comissão ---- */}
        <Card className="p-4 sm:p-5">
          <CardHeader title="Comissão" subtitle="Apuração e efetivação pelo motor existente" icon={Briefcase} />
          <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Campo rotulo="Padrão do cadastro">{numero(painel.comissao.padrao_pct)}%</Campo>
            <Campo rotulo="Apurado (motor)">{moeda(painel.comissao.apurado_total)}</Campo>
            <Campo rotulo="Efetivado (recebimento)">{moeda(painel.comissao.efetivado_total)}</Campo>
            <Campo rotulo="Estornado">{moeda(painel.comissao.estornado_total)}</Campo>
            <Campo rotulo="Apurações">{painel.comissao.apuracoes}</Campo>
            <Campo rotulo="Eventos financeiros">{painel.comissao.eventos}</Campo>
          </dl>
          <p className="mt-3 text-xs text-slate-500">
            O percentual do cadastro é referência. A comissão efetiva é resolvida por plano/regra/atribuição e efetivada conforme o recebimento — este painel
            apenas lê o motor.
          </p>
        </Card>

        {/* ---- Carteira ---- */}
        <Card className="p-4 sm:p-5 xl:col-span-2">
          <CardHeader
            title="Carteira de clientes"
            subtitle={`${painel.carteira.vigentes} vigente(s) · ${painel.carteira.encerrados} encerrado(s) · ${painel.carteira.cancelados} cancelado(s)`}
            icon={UsersRound}
            actions={
              <Link to="/carteira-clientes" className="btn-secondary text-xs">
                Abrir módulo
              </Link>
            }
          />
          {painel.carteira.clientes.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-navy-800">
                    <th className="py-2 pr-3">Cliente</th>
                    <th className="py-2 pr-3">Início</th>
                    <th className="py-2 pr-3">Fim</th>
                    <th className="py-2 pr-3">Participação</th>
                    <th className="py-2 pr-3">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.carteira.clientes.map((c) => (
                    <tr key={`${c.cliente_id}-${c.inicio ?? ''}`} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                      <td className="py-2 pr-3">
                        <span className="font-medium">{c.cliente}</span>
                        {c.cliente_ativo === false ? <span className="ml-2 text-xs text-slate-400">(cliente inativo)</span> : null}
                      </td>
                      <td className="py-2 pr-3">{dataBR(c.inicio)}</td>
                      <td className="py-2 pr-3">{c.fim ? dataBR(c.fim) : '—'}</td>
                      <td className="py-2 pr-3">{numero(c.participacao_pct)}%</td>
                      <td className="py-2 pr-3">
                        <Badge tone={c.vigente ? 'green' : c.status === 'cancelado' ? 'red' : 'slate'}>
                          {c.vigente ? 'Vigente' : c.status === 'cancelado' ? 'Cancelado' : 'Encerrado'}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              icon={<UsersRound className="h-6 w-6" />}
              title="Sem clientes na carteira"
              description="A carteira é temporal e vive no módulo Carteira de clientes — este painel só apresenta o que está lá."
            />
          )}
        </Card>

        {/* ---- Metas ---- */}
        <Card className="p-4 sm:p-5 xl:col-span-2">
          <CardHeader
            title="Metas"
            subtitle="O realizado é calculado a partir das vendas faturadas no período"
            icon={Target}
            actions={
              <Link to="/metas" className="btn-secondary text-xs">
                Abrir módulo
              </Link>
            }
          />
          {painel.metas.linhas.length ? (
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-400 dark:border-navy-800">
                    <th className="py-2 pr-3">Métrica</th>
                    <th className="py-2 pr-3">Período</th>
                    <th className="py-2 pr-3">Meta</th>
                    <th className="py-2 pr-3">Realizado</th>
                    <th className="py-2 pr-3">Atingimento</th>
                    <th className="py-2 pr-3">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {painel.metas.linhas.map((m) => (
                    <tr key={m.meta_id} className="border-b border-slate-100 last:border-0 dark:border-navy-800">
                      <td className="py-2 pr-3">{ROTULO_METRICA[m.metrica] ?? m.metrica}</td>
                      <td className="py-2 pr-3">
                        {dataBR(m.periodo_inicio)} → {dataBR(m.periodo_fim)}
                      </td>
                      <td className="py-2 pr-3">{m.metrica === 'faturamento' ? moeda(m.meta) : numero(m.meta)}</td>
                      <td className="py-2 pr-3">{m.metrica === 'faturamento' ? moeda(m.realizado) : numero(m.realizado)}</td>
                      <td className="py-2 pr-3">{m.atingimento_pct === null ? '—' : `${numero(m.atingimento_pct)}%`}</td>
                      <td className="py-2 pr-3">
                        <Badge tone={m.status === 'ativa' ? 'green' : 'slate'}>{m.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={<Target className="h-6 w-6" />} title="Sem metas para este representante" description="As metas vivem no módulo Metas e não são duplicadas no cadastro." />
          )}
        </Card>

        {/* ---- Indicadores ---- */}
        <Card className="p-4 sm:p-5 xl:col-span-2">
          <CardHeader title="Indicadores" subtitle="Derivados das vendas faturadas — nenhum valor digitado" icon={TrendingUp} />
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Campo rotulo="Vendas">{numero(painel.indicadores.vendas)}</Campo>
            <Campo rotulo="Pedidos">{numero(painel.indicadores.pedidos)}</Campo>
            <Campo rotulo="Faturamento">{moeda(painel.indicadores.faturamento)}</Campo>
            <Campo rotulo="Ticket médio">{moeda(painel.indicadores.ticket_medio)}</Campo>
            <Campo rotulo="Clientes atendidos">{numero(painel.indicadores.clientes)}</Campo>
            <Campo rotulo="Peças">{numero(painel.indicadores.pecas)}</Campo>
            <Campo rotulo="Comissão">{moeda(painel.indicadores.comissao)}</Campo>
            <Campo rotulo="Ranking">
              {painel.ranking.posicao ? `${painel.ranking.posicao}º de ${painel.ranking.total}` : '—'}
            </Campo>
          </dl>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
            Todos os números são da empresa ativa — a mesma fonte do Painel Comercial.
          </p>
        </Card>
      </div>
    </div>
  );
}
