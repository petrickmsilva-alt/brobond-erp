// ============================================================================
// FISCAL — CALENDÁRIO DE OBRIGAÇÕES ACESSÓRIAS (módulo /fiscal/calendario)
//
// O ERP NÃO calcula imposto e NÃO escreve alíquota. O que esta página controla:
//   • qual obrigação vence em qual competência (vencimento DERIVADO);
//   • o que está pendente, atrasado, entregue ou dispensado;
//   • a PROVA da entrega (protocolo + arquivo), registrada inline.
//
// ZERO MODAL: registrar entrega é um bloco inline na própria linha/abaixo da
// lista; dispensar idem, com motivo obrigatório no mesmo campo de texto.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CheckCircle2, Loader2, RefreshCw, Upload } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { StatCard } from '../components/ui-kit-negocios';
import { formatDate } from '../lib/format';

type Status = 'pendente' | 'entregue' | 'atrasada' | 'dispensada';

type Linha = {
  obrigacao_id: number;
  codigo: string;
  nome: string;
  tipo: string;
  periodicidade: string;
  competencia: string;
  vencimento: string;
  status: Status;
  entrega_id: number | null;
  protocolo: string | null;
  arquivo_ref: string | null;
  entregue_em: string | null;
  motivo_dispensa: string | null;
  dias_para_vencer: number;
};

type Calendario = {
  de: string;
  ate: string;
  hoje: string;
  regra: string;
  resumo: {
    obrigacoes_ativas: number;
    linhas: number;
    pendentes: number;
    atrasadas: number;
    entregues: number;
    dispensadas: number;
    proximas: number;
  };
  obrigacoes: Linha[];
};

const TOM: Record<Status, 'amber' | 'blue' | 'green' | 'red' | 'slate'> = {
  pendente: 'amber',
  entregue: 'green',
  atrasada: 'red',
  dispensada: 'slate',
};

const ROTULO: Record<Status, string> = {
  pendente: 'Pendente',
  entregue: 'Entregue',
  atrasada: 'Atrasada',
  dispensada: 'Dispensada',
};

