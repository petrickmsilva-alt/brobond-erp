// ============================================================================
// FISCAL — LEIAUTES SPED/EFD (módulo /fiscal/layouts)
//
// Mostra o REGISTRO VERSIONADO dos leiautes de EFD ICMS/IPI e
// EFD-Contribuições: código COD_VER, versão, ato normativo, vigência e a fonte
// oficial. Resolve qual versão VIGE num período de apuração e valida
// ESTRUTURALMENTE um arquivo EFD já montado (gramática, formatos, blocos,
// filhos obrigatórios, referências e totais).
//
// Limites (declarados na tela): o ERP NÃO gera, NÃO assina e NÃO transmite
// arquivo fiscal. A validação estrutural não substitui o PVA oficial nem
// declara homologação. A geração a partir dos documentos do ERP e a transmissão
// dependem de contador + ambiente fiscal.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCheck2, Info, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, useToast } from '../components/ui';
import { DataTable, PageError, PageLoading, PageShell, StatCard, type DataTableColumn } from '../components/ui-kit-negocios';
import { formatDate } from '../lib/format';

type Layout = {
  id: number;
  sistema: 'EFD_ICMS_IPI' | 'EFD_CONTRIBUICOES';
  codigo_versao: string;
  versao_leiaute: string;
  ato_normativo: string | null;
  vigencia_inicio: string;
  vigencia_fim: string | null;
  fonte_url: string;
  consultado_em: string;
  registros: string[];
};

type Problema = { nivel: 'erro' | 'aviso'; linha?: number; registro?: string; campo?: string; codigo: string; mensagem: string };

type ResultadoValidacao = {
  valido: boolean;
  sistema: string;
  codigo_versao: string;
  total_linhas: number;
  registros: Record<string, number>;
  erros: Problema[];
  avisos: Problema[];
  layout?: { codigo_versao: string; versao_leiaute: string; fonte_url: string; ato_normativo: string | null };
  nota?: string;
};

const ROTULO_SISTEMA: Record<string, string> = {
  EFD_ICMS_IPI: 'EFD ICMS/IPI',
  EFD_CONTRIBUICOES: 'EFD-Contribuições',
};

const mesAtual = () => new Date().toISOString().slice(0, 7);

