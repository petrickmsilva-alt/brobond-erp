// ============================================================================
// GRADE E VARIAÇÕES do produto — painel do cadastro (página /produtos/:id/editar).
//
// Reusa o mecanismo que JÁ existe no servidor (server/src/variacoes.ts): as
// combinações cor × tamanho são calculadas no backend a partir da grade e das
// cores escolhidas, e cada combinação vira um produto filho com SKU próprio.
//
// Aqui não há um segundo cadastro de tamanhos: a grade é a de sempre
// (`grades` / `grade_tamanhos`). O painel só mostra as variações já
// materializadas e oferece a prévia + geração pelo endpoint existente.
//
// Nada de estoque é decidido nesta tela — o saldo continua nas movimentações.
// ============================================================================
import { useCallback, useEffect, useState } from 'react';
import { Loader2, Ruler, Sparkles } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Badge, useToast } from './ui';

type Variacao = {
  id: number;
  sku: string;
  nome: string;
  variacao_chave: string | null;
  cor: string | null;
  tamanho_id: number | null;
  ativo: boolean;
};

type RespostaVariacoes = {
  produto_pai: { id: number; sku: string; nome: string; formato: string };
  total: number;
  variacoes: Variacao[];
};

export function VariacoesProduto({ produto, podeGerar }: { produto: Record<string, any>; podeGerar: boolean }) {
  const toast = useToast();
  const [dados, setDados] = useState<RespostaVariacoes | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await api.get<RespostaVariacoes>(`/produtos/${produto.id}/variacoes`));
      setErro('');
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar as variações.');
    } finally {
      setCarregando(false);
    }
  }, [produto.id]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Só um produto PAI (não uma variação) e sem filho pode gerar variações.
  const ehVariacao = Boolean(produto.produto_pai_id);
  const temGrade = Boolean(produto.grade_id);
  const podeAqui = podeGerar && !ehVariacao && temGrade;

  async function gerar() {
    try {
      const r = await api.post<{ mensagem: string }>(`/produtos/${produto.id}/variacoes`, { grade_id: produto.grade_id });
      toast.success(r?.mensagem || 'Variações geradas.');
      await carregar();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível gerar as variações.');
    }
  }

  if (carregando) {
    return (
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando variações...
      </div>
    );
  }

  if (erro) {
    return <p className="text-sm text-slate-500">{erro}</p>;
  }

  const variacoes = dados?.variacoes ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={produto.formato === 'variacao' ? 'blue' : 'slate'}>{produto.formato === 'variacao' ? 'Com variação' : 'Simples'}</Badge>
        <span className="text-sm text-slate-500">
          {variacoes.length} variação(ões) materializada(s)
        </span>
        {podeAqui && (
          <button type="button" className="btn-secondary ml-auto inline-flex" onClick={gerar}>
            <Sparkles className="h-4 w-4" /> Gerar variações da grade
          </button>
        )}
      </div>

      {ehVariacao && (
        <p className="rounded-md bg-navy-50 px-3 py-2 text-xs text-navy-700">
          Este produto é uma variação. A grade e as demais variações são geridas pelo produto pai.
        </p>
      )}
      {!ehVariacao && !temGrade && (
        <p className="flex items-start gap-1.5 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <Ruler className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          Selecione uma <strong className="mx-1 font-semibold">Grade de tamanhos</strong> acima e salve para poder gerar as variações.
        </p>
      )}

      {variacoes.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="table table-compact">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nome</th>
                <th>Cor</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {variacoes.map((v) => (
                <tr key={v.id}>
                  <td className="font-mono text-xs">{v.sku}</td>
                  <td>{v.nome}</td>
                  <td>{v.cor ?? '—'}</td>
                  <td>{v.ativo === false ? <Badge tone="red">Inativo</Badge> : <Badge tone="green">Ativo</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !ehVariacao && (
          <p className="text-sm text-slate-500">
            Nenhuma variação ainda. Cada combinação de cor × tamanho vira um produto com SKU próprio — com estoque e preço individuais.
          </p>
        )
      )}
    </div>
  );
}
