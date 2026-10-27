// ============================================================================
// TERRITÓRIOS (MA-02) — LISTA + ÁRVORE, padrão LISTA → PÁGINA.
//
// A listagem em si vem do CadastroComercialPage (busca, filtros, ordenação,
// paginação, export, exclusão com diagnóstico). O que esta tela acrescenta é a
// VISÃO DE HIERARQUIA — a pergunta que um território existe para responder
// ("como a operação está organizada?").
//
// A árvore é calculada pelo SERVIDOR (`GET /api/comercial/territorios/arvore`),
// que sobe a cadeia de `territorio_pai_id` respeitando o tenant. A tela não
// remonta a hierarquia no cliente (o que exigiria carregar todos os registros e
// divergiria do que o servidor valida).
// ============================================================================
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, GitBranch, RefreshCw } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, Badge, PageHeader, Spinner } from '../components/ui';
import CadastroComercialPage from './CadastroComercialPage';

type No = {
  id: number;
  nome: string | null;
  codigo: string | null;
  tipo: string | null;
  nivel: number;
  status: string | null;
  uf: string | null;
  cidade: string | null;
  profundidade: number;
  filhos: No[];
};

const ROTULO_TIPO: Record<string, string> = {
  pais: 'País',
  estado: 'Estado',
  regiao: 'Região',
  cidade: 'Cidade',
  zona: 'Zona',
  comercial: 'Comercial',
  digital: 'Digital',
  key_account: 'Key Account',
  especial: 'Especial',
  canal: 'Canal',
};

function NoDaArvore({ no, aberto, onToggle }: { no: No; aberto: Record<number, boolean>; onToggle: (id: number) => void }) {
  const temFilhos = no.filhos.length > 0;
  const expandido = aberto[no.id] ?? no.profundidade <= 1;
  return (
    <li>
      <div
        className="flex items-center gap-2 border-b border-line/60 px-2 py-1.5 text-sm last:border-b-0"
        style={{ paddingLeft: `${8 + (no.profundidade - 1) * 18}px` }}
      >
        {temFilhos ? (
          <button
            type="button"
            onClick={() => onToggle(no.id)}
            className="rounded p-0.5 text-slate-500 hover:bg-slate-100 dark:hover:bg-navy-800"
            aria-label={expandido ? `Recolher ${no.nome ?? ''}` : `Expandir ${no.nome ?? ''}`}
            aria-expanded={expandido}
          >
            {expandido ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="inline-block w-5" aria-hidden="true" />
        )}
        <span className="font-medium text-navy-900 dark:text-white">{no.nome ?? `#${no.id}`}</span>
        {no.codigo && <span className="font-mono text-xs text-slate-400">{no.codigo}</span>}
        <Badge tone="slate">{ROTULO_TIPO[String(no.tipo)] ?? String(no.tipo ?? '—')}</Badge>
        {(no.cidade || no.uf) && (
          <span className="text-xs text-slate-500">{[no.cidade, no.uf].filter(Boolean).join(' / ')}</span>
        )}
        {no.status !== 'ativo' && <Badge tone="red">Inativo</Badge>}
        <span className="ml-auto text-xs text-slate-400">nível {no.nivel}</span>
      </div>
      {temFilhos && expandido && (
        <ul className="list-none">
          {no.filhos.map((filho) => (
            <NoDaArvore key={filho.id} no={filho} aberto={aberto} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ArvoreTerritorios() {
  const [arvore, setArvore] = useState<No[]>([]);
  const [total, setTotal] = useState(0);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [aberto, setAberto] = useState<Record<number, boolean>>({});

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const d = await api.get<{ total: number; arvore: No[] }>('/comercial/territorios/arvore');
      setArvore(d.arvore);
      setTotal(d.total);
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar a hierarquia.');
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const onToggle = useCallback((id: number) => {
    setAberto((atual) => ({ ...atual, [id]: !(atual[id] ?? false) }));
  }, []);

  if (carregando) return <Spinner label="Carregando hierarquia..." />;
  if (erro) return <Alert tone="amber">{erro}</Alert>;
  if (!arvore.length) {
    return (
      <Alert tone="slate">
        Nenhum território cadastrado ainda. Crie o primeiro (por exemplo, o Brasil) e vá acrescentando estados, regiões e zonas — o
        nível é calculado pelo servidor.
      </Alert>
    );
  }

  return (
    <section className="card overflow-hidden" aria-label="Hierarquia de territórios">
      <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold text-navy-900 dark:text-white">
          <GitBranch className="h-4 w-4" /> Hierarquia
        </h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{total} território(s)</span>
          <button type="button" className="btn-secondary !px-2 !py-1" onClick={() => void carregar()} title="Recarregar hierarquia">
            <RefreshCw className="h-3.5 w-3.5" /> Atualizar
          </button>
        </div>
      </header>
      <ul className="list-none">
        {arvore.map((no) => (
          <NoDaArvore key={no.id} no={no} aberto={aberto} onToggle={onToggle} />
        ))}
      </ul>
    </section>
  );
}

export default function TerritoriosPage() {
  // A árvore é o cabeçalho da lista; recarrega a cada montagem da tela.
  const cabecalho = useMemo<ReactNode>(() => <ArvoreTerritorios />, []);
  return <CadastroComercialPage recurso="territorios" extraHeader={<div className="mb-4">{cabecalho}</div>} />;
}