export default function FiscalLayoutsPage() {
  const toast = useToast();
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  // Resolução da versão vigente.
  const [sistema, setSistema] = useState<'EFD_ICMS_IPI' | 'EFD_CONTRIBUICOES'>('EFD_ICMS_IPI');
  const [periodo, setPeriodo] = useState(mesAtual());
  const [vigente, setVigente] = useState<{ codigo_versao: string; versao_leiaute: string; ato_normativo: string | null; fonte_url: string } | null>(null);
  const [resolvendo, setResolvendo] = useState(false);
  const [erroVigente, setErroVigente] = useState('');

  // Validação estrutural de arquivo.
  const [conteudo, setConteudo] = useState('');
  const [validando, setValidando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoValidacao | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const r = await api.get<{ layouts: Layout[] }>('/fiscal/layouts');
      setLayouts(r.layouts);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar o registro de leiautes.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function resolverVigente() {
    setResolvendo(true);
    setErroVigente('');
    setVigente(null);
    try {
      const r = await api.get<{ layout: Layout }>(`/fiscal/layouts/vigente?sistema=${sistema}&periodo=${periodo}`);
      setVigente(r.layout);
    } catch (e) {
      setErroVigente(e instanceof ApiError ? e.message : 'Não foi possível resolver a versão vigente.');
    } finally {
      setResolvendo(false);
    }
  }

  async function validar() {
    if (!conteudo.trim()) {
      toast.error('Cole o conteúdo do arquivo EFD (linhas |REG|...|).');
      return;
    }
    setValidando(true);
    setResultado(null);
    try {
      const r = await api.post<ResultadoValidacao>('/fiscal/efd/validar', {
        sistema,
        periodo,
        conteudo,
      });
      setResultado(r);
      toast.success(r.valido ? 'Arquivo estruturalmente válido.' : `Encontrados ${r.erros.length} erro(s).`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Falha ao validar o arquivo.');
    } finally {
      setValidando(false);
    }
  }

  const colunas: DataTableColumn<Layout>[] = [
    { key: 'sistema', header: 'Sistema', render: (l) => <span className="font-medium">{ROTULO_SISTEMA[l.sistema] ?? l.sistema}</span> },
    { key: 'codigo_versao', header: 'COD_VER', render: (l) => <span className="font-mono text-xs">{l.codigo_versao}</span> },
    { key: 'versao_leiaute', header: 'Versão', render: (l) => <span className="font-mono text-xs">{l.versao_leiaute}</span> },
    { key: 'ato_normativo', header: 'Ato normativo', render: (l) => <span className="text-sm">{l.ato_normativo || '—'}</span> },
    {
      key: 'vigencia',
      header: 'Vigência',
      render: (l) => (
        <span className="text-sm text-muted">
          {formatDate(l.vigencia_inicio)} → {l.vigencia_fim ? formatDate(l.vigencia_fim) : 'vigente'}
        </span>
      ),
    },
    {
      key: 'fonte_url',
      header: 'Fonte oficial',
      render: (l) => (
        <a href={l.fonte_url} target="_blank" rel="noreferrer" className="text-brand-700 hover:underline">
          {l.fonte_url}
        </a>
      ),
    },
    { key: 'registros', header: 'Registros', render: (l) => <span className="text-xs text-muted">{l.registros.length} registros mapeados</span> },
  ];

  const porSistema = useMemo(() => {
    const c: Record<string, number> = {};
    for (const l of layouts) c[l.sistema] = (c[l.sistema] ?? 0) + 1;
    return c;
  }, [layouts]);

  if (carregando) return <PageLoading label="Carregando leiautes fiscais…" />;
  if (erro) return <PageError message={erro} onRetry={() => void carregar()} title="Leiautes fiscais indisponíveis" />;

  return (
    <PageShell>
      <PageHeader
        title="Leiautes SPED/EFD"
        description="Registro versionado dos leiautes de EFD ICMS/IPI e EFD-Contribuições: código COD_VER, versão, ato normativo, vigência e fonte oficial. Resolve a versão vigente por período e valida a estrutura de um arquivo. O ERP não gera, não assina e não transmite arquivo fiscal."
        actions={
          <button type="button" onClick={() => void carregar()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Atualizar
          </button>
        }
      />

      <Alert tone="blue">
        <span className="flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            A versão vigente de cada período vem das Notas Técnicas / ADEs oficiais (coluna “Fonte oficial”).
            Este módulo <strong>não</strong> declara o ERP homologado pela Receita Federal ou SEFAZ, <strong>não</strong> transmite
            arquivos e <strong>não</strong> emite documentos fiscais. A geração a partir dos documentos do ERP e a transmissão
            dependem de contador e ambiente fiscal apropriado.
          </span>
        </span>
      </Alert>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Leiautes registrados" value={String(layouts.length)} hint="Versões versionadas no banco." />
        <StatCard label="EFD ICMS/IPI" value={String(porSistema.EFD_ICMS_IPI ?? 0)} hint="Versões cadastradas." />
        <StatCard label="EFD-Contribuições" value={String(porSistema.EFD_CONTRIBUICOES ?? 0)} hint="Versões cadastradas." />
        <StatCard label="Homologação" value="Pendente" hint="Depende de contador e ambiente fiscal." />
      </div>

      {layouts.length === 0 ? (
        <EmptyState
          icon={<ShieldAlert className="h-6 w-6" aria-hidden="true" />}
          title="Nenhum leiaute registrado"
          description="O registro é semeado pela migração versionada (0115). Verifique se a migração foi aplicada."
        />
      ) : (
        <DataTable
          caption="Registro versionado de leiautes SPED/EFD"
          columns={colunas}
          rows={layouts}
          getRowKey={(l) => String(l.id)}
          empty="Nenhum leiaute."
        />
      )}

      {/* Resolução da versão vigente por período. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold">Qual leiaute vige no período?</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Sistema</span>
            <select value={sistema} onChange={(e) => setSistema(e.target.value as typeof sistema)} className="rounded-lg border border-slate-300 px-3 py-2">
              <option value="EFD_ICMS_IPI">EFD ICMS/IPI</option>
              <option value="EFD_CONTRIBUICOES">EFD-Contribuições</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium text-slate-600">Período de apuração</span>
            <input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
          </label>
          <button
            type="button"
            disabled={resolvendo}
            onClick={() => void resolverVigente()}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {resolvendo && <Loader2 className="h-4 w-4 animate-spin" />} Resolver versão
          </button>
        </div>

        {erroVigente && <div className="mt-3"><Alert tone="amber">{erroVigente}</Alert></div>}

        {vigente && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
            <div className="flex items-center gap-2">
              <Badge tone="blue">COD_VER {vigente.codigo_versao}</Badge>
              <span className="text-muted">leiaute versão {vigente.versao_leiaute}</span>
            </div>
            <div className="mt-1 text-slate-600">{vigente.ato_normativo || '—'}</div>
            <a href={vigente.fonte_url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-brand-700 hover:underline">
              {vigente.fonte_url}
            </a>
          </div>
        )}
      </section>

      {/* Validação estrutural. */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold">Validar arquivo EFD (estrutura)</h2>
        <p className="mb-3 text-xs text-muted">
          Cole o conteúdo do arquivo (linhas no formato <span className="font-mono">|REG|campo|…|</span>). A validação confere
          gramática, quantidade e formato de campos, blocos, filhos obrigatórios (C170/C190), referências e totais.
          Não substitui a validação do PVA oficial.
        </p>
        <textarea
          value={conteudo}
          onChange={(e) => setConteudo(e.target.value)}
          rows={8}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-300 p-3 font-mono text-xs"
          placeholder={'|0000|020|0|01012025|31012025|...|\n|0001|0|\n|0990|2|\n|9999|4|'}
        />
        <div className="mt-2">
          <button
            type="button"
            disabled={validando}
            onClick={() => void validar()}
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
          >
            {validando ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileCheck2 className="h-4 w-4" />} Validar estrutura
          </button>
        </div>

        {resultado && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={resultado.valido ? 'green' : 'red'}>{resultado.valido ? 'Estruturalmente válido' : `${resultado.erros.length} erro(s)`}</Badge>
              <span className="text-muted">
                {resultado.total_linhas} linha(s) · leiaute {resultado.layout?.codigo_versao ?? resultado.codigo_versao} · {resultado.avisos.length} aviso(s)
              </span>
            </div>
            {resultado.erros.length > 0 && (
              <ul className="space-y-1 text-xs">
                {resultado.erros.map((p, i) => (
                  <li key={`e${i}`} className="rounded border border-red-200 bg-red-50 px-2 py-1 text-red-800">
                    {p.linha ? `linha ${p.linha} · ` : ''}{p.registro ? `${p.registro} · ` : ''}{p.codigo}: {p.mensagem}
                  </li>
                ))}
              </ul>
            )}
            {resultado.avisos.length > 0 && (
              <ul className="space-y-1 text-xs">
                {resultado.avisos.map((p, i) => (
                  <li key={`a${i}`} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
                    {p.linha ? `linha ${p.linha} · ` : ''}{p.registro ? `${p.registro} · ` : ''}{p.codigo}: {p.mensagem}
                  </li>
                ))}
              </ul>
            )}
            {resultado.nota && <p className="text-xs text-muted">{resultado.nota}</p>}
          </div>
        )}
      </section>
    </PageShell>
  );
}
