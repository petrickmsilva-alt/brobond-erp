// ============================================================================
// IMPORTAÇÃO DE PLANILHAS — PÁGINA PRÓPRIA (`/importar/:tipo`)
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: importar produtos, clientes,
// fornecedores, insumos ou saldos iniciais de estoque é um fluxo de módulo, e
// por isso vive em página — não em painel sobreposto à listagem.
//
// Duas garantias de dados:
//   1. NADA é gravado antes do "Confirmar": a pré-visualização roda a MESMA
//      validação do servidor (inclusive unicidade de saldo de estoque) e só as
//      linhas válidas seguem para o confirmar.
//   2. Arquivo acima do LIMITE de linhas do servidor é RECUSADO (`truncado`),
//      em vez de importar silenciosamente um prefixo do arquivo.
// ============================================================================
import { useMemo, useState } from 'react';
import { Download, FileUp, Loader2, UploadCloud, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile, lerArquivoParaImportacao, ApiError } from '../lib/api';
import { Alert, PageHeader, useToast } from '../components/ui';
import { IMPORT_TIPOS } from '../lib/importacao';

type PreviewResp = {
  tipo: string;
  total: number;
  validas: number;
  erros: { linha: number; mensagem: string }[];
  amostra: Record<string, any>[];
  colunas: string[];
  limite?: number;
  truncado?: boolean;
};

const ROTULO_AMIGAVEL: Record<string, string> = {
  sku: 'SKU',
  nome: 'Nome',
  categoria: 'Categoria',
  colecao: 'Coleção',
  cor: 'Cor',
  codigo_barras: 'Código de barras',
  composicao: 'Composição',
  descricao: 'Descrição',
  ncm: 'NCM',
  peso_g: 'Peso (g)',
  custo: 'Custo',
  preco_venda: 'Preço de venda',
  ativo: 'Ativo',
  cnpj_cpf: 'CNPJ/CPF',
  cnpj: 'CNPJ',
  tipo: 'Tipo',
  telefone: 'Telefone',
  email: 'E-mail',
  contato: 'Contato',
  unidade: 'Unidade',
  fornecedor: 'Fornecedor',
  custo_medio: 'Custo médio',
  produto: 'Produto (SKU)',
  tamanho: 'Tamanho',
  local: 'Local',
  quantidade: 'Quantidade',
  estoque_min: 'Estoque mínimo',
};

