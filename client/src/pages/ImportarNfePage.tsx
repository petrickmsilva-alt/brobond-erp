import { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, FileUp, FileWarning, Loader2, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { ApiError, getToken } from '../lib/api';
import { Alert, Badge, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { formatDate, formatMoney, formatNumber } from '../lib/format';

/**
 * Importação de NF-e de ENTRADA — E3.2 (`GAP-COMP-XML-MENU`).
 *
 * O backend (`importarXmlCompra`, server/src/suprimentos.ts) já existia e era
 * completo: parser de NF-e, hash, idempotência por chave de acesso, resolução de
 * fornecedor, de-para de SKU e criação da compra já recebida. O que faltava era
 * UMA coisa: uma entrada navegável. Nenhum XML fictício é gerado aqui — a tela
 * só trabalha com o arquivo que o usuário escolher.
 *
 * O fluxo é em duas etapas de propósito:
 *   1. VALIDAR  → `aplicar=false`: roda o MESMO parser e o MESMO de-para dentro
 *                 de uma transação desfeita e devolve o que aconteceria.
 *   2. IMPORTAR → `aplicar=true`: grava.
 * Sem a etapa 1 o usuário descobriria um de-para faltando só depois de a compra
 * já existir — e não há como "desimportar" sem cancelar a compra.
 *
 * O corpo vai como multipart/form-data porque a rota usa `express.raw`: um JSON
 * chegaria como Buffer e o `xml` nunca seria lido.
 */

type ItemPrevisto = {
  numero: number;
  codigo_fornecedor: string;
  descricao_fornecedor: string | null;
  produto_id: number;
  sku: string | null;
  produto: string | null;
  tamanho_id: number | null;
  tamanho: string | null;
  unidade: string | null;
  quantidade: number;
  valor_unitario: number;
  subtotal: number;
};

type Pendencia = { numero: number; codigo_fornecedor: string; descricao: string; motivo: string };

type Previsao = {
  aplicado: false;
  fornecedor: { id: number; nome: string; cnpj: string | null };
  local: string | null;
  nota: { chave_acesso: string; numero?: string | null; serie?: string | null; emissao?: string | null; total?: number | null; frete: number; desconto: number };
  total: number;
  itens: ItemPrevisto[];
  pendencias: Pendencia[];
  pode_importar: boolean;
};

type Importado = {
  aplicado?: undefined;
  ok: true;
  compra_id: number;
  importacao_id: number;
  fornecedor: { id: number; nome: string; cnpj: string | null };
  local: string | null;
  nota: { chave_acesso: string; numero?: string | null; serie?: string | null; emissao?: string | null; total?: number | null };
  itens: ItemPrevisto[];
};

const ENDPOINT = '/api/suprimentos/compras/importar-xml';

async function enviar(arquivo: File, aplicar: boolean, local?: string): Promise<Previsao | Importado> {
  const token = getToken();
  const fd = new FormData();
  fd.append('file', arquivo, arquivo.name);
  fd.append('aplicar', aplicar ? 'true' : 'false');
  if (local) fd.append('local', local);
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: fd,
  });
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, dados?.error || 'Não foi possível processar o XML.', dados?.fields);
  return dados as Previsao | Importado;
}

