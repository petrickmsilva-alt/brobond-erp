import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { Alert, PageHeader } from '../components/ui';
import { Card, CardHeader, PageShell, StatCard } from '../components/ui-kit-negocios';
import { api, ApiError, lerArquivoParaImportacao } from '../lib/api';

type Validacoes = {
  registros: number;
  skus_distintos: number;
  familias: number;
  status_invalidos: string[];
  precos_oficiais: number;
  precos_conflitantes_arquivo: string[];
  precificacao_pendente: string[];
  precificacao_calculada: number;
  precificacao_preco_explicito: number;
  skus_pai_colididos: string[];
  codigos_barras_validos: number;
  codigos_barras_concat: number;
  codigos_barras_invalidos: number;
};
type Preview = {
  total: number;
  validacoes: Validacoes;
  reconciliacao: { abas: Array<{ nome: string }> };
  inventario: { local_nome: string; total_skus: number; total_unidades: number; total_celulas: number; skus_sem_saldo: number; por_fonte: Record<string, { skus: number; celulas: number; unidades: number }> };
  limite: number;
  truncado: boolean;
  nao_gravado: string;
};
type JobStatus = { id: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; result?: Resultado; error?: string; attempts: number };
type Resultado = {
  ok: boolean;
  produtos: number;
  variacoes: number;
  ignorados: number;
  precos_gravados: number;
  estoque_importado: boolean;
  estoque_fisico_removido: boolean;
  saldo_inicial: number;
  observacao: string;
};
const CONFIRMACAO = 'CONFIRMAR CARGA BROBOND';
const formatar = (valor: number | undefined) => new Intl.NumberFormat('pt-BR').format(Number(valor || 0));