function normalizar(chave: string): string {
  return chave
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export default function ImportarPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { tipo } = useParams();
  const tipoConfig = IMPORT_TIPOS.find((t) => t.tipo === tipo);

  const [arquivo, setArquivo] = useState<File | null>(null);
  const [texto, setTexto] = useState('');
  const [aba, setAba] = useState<'arquivo' | 'colar'>('arquivo');
  const [lendo, setLendo] = useState(false);
  const [preview, setPreview] = useState<PreviewResp | null>(null);
  const [error, setError] = useState('');
  const [confirmando, setConfirmando] = useState(false);
  const [resultado, setResultado] = useState<{ importados: number; pulados: number } | null>(null);
  const [linhaArquivo, setLinhaArquivo] = useState(0);

  const voltar = () => navigate(-1);

  // Hooks SEMPRE no topo: o `return` antecipado de tipo inválido não pode
  // mudar a ordem das chamadas entre renders (rules-of-hooks).
  const colunasVisiveis = useMemo(() => {
    if (!preview) return [];
    const chaves = preview.colunas.map(normalizar);
    return [...new Set([...chaves, ...Object.keys(preview.amostra[0] || {})])].slice(0, 12);
  }, [preview]);

  if (!tipoConfig) {
    return (
      <div className="space-y-4">
        <PageHeader title="Importar planilha" description="Tipo de importação não reconhecido." />
        <Alert tone="red">
          Não existe importação para “{String(tipo)}”. Os tipos aceitos são: {IMPORT_TIPOS.map((t) => t.label).join(', ')}.
        </Alert>
        <button className="btn-secondary" onClick={() => navigate('/')}>
          Voltar ao início
        </button>
      </div>
    );
  }

  const bloqueadoPorLimite = !!preview?.truncado;

  async function analisar(conteudo: string, nome?: string) {
    setLendo(true);
    setError('');
    setResultado(null);
    try {
      const resp = await api.post<PreviewResp>('/importar/preview', { tipo: tipoConfig!.tipo, conteudo, nome });
      setPreview(resp);
      if (!resp.validas) toast.info('Nenhuma linha válida. Confira os erros abaixo e ajuste a planilha.');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível ler o arquivo.');
    } finally {
      setLendo(false);
    }
  }

  async function confirmar() {
    if (!preview?.amostra?.length || bloqueadoPorLimite) return;
    setConfirmando(true);
    setError('');
    try {
      const resp = await api.post<{ ok: boolean; importados: number; pulados: number }>('/importar/confirmar', {
        tipo: tipoConfig!.tipo,
        linhas: preview.amostra,
      });
      setResultado({ importados: resp.importados, pulados: resp.pulados || 0 });
      toast.success(`${resp.importados} ${tipoConfig!.label.toLowerCase()} importado(s).`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível concluir a importação.');
    } finally {
      setConfirmando(false);
    }
  }

  const aceita = '.csv,text/csv,.xlsx,.xls';

  return (
    <div className="p-4 pb-24 sm:p-6 md:pb-6">
      <PageHeader
        title={`Importar ${tipoConfig.label.toLowerCase()}`}
        description="Aceita CSV (Excel pt-BR, separado por ; ou vírgula) e XLSX. A primeira linha é o cabeçalho. Nada é gravado antes de você confirmar."
        actions={
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-secondary" onClick={voltar} disabled={confirmando}>
              Fechar
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void downloadFile(`/importar/modelo?tipo=${tipoConfig.tipo}`, `modelo-${tipoConfig.tipo}.csv`).catch((e) => toast.error(e.message))}
            >
              <Download className="h-4 w-4" /> Baixar modelo
            </button>
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => void confirmar()}
              disabled={confirmando || !preview?.amostra?.length || !!resultado || bloqueadoPorLimite}
            >
              {confirmando ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
              Confirmar importação ({preview?.amostra.length ?? 0})
            </button>
          </div>
        }
      />

      {error && <Alert tone="red">{error}</Alert>}

      <div className="card mx-auto max-w-4xl space-y-4 p-5">
        {!preview && (
          <>
            <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm dark:bg-navy-800">
              {(['arquivo', 'colar'] as const).map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setAba(a)}
                  className={`flex-1 rounded-md px-3 py-1.5 font-medium ${aba === a ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500'}`}
                >
                  {a === 'arquivo' ? 'Enviar arquivo' : 'Colar texto (CSV)'}
                </button>
              ))}
            </div>
            {aba === 'arquivo' ? (
              <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center transition-colors hover:border-brand-400 hover:bg-brand-50/40">
                <FileUp className="h-8 w-8 text-slate-400" />
                <span className="text-sm font-medium text-slate-700 dark:text-slate-200">Clique para escolher um arquivo {aceita}</span>
                <span className="text-xs text-slate-400">O arquivo fica apenas no seu navegador até você confirmar a pré-visualização.</span>
                <input
                  type="file"
                  aria-label={`Arquivo de importação de ${tipoConfig.label.toLowerCase()}`}
                  accept={aceita}
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setArquivo(f);
                    setLinhaArquivo(0);
                    const { conteudo, nome } = await lerArquivoParaImportacao(f);
                    await analisar(conteudo, nome);
                  }}
                />
              </label>
            ) : (
              <div>
                <textarea
                  className="input h-40 w-full font-mono text-xs"
                  placeholder={'sku;nome;categoria;preco_venda\nCAM-100;Camisa Polo;Camisa;69,90'}
                  value={texto}
                  onChange={(e) => setTexto(e.target.value)}
                />
                <button className="btn-secondary mt-2" disabled={!texto.trim() || lendo} onClick={() => void analisar(texto.trim())}>
                  {lendo && <Loader2 className="h-4 w-4 animate-spin" />} Analisar texto
                </button>
              </div>
            )}
            {arquivo && !preview && <p className="text-xs text-slate-400">Arquivo: {arquivo.name}</p>}
            {lendo && (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Lendo planilha...
              </div>
            )}
          </>
        )}

        {preview && (
          <>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="badge bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">{preview.validas} linha(s) válida(s)</span>
              {preview.erros.length > 0 && <span className="badge bg-red-50 text-red-700 ring-1 ring-red-200">{preview.erros.length} com erro</span>}
              <span className="text-slate-400">de {preview.total} linha(s)</span>
            </div>

            {bloqueadoPorLimite && (
              <Alert tone="red">
                <strong>Arquivo grande demais para uma importação segura.</strong> A pré-visualização só consegue importar{' '}
                {preview.limite ?? 5000} linhas por vez e este arquivo tem {preview.validas} linha(s) válida(s). Nada foi
                gravado. Divida a planilha em partes de até {preview.limite ?? 5000} linhas e importe uma por vez — assim
                nenhum registro é perdido em silêncio.
              </Alert>
            )}

            {resultado && (
              <Alert tone="green">
                <strong>Importação concluída:</strong> {resultado.importados} {tipoConfig.singular}(s) incluído(s)
                {resultado.pulados > 0 ? ` · ${resultado.pulados} linha(s) ignorada(s) por duplicidade ou invalidade.` : '.'}
              </Alert>
            )}

            {preview.erros.length > 0 && (
              <div className="max-h-36 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3 text-xs">
                <p className="mb-1 font-semibold text-red-700">Erros encontrados (as linhas abaixo serão ignoradas):</p>
                <ul className="space-y-0.5 text-red-800">
                  {preview.erros.map((e, i) => (
                    <li key={i}>
                      Linha {e.linha}: {e.mensagem}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.amostra.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="table text-xs">
                  <thead>
                    <tr>
                      {colunasVisiveis.map((c) => (
                        <th key={c}>{ROTULO_AMIGAVEL[c] || c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.amostra.slice(linhaArquivo, linhaArquivo + 50).map((r, i) => (
                      <tr key={i}>
                        {colunasVisiveis.map((c) => (
                          <td key={c}>{r[c] === true || r[c] === 'true' ? 'sim' : r[c] === false || r[c] === 'false' ? 'não' : (r[c] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.amostra.length > 50 && (
              <button className="btn-ghost text-xs" onClick={() => setLinhaArquivo((l) => l + 50)}>
                Mostrar mais 50 linhas
              </button>
            )}

            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setPreview(null);
                setArquivo(null);
                setResultado(null);
              }}
            >
              <X className="h-3.5 w-3.5" /> Trocar de arquivo
            </button>
          </>
        )}
      </div>
    </div>
  );
}