export default function ImportarNfePage() {
  const toast = useToast();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [local, setLocal] = useState('');
  const [ocupado, setOcupado] = useState<'validar' | 'importar' | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [previsao, setPrevisao] = useState<Previsao | null>(null);
  const [importado, setImportado] = useState<Importado | null>(null);

  const reset = useCallback(() => {
    setArquivo(null);
    setPrevisao(null);
    setImportado(null);
    setErro(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const validar = useCallback(async () => {
    if (!arquivo) return;
    setOcupado('validar');
    setErro(null);
    setPrevisao(null);
    try {
      const r = await enviar(arquivo, false, local.trim() || undefined);
      setPrevisao(r as Previsao);
      if (!(r as Previsao).pode_importar) {
        toast.error('O XML tem pendências de de-para. Resolva antes de importar.');
      }
    } catch (e: any) {
      setErro(e?.message || 'Não foi possível validar o XML.');
    } finally {
      setOcupado(null);
    }
  }, [arquivo, local, toast]);

  const importar = useCallback(async () => {
    if (!arquivo) return;
    setOcupado('importar');
    setErro(null);
    try {
      const r = (await enviar(arquivo, true, local.trim() || undefined)) as Importado;
      setImportado(r);
      setPrevisao(null);
      toast.success(`Compra #${r.compra_id} criada a partir da NF-e.`);
    } catch (e: any) {
      setErro(e?.message || 'Não foi possível importar o XML.');
    } finally {
      setOcupado(null);
    }
  }, [arquivo, local, toast]);

  return (
    <>
      <PageHeader
        title="Importar NF-e de entrada"
        description="Leia o XML da nota do fornecedor, confira o de-para dos SKUs e crie a compra já recebida. O estoque e o custo são aplicados pela mesma regra do recebimento manual."
        actions={
          (previsao || importado) && (
            <button className="btn-secondary" onClick={reset} disabled={!!ocupado}>
              <RefreshCw className="h-4 w-4" /> Importar outra nota
            </button>
          )
        }
      />

      {importado ? (
        <div className="space-y-4">
          <Alert tone="green">
            <div className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">
                  NF-e {importado.nota.numero || importado.nota.chave_acesso} importada — compra #{importado.compra_id} criada e recebida.
                </p>
                <p className="text-sm">
                  {importado.itens.length} item(ns) entraram em estoque no local “{importado.local || 'não informado'}”.
                </p>
              </div>
            </div>
          </Alert>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => navigate(`/compras/${importado.compra_id}`)}>
              Abrir compra #{importado.compra_id}
            </button>
            <button className="btn-secondary" onClick={reset}>
              Importar outra nota
            </button>
          </div>
          <TabelaItens itens={importado.itens} />
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-5">
            <label className="label" htmlFor="xml">Arquivo XML da NF-e</label>
            <input
              id="xml"
              ref={inputRef}
              type="file"
              accept=".xml,application/xml,text/xml"
              className="input"
              disabled={!!ocupado}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setArquivo(f);
                setPrevisao(null);
                setErro(null);
              }}
            />
            <p className="mt-1 text-xs text-slate-500">
              Somente o XML emitido pela SEFAZ. Nenhum arquivo é enviado antes de você validar.
            </p>

            <div className="mt-4">
              <label className="label" htmlFor="local">Local de entrada (opcional)</label>
              <input
                id="local"
                className="input"
                placeholder="Deixe vazio para usar o local padrão"
                value={local}
                disabled={!!ocupado}
                onChange={(e) => setLocal(e.target.value)}
              />
            </div>

            {erro && (
              <div className="mt-4">
                <Alert tone="red">{erro}</Alert>
              </div>
            )}

            <div className="mt-4 flex flex-wrap gap-2">
              <button className="btn-secondary" onClick={() => void validar()} disabled={!arquivo || !!ocupado}>
                {ocupado === 'validar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Validar XML
              </button>
              {previsao?.pode_importar && (
                <button className="btn-primary" onClick={() => void importar()} disabled={!!ocupado}>
                  {ocupado === 'importar' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileUp className="h-4 w-4" />}
                  Confirmar importação
                </button>
              )}
            </div>
          </div>

          {ocupado === 'validar' && <Spinner label="Lendo o XML e resolvendo o de-para..." />}

          {!ocupado && !previsao && !erro && (
            <EmptyState
              icon={<FileWarning className="h-8 w-8" />}
              title="Nenhum XML validado ainda"
              description="Selecione o arquivo da nota e clique em “Validar XML”. Nada é gravado na validação."
            />
          )}

          {previsao && (
            <div className="space-y-4">
              {previsao.pendencias.length > 0 ? (
                <Alert tone="red">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <p className="font-medium">
                        {previsao.pendencias.length} item(ns) sem de-para — a importação está bloqueada até resolver.
                      </p>
                      <p className="text-sm">
                        Cadastre o de-para em <strong>Compras → De-Para de produtos</strong> e valide de novo.
                      </p>
                    </div>
                  </div>
                </Alert>
              ) : (
                <Alert tone="green">
                  <div className="flex items-start gap-2">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <p className="font-medium">XML válido: todos os itens têm de-para. Confira abaixo antes de importar.</p>
                  </div>
                </Alert>
              )}

              <div className="card p-4">
                <h3 className="mb-2 text-sm font-semibold">Cabeçalho da nota</h3>
                <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <Campo k="Fornecedor" v={previsao.fornecedor.nome} />
                  <Campo k="CNPJ" v={previsao.fornecedor.cnpj || 'Não informado'} />
                  <Campo k="Número / série" v={`${previsao.nota.numero ?? '—'} / ${previsao.nota.serie ?? '—'}`} />
                  <Campo k="Emissão" v={previsao.nota.emissao ? formatDate(previsao.nota.emissao) : 'Não informado'} />
                  <Campo k="Chave de acesso" v={previsao.nota.chave_acesso} mono />
                  <Campo k="Total da nota" v={previsao.nota.total === null || previsao.nota.total === undefined ? 'Não informado' : formatMoney(previsao.nota.total)} />
                  <Campo k="Frete" v={formatMoney(previsao.nota.frete)} />
                  <Campo k="Local de entrada" v={previsao.local || 'Não informado'} />
                </div>
              </div>

              <TabelaItens itens={previsao.itens} />

              {previsao.pendencias.length > 0 && (
                <div className="card p-4">
                  <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-red-700">
                    <TriangleAlert className="h-4 w-4" /> Divergências ({previsao.pendencias.length})
                  </h3>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Item</th>
                        <th>Código do fornecedor</th>
                        <th>Descrição na nota</th>
                        <th>Motivo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {previsao.pendencias.map((p, i) => (
                        <tr key={`${p.numero}-${i}`}>
                          <td className="tabular-nums">{p.numero}</td>
                          <td className="font-mono text-xs">{p.codigo_fornecedor || '(vazio)'}</td>
                          <td>{p.descricao || '—'}</td>
                          <td className="text-red-700">{p.motivo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function Campo({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-xs text-slate-500">{k}</div>
      <div className={`break-words ${mono ? 'font-mono text-xs' : 'font-medium'}`}>{v}</div>
    </div>
  );
}

function TabelaItens({ itens }: { itens: ItemPrevisto[] }) {
  if (!itens.length) {
    return (
      <div className="card p-4">
        <p className="text-sm text-slate-500">Nenhum item resolvido.</p>
      </div>
    );
  }
  return (
    <div className="card overflow-x-auto p-4">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        Itens ({itens.length}) <Badge tone="slate">de-para aplicado</Badge>
      </h3>
      <table className="table">
        <thead>
          <tr>
            <th>#</th>
            <th>Código fornecedor</th>
            <th>Descrição na nota</th>
            <th>Produto no ERP</th>
            <th>Variação</th>
            <th className="text-right">Qtd</th>
            <th className="text-right">Unitário</th>
            <th className="text-right">Subtotal</th>
          </tr>
        </thead>
        <tbody>
          {itens.map((i) => (
            <tr key={`${i.numero}-${i.codigo_fornecedor}`}>
              <td className="tabular-nums">{i.numero}</td>
              <td className="font-mono text-xs">{i.codigo_fornecedor}</td>
              <td className="max-w-xs truncate" title={i.descricao_fornecedor || undefined}>{i.descricao_fornecedor || '—'}</td>
              <td>
                <div className="font-medium">{i.produto || `#${i.produto_id}`}</div>
                <div className="text-xs text-slate-500">{i.sku ? `SKU ${i.sku}` : 'SKU não informado'}</div>
              </td>
              <td>{i.tamanho || '—'}</td>
              <td className="text-right tabular-nums">{formatNumber(i.quantidade)}</td>
              <td className="text-right tabular-nums">{formatMoney(i.valor_unitario)}</td>
              <td className="text-right tabular-nums">{formatMoney(i.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