const mesAtual = () => new Date().toISOString().slice(0, 7);
const somarMeses = (competencia: string, n: number) => {
  const [ano, mes] = competencia.split('-').map(Number);
  const d = new Date(Date.UTC(ano, mes - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

export default function FiscalCalendarioPage() {
  const toast = useToast();
  const [de, setDe] = useState(somarMeses(mesAtual(), -2));
  const [ate, setAte] = useState(somarMeses(mesAtual(), 1));
  const [dados, setDados] = useState<Calendario | null>(null);
  const [erro, setErro] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [aberta, setAberta] = useState<string | null>(null);
  const [protocolo, setProtocolo] = useState('');
  const [arquivo, setArquivo] = useState('');
  const [motivo, setMotivo] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      setDados(await api.get<Calendario>(`/fiscal/calendario?de=${de}&ate=${ate}`));
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o calendário fiscal.');
    } finally {
      setCarregando(false);
    }
  }, [de, ate]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  function abrir(l: Linha) {
    const chave = `${l.obrigacao_id}#${l.competencia}`;
    setAberta(aberta === chave ? null : chave);
    setProtocolo(l.protocolo ?? '');
    setArquivo(l.arquivo_ref ?? '');
    setMotivo('');
  }

  async function registrar(l: Linha, status: 'entregue' | 'dispensada') {
    if (status === 'entregue' && !protocolo.trim()) {
      toast.error('Informe o protocolo da entrega — sem ele não existe prova.');
      return;
    }
    if (status === 'dispensada' && !motivo.trim()) {
      toast.error('Informe o motivo da dispensa.');
      return;
    }
    setOcupado(true);
    try {
      await api.post(`/fiscal/obrigacoes/${l.obrigacao_id}/entregas`, {
        competencia: l.competencia,
        status,
        protocolo: status === 'entregue' ? protocolo.trim() : undefined,
        arquivo_ref: arquivo.trim() || undefined,
        motivo_dispensa: status === 'dispensada' ? motivo.trim() : undefined,
      });
      toast.success(status === 'entregue' ? 'Entrega registrada.' : 'Obrigação dispensada.');
      setAberta(null);
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível registrar.');
    } finally {
      setOcupado(false);
    }
  }

  const linhas = useMemo(() => dados?.obrigacoes ?? [], [dados]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Calendário fiscal"
        description="Obrigações acessórias por competência: vencimento calculado, situação atual e a prova de cada entrega. O ERP controla prazo e protocolo — não calcula imposto."
        actions={
          <button type="button" onClick={() => void carregar()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Competência inicial</span>
          <input type="month" value={de} onChange={(e) => setDe(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-medium text-slate-600">Competência final</span>
          <input type="month" value={ate} onChange={(e) => setAte(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
        </label>
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      {carregando ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Atrasadas" value={String(dados?.resumo.atrasadas ?? 0)} hint="Vencidas e sem entrega registrada." />
            <StatCard label="Vencem em 30 dias" value={String(dados?.resumo.proximas ?? 0)} hint="Pendentes com vencimento próximo." />
            <StatCard label="Entregues" value={String(dados?.resumo.entregues ?? 0)} hint="Com protocolo registrado." />
            <StatCard label="Obrigações cadastradas" value={String(dados?.resumo.obrigacoes_ativas ?? 0)} hint="Regras ativas da empresa." />
          </div>

          {linhas.length === 0 ? (
            <EmptyState
              icon={<CalendarClock className="h-5 w-5" />}
              title="Nenhuma obrigação neste período"
              description="Cadastre as obrigações da empresa em Fiscal › Obrigações fiscais (código, periodicidade e dia de vencimento). O calendário é derivado desse cadastro."
            />
          ) : (
            <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Obrigação</th>
                    <th className="px-4 py-2">Competência</th>
                    <th className="px-4 py-2">Vencimento</th>
                    <th className="px-4 py-2">Situação</th>
                    <th className="px-4 py-2">Prova</th>
                    <th className="px-4 py-2 text-right">Ação</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {linhas.map((l) => {
                    const chave = `${l.obrigacao_id}#${l.competencia}`;
                    return (
                      <>
                        <tr key={chave} className={aberta === chave ? 'bg-slate-50' : undefined}>
                          <td className="px-4 py-2">
                            <span className="block font-medium text-slate-700">{l.nome}</span>
                            <span className="text-xs text-slate-400">{l.codigo} · {l.periodicidade}</span>
                          </td>
                          <td className="px-4 py-2 text-slate-600">{l.competencia}</td>
                          <td className={`px-4 py-2 ${l.status === 'atrasada' ? 'font-medium text-red-600' : 'text-slate-600'}`}>
                            {formatDate(l.vencimento)}
                            {l.status === 'pendente' && <span className="ml-1 text-xs text-slate-400">(em {l.dias_para_vencer} d)</span>}
                          </td>
                          <td className="px-4 py-2"><Badge tone={TOM[l.status]}>{ROTULO[l.status]}</Badge></td>
                          <td className="px-4 py-2 text-xs text-slate-500">
                            {l.status === 'entregue' ? `protocolo ${l.protocolo}` : l.status === 'dispensada' ? `dispensa: ${l.motivo_dispensa}` : '—'}
                          </td>
                          <td className="px-4 py-2 text-right">
                            {l.status !== 'entregue' && (
                              <button type="button" onClick={() => abrir(l)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100">
                                <Upload className="h-3.5 w-3.5" /> {l.status === 'dispensada' ? 'Revisar' : 'Registrar'}
                              </button>
                            )}
                            {l.status === 'entregue' && (
                              <span className="inline-flex items-center gap-1 text-xs text-emerald-700"><CheckCircle2 className="h-3.5 w-3.5" /> em dia</span>
                            )}
                          </td>
                        </tr>
                        {aberta === chave && (
                          <tr key={`${chave}-form`} className="bg-slate-50">
                            <td colSpan={6} className="px-4 py-3">
                              <div className="flex flex-wrap items-end gap-3">
                                <label className="text-sm">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">Protocolo</span>
                                  <input value={protocolo} onChange={(e) => setProtocolo(e.target.value)} className="w-56 rounded-lg border border-slate-300 px-2 py-1.5" placeholder="Protocolo da entrega" />
                                </label>
                                <label className="text-sm">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">Arquivo / referência</span>
                                  <input value={arquivo} onChange={(e) => setArquivo(e.target.value)} className="w-64 rounded-lg border border-slate-300 px-2 py-1.5" placeholder="sped/2026-01.txt" />
                                </label>
                                <label className="text-sm">
                                  <span className="mb-1 block text-xs font-medium text-slate-600">Motivo (só para dispensar)</span>
                                  <input value={motivo} onChange={(e) => setMotivo(e.target.value)} className="w-64 rounded-lg border border-slate-300 px-2 py-1.5" placeholder="Ex.: sem movimento no período" />
                                </label>
                                <div className="flex gap-2 pb-0.5">
                                  <button
                                    type="button"
                                    disabled={ocupado}
                                    onClick={() => void registrar(l, 'entregue')}
                                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                                  >
                                    {ocupado && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Registrar entrega
                                  </button>
                                  <button
                                    type="button"
                                    disabled={ocupado}
                                    onClick={() => void registrar(l, 'dispensada')}
                                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                                  >
                                    Dispensar
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">{dados?.regra}</p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
