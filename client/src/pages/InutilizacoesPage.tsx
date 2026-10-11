// ============================================================================
// INUTILIZAÇÕES DE NUMERAÇÃO — ERP-05 (P1-03: existia só na API)
//
// Inutilizar é a obrigação acessória que comunica à SEFAZ que uma faixa de
// numeração NÃO será usada (falha de energia, quebra de sequência, erro de
// sistema). O endpoint é `POST /api/fiscal/inutilizar` e o histórico é o
// recurso `inutilizacoes_fiscais`.
//
// A regra de honestidade desta tela (a mesma do resto do Fiscal): ela NUNCA
// afirma homologação que a SEFAZ não confirmou.
//
//   • o servidor responde 200 quando o provedor CONFIRMA a inutilização e 202
//     quando apenas registra a solicitação (provedor em processamento/nulo);
//   • a tela repete na íntegra a mensagem do provedor e o status real gravado
//     (`pendente`, `homologado`, `rejeitado`, `erro`), sem "sucesso" otimista;
//   • sem provedor fiscal configurado o pedido continua sendo registrado e
//     auditado — a tela diz exatamente isso, em vez de esconder.
//
//   Campos mínimos exigidos pela SEFAZ, validados antes de sair daqui:
//   série, faixa inicial/final e justificativa com 15+ caracteres.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileMinus, Info, RefreshCw, Search } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

type Inutilizacao = {
  id: number;
  modelo: string | null;
  serie: number | null;
  numero_inicial: number | null;
  numero_final: number | null;
  justificativa: string | null;
  ambiente: string | null;
  status: string | null;
  protocolo: string | null;
  motivo: string | null;
  provider: string | null;
  criado_em: string | null;
};

type Resposta = Inutilizacao & { homologado?: boolean; mensagem?: string };

const ROTULO: Record<string, string> = {
  pendente: 'Pendente',
  homologado: 'Homologada',
  rejeitado: 'Rejeitada',
  erro: 'Erro',
};

const TOM: Record<string, 'slate' | 'blue' | 'amber' | 'green' | 'red'> = {
  pendente: 'amber',
  homologado: 'green',
  rejeitado: 'red',
  erro: 'red',
};

const MODELOS = [
  { value: '55', label: 'NF-e (modelo 55)' },
  { value: '65', label: 'NFC-e (modelo 65)' },
];

type Formulario = { modelo: string; serie: string; numero_inicial: string; numero_final: string; justificativa: string };
const FORM_VAZIO: Formulario = { modelo: '55', serie: '1', numero_inicial: '', numero_final: '', justificativa: '' };

function faixa(i: Inutilizacao): string {
  const a = i.numero_inicial ?? null;
  const b = i.numero_final ?? null;
  if (a === null || b === null) return '—';
  return a === b ? String(a) : `${a} a ${b}`;
}