export default function CargaPoliticaComercialPage() {
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [conteudo, setConteudo] = useState('');
  const [nome, setNome] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [aceite, setAceite] = useState(false);
  const [frase, setFrase] = useState('');
  const [carregando, setCarregando] = useState(false);
  const [executando, setExecutando] = useState(false);
  const [erro, setErro] = useState('');
  const [jobId, setJobId] = useState<string>(() => localStorage.getItem('brobond_carga_politica_job') || '');
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);

  const bloqueios = Boolean(preview && (
    preview.truncado ||
    preview.validacoes.status_invalidos.length > 0 ||
    preview.validacoes.precos_conflitantes_arquivo.length > 0
  ));
  const podeConfirmar = Boolean(preview && !bloqueios && aceite && frase.trim() === CONFIRMACAO && !executando && !carregando);

  async function escolherArquivo(file?: File) {
    setErro('');
    setArquivo(file || null);
    setConteudo('');
    setNome('');
    setPreview(null);
    setResultado(null);
    setAceite(false);
    setFrase('');
    if (!file) return;
    if (!/\.xlsx?$/i.test(file.name)) {
      setArquivo(null);
      setErro('Selecione a planilha Excel oficial (.xlsx ou .xls).');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setArquivo(null);
      setErro('O arquivo excede o limite de 20 MB.');
      return;
    }
    try {
      const lido = await lerArquivoParaImportacao(file);
      setConteudo(lido.conteudo);
      setNome(lido.nome);
    } catch (e) {
      setArquivo(null);
      setErro(e instanceof Error ? e.message : 'Não foi possível ler a planilha.');
    }
  }

  async function gerarPreview() {
    if (!conteudo || !nome) {
      setErro('Selecione a planilha e aguarde a leitura do arquivo.');
      return;
    }
    setCarregando(true);
    setErro('');
    setPreview(null);
    setResultado(null);
    setAceite(false);
    setFrase('');
    try {
      const dados = await api.post<Preview>('/carga/politica-comercial/preview', { conteudo, nome });
      setPreview(dados);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Falha ao validar a planilha.');
    } finally {
      setCarregando(false);
    }
  }

  useEffect(() => {
    if (!jobId) return;
    let ativo = true;
    const consultar = async () => {
      try {
        const status = await api.get<JobStatus>(`/carga/politica-comercial/jobs/${jobId}`);
        if (!ativo) return;
        setJobStatus(status);
        if (status.status === 'succeeded' && status.result) {
          setResultado(status.result);
          setPreview(null);
          localStorage.removeItem('brobond_carga_politica_job');
          setJobId('');
        } else if (status.status === 'failed') {
          setErro(status.error || 'A carga falhou e a transação foi revertida.');
          localStorage.removeItem('brobond_carga_politica_job');
          setJobId('');
        }
      } catch (e) {
        if (ativo && e instanceof ApiError && e.status === 404) {
          setErro('O processamento salvo não foi encontrado para esta sessão. Gere uma nova prévia antes de tentar novamente.');
          localStorage.removeItem('brobond_carga_politica_job');
          setJobId('');
        }
      }
    };
    void consultar();
    const timer = window.setInterval(() => void consultar(), 2500);
    return () => { ativo = false; window.clearInterval(timer); };
  }, [jobId]);

  async function confirmar() {
    if (!podeConfirmar || !conteudo || !nome || jobId) return;
    setExecutando(true);
    setErro('');
    try {
      const job = await api.post<{ job_id: string; status: JobStatus['status'] }>('/carga/politica-comercial/jobs', { conteudo, nome });
      localStorage.setItem('brobond_carga_politica_job', job.job_id);
      setJobStatus({ id: job.job_id, status: job.status, attempts: 0 });
      setJobId(job.job_id);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível iniciar o processamento. Uma repetição idêntica não duplica a carga.');
    } finally {
      setExecutando(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="Carga da Política Comercial"
        description="Importação controlada da planilha oficial, com prévia sem gravação e confirmação transacional."
      />
      {erro && <Alert tone="red">{erro}</Alert>}

      {resultado ? (
        <Card>
          <CardHeader title="Carga concluída" subtitle="O servidor confirmou a transação e retornou os totais gravados." icon={CheckCircle2} />
          <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
            <StatCard label="Produtos-pai" value={formatar(resultado.produtos)} />
            <StatCard label="Variações" value={formatar(resultado.variacoes)} />
            <StatCard label="Preços gravados" value={formatar(resultado.precos_gravados)} />
            <StatCard label="Saldo inicial" value={formatar(resultado.saldo_inicial)} />
          </div>
          <div className="space-y-2 px-4 pb-4 text-sm">
            <p>Estoque físico anterior removido: <strong>{resultado.estoque_fisico_removido ? 'Sim' : 'Não'}</strong></p>
            <p>Quantidade da planilha importada: <strong>{resultado.estoque_importado ? 'Sim' : 'Não'}</strong></p>
            <p className="text-slate-600">{resultado.observacao}</p>
          </div>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader title="1. Selecionar planilha oficial" subtitle="A prévia não grava produtos, preços nem estoque." icon={FileSpreadsheet} />
            <div className="space-y-3 p-4">
              <input
                type="file"
                accept=".xlsx,.xls"
                className="block w-full rounded-lg border border-slate-300 bg-white p-3 text-sm"
                onChange={(e) => void escolherArquivo(e.target.files?.[0])}
                disabled={carregando || executando || Boolean(jobId)}
              />
              {arquivo && <p className="text-sm text-slate-600">Arquivo: <strong>{arquivo.name}</strong> · {(arquivo.size / 1024 / 1024).toFixed(2)} MB</p>}
              <button type="button" className="btn-primary inline-flex items-center gap-2" onClick={() => void gerarPreview()} disabled={!conteudo || carregando || executando || Boolean(jobId)}>
                {carregando ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                {carregando ? 'Validando...' : 'Gerar prévia e validar'}
              </button>
            </div>
          </Card>

          {jobId && (
            <Card>
              <CardHeader title="4. Processamento em segundo plano" subtitle="O servidor mantém o trabalho registrado e atualiza o estado automaticamente." icon={RefreshCw} />
              <div className="p-4 text-sm">
                <p><strong>Identificador:</strong> <span className="font-mono">{jobId}</span></p>
                <p><strong>Estado:</strong> {jobStatus?.status === 'running' ? 'Executando a transação' : 'Na fila para execução'}</p>
                <p className="text-slate-600">Não feche esta página para acompanhar o resultado. Se a conexão cair, o estado será recuperado ao reabrir a tela.</p>
              </div>
            </Card>
          )}
          {preview && !jobId && (
            <>
              <Card>
                <CardHeader title="2. Resultado da prévia" subtitle="Indicadores calculados pelo importador no servidor. Nada foi gravado." icon={ShieldCheck} />
                <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4">
                  <StatCard label="SKUs distintos" value={formatar(preview.validacoes.skus_distintos)} />
                  <StatCard label="Famílias" value={formatar(preview.validacoes.familias)} />
                  <StatCard label="Preços oficiais" value={formatar(preview.validacoes.precos_oficiais)} />
                  <StatCard label="Preços explícitos / custo pendente" value={formatar(preview.validacoes.precificacao_preco_explicito)} />
                  <StatCard label="Precificações calculadas" value={formatar(preview.validacoes.precificacao_calculada)} />
                  <StatCard label="Pendências de precificação" value={formatar(preview.validacoes.precificacao_pendente.length)} />
                  <StatCard label="Abas examinadas" value={formatar(preview.reconciliacao.abas.length)} />
                  <StatCard label="Linhas examinadas" value={formatar(preview.validacoes.registros)} />
                </div>
                <div className="space-y-2 border-t border-slate-100 p-4 text-sm">
                  <p><strong>Estoque a importar em {preview.inventario.local_nome}:</strong> {formatar(preview.inventario.total_celulas)} células físicas (SKUs com saldo positivo), {formatar(preview.inventario.total_skus)} SKUs no catálogo e {formatar(preview.inventario.total_unidades)} unidades. {formatar(preview.inventario.skus_sem_saldo)} SKUs ficarão sem célula física por terem saldo zero. Na confirmação, o saldo anterior será substituído por estas quantidades reconciliadas.</p>
                  <p className="text-slate-600"><strong>Conferência por fonte:</strong> {Object.entries(preview.inventario.por_fonte || {}).map(([fonte, totais]) => fonte + ': ' + formatar(totais.skus) + ' SKUs / ' + formatar(totais.celulas) + ' células / ' + formatar(totais.unidades) + ' unidades').join(' · ') || 'Sem discriminação disponível.'}</p>
                  <p><strong>Status inválidos:</strong> {formatar(preview.validacoes.status_invalidos.length)} · <strong>Conflitos de preço:</strong> {formatar(preview.validacoes.precos_conflitantes_arquivo.length)} · <strong>Colisões de SKU-pai resolvidas automaticamente:</strong> {formatar(preview.validacoes.skus_pai_colididos.length)}</p>
                  <p><strong>Códigos de barras:</strong> {formatar(preview.validacoes.codigos_barras_validos)} válidos; {formatar(preview.validacoes.codigos_barras_concat)} concatenações e {formatar(preview.validacoes.codigos_barras_invalidos)} inválidos não serão tratados como GTIN.</p>
                  <p className="text-slate-600">{preview.nao_gravado}</p>
                  {bloqueios && <Alert tone="red">A confirmação está bloqueada: a prévia contém linhas truncadas, status inválidos ou conflitos de preço. Corrija a origem antes de prosseguir.</Alert>}
                </div>
              </Card>

              <Card>
                <CardHeader title="3. Confirmar importação" subtitle="A confirmação executa a rotina transacional existente do ERP." icon={AlertTriangle} />
                <div className="space-y-3 p-4">
                  <Alert tone="red">
                    A operação substitui os dados do catálogo/preços da empresa BROBOND, inativa produtos antigos fora da planilha, remove as células de estoque físico anteriores e importa o inventário reconciliado exibido na prévia para o local único LOJA. Empresa, usuários, acessos e histórico de movimentações são preservados; o saldo inicial não gera movimentos artificiais. Custos com #REF! permanecem nulos, sem custo ou margem inventados.
                  </Alert>
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={aceite} onChange={(e) => setAceite(e.target.checked)} />
                    <span>Li a prévia e autorizo a substituição do catálogo/preços e a remoção das células de estoque físico anteriores, conforme descrito.</span>
                  </label>
                  <label className="block text-sm font-medium">
                    Digite exatamente <span className="font-mono">{CONFIRMACAO}</span> para liberar a confirmação.
                    <input className="input mt-2 w-full" value={frase} onChange={(e) => setFrase(e.target.value)} placeholder={CONFIRMACAO} autoComplete="off" />
                  </label>
                  <button type="button" className="btn-danger inline-flex items-center gap-2" onClick={() => void confirmar()} disabled={!podeConfirmar || Boolean(jobId)}>
                    {executando ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                    {executando ? 'Executando transação...' : 'Confirmar carga oficial'}
                  </button>
                  {!podeConfirmar && !bloqueios && <p className="text-xs text-slate-500">A confirmação exige prévia válida, aceite explícito e frase correta.</p>}
                </div>
              </Card>
            </>
          )}
        </>
      )}
    </PageShell>
  );
}
