// ============================================================================
// NCM / TRIBUTAÇÃO — ERP-05 (P1-02: funcionalidade existia só na API)
//
// O motor "Meu Negócios" calcula o imposto de cada venda pela chave de NCM
// (`impostos_ncm`): casa sempre a chave MAIS LONGA com o NCM do produto (8, 6,
// 4 ou 2 dígitos) e, quando nenhuma casa, usa a linha PADRÃO — a que tem a
// chave vazia. Sem nenhuma das duas, o imposto é 0% (o servidor não inventa
// alíquota). Esta tela é o CRUD dessa tabela, e nada mais: quem calcula o
// imposto continua sendo o servidor.
//
//   • `GET/POST/PUT/DELETE /api/impostos_ncm` — recurso real (minPerfil gerente)
//   • a linha padrão (chave vazia) aparece como "PADRÃO", nunca como registro
//     vazio sem explicação;
//   • os números exibidos vêm do servidor: a tela não calcula imposto.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Calculator, Info, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ListResult } from '../lib/meta';
import { Alert, Badge, ConfirmacaoInline, EmptyState, PageHeader, Spinner, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

type ImpostoNcm = {
  id: number;
  ncm: string | null;
  descricao: string | null;
  aliquota_pct: number | null;
  atualizado_em?: string | null;
  criado_em?: string | null;
};

function ehPadrao(i: ImpostoNcm): boolean {
  return i.ncm === null || i.ncm === undefined || String(i.ncm) === '';
}

/** '6109' → '6109' · '61091000' → '61091000' (a chave é só dígitos: sem máscara). */
function chaveDe(i: ImpostoNcm): string {
  return ehPadrao(i) ? 'PADRÃO' : String(i.ncm);
}

function pct(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

export default function NcmPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuth();
  const podeEscrever = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [carregando, setCarregando] = useState(true);
  const [linhas, setLinhas] = useState<ImpostoNcm[]>([]);
  const [erro, setErro] = useState('');
  const [busca, setBusca] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [excluindo, setExcluindo] = useState<ImpostoNcm | null>(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<ListResult<ImpostoNcm>>('/impostos_ncm?page=1&pageSize=200&sort=ncm&dir=asc');
      setLinhas(d.rows);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as alíquotas por NCM.');
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
    return linhas.filter((i) => `${i.ncm ?? ''} ${i.descricao ?? ''}`.toLowerCase().includes(q));
  }, [linhas, busca]);

  // ZERO MODAL: a criação e a edição de alíquota são PÁGINAS próprias
  // (`/ncm/novo` e `/ncm/:id/editar`). A listagem nunca abre formulário
  // sobreposto — ela navega.
  const abrirNova = () => navigate('/ncm/novo');
  const abrirEdicao = (i: ImpostoNcm) => navigate(`/ncm/${i.id}/editar`);

  const excluir = async () => {
    if (!excluindo) return;
    setOcupado(true);
    try {
      await api.del(`/impostos_ncm/${excluindo.id}`);
      toast.success('Alíquota excluída.');
      setExcluindo(null);
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível excluir.');
    } finally {
      setOcupado(false);
    }
  };

  const total = linhas.length;
  const padrao = linhas.find(ehPadrao) ?? null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="NCM / Tributação"
        description="Alíquotas por NCM usadas pelo motor de impostos de cada venda. O motor aplica sempre a chave mais longa que casa com o NCM do produto; a chave vazia é a alíquota PADRÃO. Sem nenhuma chave casando, o imposto é 0%."
        actions={
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={() => void carregar()} disabled={carregando}>
              <RefreshCw className="h-4 w-4" /> Atualizar
            </button>
            {podeEscrever && (
              <button className="btn-accent" onClick={abrirNova}>
                <Plus className="h-4 w-4" /> Nova alíquota
              </button>
            )}
          </div>
        }
      />

      <Alert tone="blue">
        <span className="inline-flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            O que está aqui é usado no cálculo do imposto de cada item vendido — não há alíquota escrita no código.
            {padrao
              ? ` Hoje a alíquota padrão (NCMs sem chave cadastrada) é ${pct(padrao.aliquota_pct)}.`
              : ' Hoje NÃO existe linha padrão: NCM sem chave cadastrada fica com imposto 0%.'}
          </span>
        </span>
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input
            className="input pl-9"
            placeholder="Buscar NCM ou descrição..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
          />
        </div>
        <Badge tone="slate">{total} chave(s)</Badge>
        {padrao && <Badge tone="blue">Padrão: {pct(padrao.aliquota_pct)}</Badge>}
      </div>

      {erro && <Alert tone="red">{erro}</Alert>}

      <div className="card overflow-hidden">
        {carregando ? (
          <Spinner label="Carregando alíquotas..." />
        ) : visiveis.length === 0 ? (
          <EmptyState
            icon={<Calculator className="h-6 w-6" />}
            title={busca ? 'Nada encontrado' : 'Nenhuma alíquota cadastrada'}
            description={
              busca
                ? 'Nenhuma chave de NCM corresponde à busca.'
                : 'Sem nenhuma chave, o imposto de todas as vendas fica 0%. Cadastre a alíquota padrão e as chaves dos seus NCMs.'
            }
            action={
              podeEscrever && !busca ? (
                <button className="btn-accent" onClick={abrirNova}>
                  Cadastrar alíquota
                </button>
              ) : undefined
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 text-left text-xs uppercase text-slate-400 dark:border-navy-700">
              <tr>
                <th className="px-3 py-2">NCM (chave)</th>
                <th className="px-3 py-2">Descrição</th>
                <th className="px-2 py-2 text-right">Alíquota</th>
                <th className="px-3 py-2">Atualizado</th>
                {podeEscrever && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {visiveis.map((i) => (
                <tr key={i.id} className="border-b border-slate-50 dark:border-navy-800">
                  <td className="px-3 py-2 font-mono text-xs">
                    {ehPadrao(i) ? <Badge tone="blue">PADRÃO</Badge> : chaveDe(i)}
                  </td>
                  <td className="px-3 py-2 text-navy-900 dark:text-white">{i.descricao || '—'}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{pct(i.aliquota_pct)}</td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {i.atualizado_em ? formatDateTime(String(i.atualizado_em)) : i.criado_em ? formatDateTime(String(i.criado_em)) : '—'}
                  </td>
                  {podeEscrever && (
                    <td className="px-3 py-2">
                      <div className="flex justify-end gap-1">
                        <button className="btn-icon" title="Editar" onClick={() => abrirEdicao(i)}>
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button className="btn-icon" title="Excluir" onClick={() => setExcluindo(i)}>
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ConfirmacaoInline
        open={!!excluindo}
        danger
        busy={ocupado}
        title="Excluir alíquota"
        message={
          excluindo
            ? ehPadrao(excluindo)
              ? 'A linha PADRÃO é o que define o imposto dos NCMs sem chave. Sem ela, essas vendas passam a ser calculadas com 0% de imposto.'
              : `A chave ${chaveDe(excluindo)} deixa de ser considerada no cálculo de novos impostos (vendas já calculadas não mudam).`
            : ''
        }
        confirmLabel="Excluir"
        onConfirm={() => void excluir()}
        onCancel={() => setExcluindo(null)}
      />
    </div>
  );
}