export default function InutilizacoesPage() {
  const toast = useToast();
  const { user } = useAuth();
  const podeSolicitar = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<Inutilizacao[]>([]);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [form, setForm] = useState<Formulario>(FORM_VAZIO);
  const [erroForm, setErroForm] = useState<Record<string, string>>({});
  const [resultado, setResultado] = useState<Resposta | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<Inutilizacao>>('/inutilizacoes_fiscais?page=1&pageSize=100&sort=id&dir=desc');
      setLinhas(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as inutilizações.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return linhas;
    return linhas.filter((i) =>
      `${i.id} ${i.modelo ?? ''} ${i.serie ?? ''} ${i.numero_inicial ?? ''} ${i.numero_final ?? ''} ${i.status ?? ''} ${i.protocolo ?? ''} ${i.justificativa ?? ''}`
        .toLowerCase()
        .includes(q)
    );
  }, [linhas, busca]);

  const solicitar = async () => {
    const campos: Record<string, string> = {};
    const serie = Number(form.serie);
    const inicial = Number(form.numero_inicial);
    const final = Number(form.numero_final);
    const justificativa = form.justificativa.trim();

    if (!Number.isInteger(serie) || serie <= 0) campos.serie = 'Informe a série (número inteiro maior que zero).';
    if (!Number.isInteger(inicial) || inicial <= 0) campos.numero_inicial = 'Informe o número inicial da faixa.';
    if (!Number.isInteger(final) || final < inicial) campos.numero_final = 'O número final precisa ser maior ou igual ao inicial.';
    if (justificativa.length < 15) campos.justificativa = 'A justificativa precisa ter pelo menos 15 caracteres (exigência da SEFAZ).';

    if (Object.keys(campos).length) {
      setErroForm(campos);
      return;
    }

    setOcupado(true);
    setResultado(null);
    try {
      const r = await api.post<Resposta>('/fiscal/inutilizar', {
        modelo: form.modelo,
        serie,
        numero_inicial: inicial,
        numero_final: final,
        justificativa,
      });
      setResultado(r);
      if (r.homologado) {
        toast.success('Inutilização homologada pelo provedor fiscal.');
        setForm(FORM_VAZIO);
      } else {
        // 202: o provedor ainda não confirmou. A tela NÃO diz "homologado".
        toast.info('Solicitação registrada — aguardando homologação do provedor fiscal.');
      }
      setErroForm({});
      await carregar();
    } catch (e) {
      if (e instanceof ApiError) {
        setErroForm(e.fields ?? {});
        toast.error(e.message);
      } else {
        toast.error('Não foi possível solicitar a inutilização.');
      }
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Inutilizações de numeração"
        description="Comunique à SEFAZ as faixas de numeração que não serão usadas. O pedido é registrado e auditado aqui; a homologação depende do provedor fiscal configurado."
        actions={
          <button className="btn-ghost" onClick={() => void carregar()} disabled={carregando}>
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <Alert tone="blue">
        <span className="inline-flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Esta tela registra a solicitação e mostra o resultado real de cada pedido. Sem provedor fiscal configurado, o
            pedido fica <b>pendente</b> (nada é enviado à SEFAZ) — configure em Fiscal → Configuração para transmitir.
          </span>
        </span>
      </Alert>

      {podeSolicitar && (
        <div className="card p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
            <FileMinus className="h-4 w-4" /> Solicitar inutilização
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="label">
              Modelo
              <select className="input" value={form.modelo} onChange={(e) => setForm((f) => ({ ...f, modelo: e.target.value }))}>
                {MODELOS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="label">
              Série
              <input
                className={`input ${erroForm.serie ? 'input-error' : ''}`}
                inputMode="numeric"
                placeholder="1"
                value={form.serie}
                onChange={(e) => setForm((f) => ({ ...f, serie: e.target.value }))}
              />
              {erroForm.serie && <span className="mt-1 block text-xs normal-case text-red-600">{erroForm.serie}</span>}
            </label>

            <label className="label">
              Número inicial
              <input
                className={`input ${erroForm.numero_inicial ? 'input-error' : ''}`}
                inputMode="numeric"
                placeholder="100"
                value={form.numero_inicial}
                onChange={(e) => setForm((f) => ({ ...f, numero_inicial: e.target.value }))}
              />
              {erroForm.numero_inicial && <span className="mt-1 block text-xs normal-case text-red-600">{erroForm.numero_inicial}</span>}
            </label>

            <label className="label">
              Número final
              <input
                className={`input ${erroForm.numero_final ? 'input-error' : ''}`}
                inputMode="numeric"
                placeholder="110"
                value={form.numero_final}
                onChange={(e) => setForm((f) => ({ ...f, numero_final: e.target.value }))}
              />
              {erroForm.numero_final && <span className="mt-1 block text-xs normal-case text-red-600">{erroForm.numero_final}</span>}
            </label>
          </div>

          <label className="label mt-3">
            Justificativa
            <textarea
              className={`input min-h-20 ${erroForm.justificativa ? 'input-error' : ''}`}
              maxLength={255}
              placeholder="Ex.: Quebra de sequência por falha de energia no servidor durante a emissão."
              value={form.justificativa}
              onChange={(e) => setForm((f) => ({ ...f, justificativa: e.target.value }))}
            />
          </label>
          <div className="mt-1 flex items-center justify-between">
            {erroForm.justificativa ? (
              <span className="text-xs text-red-600">{erroForm.justificativa}</span>
            ) : (
              <span className="text-xs text-slate-400">Mínimo de 15 caracteres — exigência da SEFAZ.</span>
            )}
            <span className="text-xs text-slate-400">{form.justificativa.trim().length}/255</span>
          </div>

          <div className="mt-3 flex justify-end">
            <button className="btn-accent" onClick={() => void solicitar()} disabled={ocupado}>
              {ocupado ? 'Enviando...' : 'Solicitar inutilização'}
            </button>
          </div>

          {resultado && (
            <Alert tone={resultado.homologado ? 'green' : 'amber'}>
              <div className="space-y-1">
                <div className="font-semibold">
                  {resultado.homologado
                    ? 'Inutilização homologada pelo provedor.'
                    : 'Solicitação registrada — o provedor ainda não homologou.'}
                </div>
                <div>
                  Status gravado: <b>{ROTULO[String(resultado.status)] ?? resultado.status ?? '—'}</b>
                  {resultado.protocolo ? ` · protocolo ${resultado.protocolo}` : ' · sem protocolo'}
                  {resultado.provider ? ` · provedor ${resultado.provider}` : ''}
                </div>
                {resultado.mensagem && <div className="text-xs">{resultado.mensagem}</div>}
                <div className="text-xs">
                  Registro #{resultado.id} · faixa {faixa(resultado)} · série {resultado.serie ?? '—'}
                </div>
              </div>
            </Alert>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input className="input pl-9" placeholder="Buscar por faixa, status, protocolo..." value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <Badge tone="slate">{linhas.length} registro(s)</Badge>
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="card overflow-hidden">
        {carregando ? (
          <Spinner label="Carregando inutilizações..." />
        ) : visiveis.length === 0 ? (
          <EmptyState
            icon={<FileMinus className="h-6 w-6" />}
            title={busca ? 'Nada encontrado' : 'Nenhuma inutilização registrada'}
            description={
              busca
                ? 'Nenhuma faixa corresponde à busca.'
                : 'Quando uma faixa de numeração precisar ser descartada, solicite aqui — o pedido fica registrado e auditado.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Modelo</th>
                <th className="px-2 py-2">Série</th>
                <th className="px-3 py-2">Faixa</th>
                <th className="px-3 py-2">Justificativa</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Protocolo</th>
                <th className="px-3 py-2">Criada</th>
              </tr>
            </thead>
            <tbody>
              {visiveis.map((i) => (
                <tr key={i.id} className="border-b border-slate-50 dark:border-navy-800">
                  <td className="px-3 py-2 text-slate-400">{i.id}</td>
                  <td className="px-3 py-2">{i.modelo === '65' ? 'NFC-e (65)' : 'NF-e (55)'}</td>
                  <td className="px-2 py-2 tabular-nums">{i.serie ?? '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs tabular-nums">{faixa(i)}</td>
                  <td className="max-w-64 px-3 py-2">
                    <div className="truncate" title={i.justificativa ?? ''}>
                      {i.justificativa ?? '—'}
                    </div>
                    {i.motivo && <div className="truncate text-[11px] text-red-600" title={i.motivo}>{i.motivo}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={TOM[String(i.status)] ?? 'slate'}>{ROTULO[String(i.status)] ?? i.status ?? '—'}</Badge>
                    {i.ambiente && <div className="mt-0.5 text-[11px] text-slate-400">{i.ambiente}</div>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{i.protocolo ?? '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">{i.criado_em ? formatDateTime(String(i.criado_em)) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
