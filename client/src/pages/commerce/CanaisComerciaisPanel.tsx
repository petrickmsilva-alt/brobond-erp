// ============================================================================
// COMMERCE — CANAIS COMERCIAIS OFICIAIS (Fase 9.4).
//
// Apresenta, em UMA visão, os três canais oficiais (ADR-0005):
//   RETAIL         → WooCommerce (brobond.com.br)
//   WHOLESALE      → WooCommerce (atacado.brobond.com.br)
//   REPRESENTATIVES→ Portal de representantes (catalogo.brobond.com.br)
//
// REGRA DE HONESTIDADE: um canal NUNCA aparece como "conectado" sem teste REAL
// de conexão (?testar=1). REPRESENTATIVES não tem conector no repositório e
// aparece como "não homologado" — jamais como conectado. Nenhuma credencial
// chega ao navegador. Vive dentro do painel Omnichannel (não cria menu paralelo).
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { BadgeCheck, Plug, RefreshCw, Store } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { Alert, Badge, Spinner } from '../../components/ui';
import { dataHora } from './shared';

type EstadoCanal = 'nao_configurado' | 'configurado' | 'conectado' | 'erro' | 'nao_homologado';

type Canal = {
  canal: 'RETAIL' | 'WHOLESALE' | 'REPRESENTATIVES';
  rotulo: string;
  plataforma: string;
  endereco: string;
  loja: string | null;
  preco_fonte: string | null;
  canal_venda: string | null;
  estado: EstadoCanal;
  conexao: { ok: boolean; erro?: string } | null;
  ultima_sincronizacao: string | null;
  ultimo_erro: string | null;
  pendencia: string | null;
  evidencia: string;
};

type Resposta = { empresa_id: number; testado: boolean; canais: Canal[]; nota: string };

const TOM: Record<EstadoCanal, 'green' | 'blue' | 'amber' | 'red' | 'slate'> = {
  conectado: 'green',
  configurado: 'blue',
  nao_configurado: 'slate',
  erro: 'red',
  nao_homologado: 'amber',
};

const ROTULO_ESTADO: Record<EstadoCanal, string> = {
  conectado: 'Conectado',
  configurado: 'Configurado (não testado)',
  nao_configurado: 'Não configurado',
  erro: 'Erro de conexão',
  nao_homologado: 'Homologação pendente',
};

const ROTULO_PRECO: Record<string, string> = {
  preco_venda: 'preco_venda',
  preco_atacado: 'preco_atacado',
};

export default function CanaisComerciaisPanel() {
  const [dados, setDados] = useState<Resposta | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [testando, setTestando] = useState(false);

  const carregar = useCallback(async (testar = false) => {
    if (testar) setTestando(true);
    else setCarregando(true);
    setErro('');
    try {
      const r = await apiFetch<Resposta>(`/commerce/canais${testar ? '?testar=1' : ''}`);
      if (!Array.isArray(r?.canais)) throw new Error('Resposta de canais inválida.');
      setDados(r);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar os canais comerciais.');
    } finally {
      setCarregando(false);
      setTestando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="canais-comerciais">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="canais-comerciais" className="flex items-center gap-2 text-sm font-semibold">
          <Store className="h-4 w-4" aria-hidden="true" /> Canais comerciais oficiais
        </h2>
        <button type="button" className="btn-ghost" disabled={testando || carregando} onClick={() => void carregar(true)}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" /> {testando ? 'Testando…' : 'Testar conexões'}
        </button>
      </div>

      {carregando ? (
        <div className="mt-3">
          <Spinner label="Carregando canais…" />
        </div>
      ) : erro ? (
        <div className="mt-3">
          <Alert tone="red">{erro}</Alert>
        </div>
      ) : !dados ? (
        <div className="mt-3">
          <Alert tone="amber">Painel de canais indisponível.</Alert>
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {dados.canais.map((c) => (
              <div key={c.canal} className="rounded-lg border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.rotulo}</span>
                  <Badge tone={TOM[c.estado]}>{ROTULO_ESTADO[c.estado]}</Badge>
                </div>
                <div className="mt-2 space-y-1 text-xs text-muted">
                  <div className="flex items-center gap-1">
                    <Plug className="h-3.5 w-3.5" aria-hidden="true" /> {c.plataforma}
                  </div>
                  <a href={c.endereco} target="_blank" rel="noreferrer" className="block text-brand-700 hover:underline">
                    {c.endereco}
                  </a>
                  {c.loja && <div>Loja: <span className="font-mono">{c.loja}</span></div>}
                  {c.preco_fonte && <div>Preço: <span className="font-mono">{ROTULO_PRECO[c.preco_fonte] ?? c.preco_fonte}</span></div>}
                  <div>Última sincronização: {c.ultima_sincronizacao ? dataHora(c.ultima_sincronizacao) : '—'}</div>
                  {c.ultimo_erro && <div className="text-danger" title={c.ultimo_erro}>Último erro: {c.ultimo_erro}</div>}
                  {c.pendencia && <div className="text-amber-700">Pendência: {c.pendencia}</div>}
                </div>
                <div className="mt-2 flex items-start gap-1 text-[11px] text-muted">
                  <BadgeCheck className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                  <span>{c.evidencia}</span>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted">{dados.nota}</p>
        </>
      )}
    </section>
  );
}
