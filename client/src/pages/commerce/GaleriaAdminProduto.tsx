// ============================================================================
// COMMERCE — GALERIA ADMINISTRATIVA DO PRODUTO (seção de /commerce/produtos/:id).
//
// ZERO MODAL: upload, ordem, principal, ATIVA/INATIVA, texto alternativo,
// vínculo com variação e exclusão (com confirmação INLINE) vivem na própria
// página. Não há Dialog/Drawer/Sheet/overlay/lightbox nem window.confirm().
//
// Reaproveita a infraestrutura existente `server/src/uploads.ts`:
//   GET    /api/produtos/:id/arquivos
//   POST   /api/produtos/:id/arquivos           (prepareImage → tipo/tamanho validados)
//   PUT    /api/produtos/:id/arquivos/:fid      { principal | ordem[] | alt_text | ativo | variante_id }
//   DELETE /api/produtos/:id/arquivos/:fid
// O servidor é a autoridade de tenant (SEC-01), tipo, tamanho e limite de 20
// fotos. A tela NUNCA expõe token, mime, bytes ou caminho interno de arquivo:
// só as URLs públicas com token devolvidas por `toPublicFile`.
// ============================================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Save, Star, Trash2 } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { prepareImage } from '../../lib/images';
import { Alert, Badge, ConfirmacaoInline, useToast } from '../../components/ui';

/** Mesmo limite de `resources.ts → produtos.images.max` (servidor é autoridade). */
const MAX_FOTOS = 20;

export type FotoGaleria = {
  id: number;
  nome: string | null;
  url: string;
  thumb_url: string;
  principal: boolean;
  ordem: number;
  alt_text: string | null;
  ativo: boolean;
  variante_id: number | null;
};

type OpcaoVariante = { value: number; label: string };

function ordenar(a: FotoGaleria, b: FotoGaleria): number {
  return Number(!!b.principal) - Number(!!a.principal) || a.ordem - b.ordem || a.id - b.id;
}

const mensagem = (e: unknown, fallback: string) =>
  e instanceof ApiError || e instanceof Error ? e.message : fallback;

export default function GaleriaAdminProduto({ produtoId, canEdit }: { produtoId: number; canEdit: boolean }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fotos, setFotos] = useState<FotoGaleria[]>([]);
  const [variantes, setVariantes] = useState<OpcaoVariante[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [ocupado, setOcupado] = useState<number | 'upload' | null>(null);
  const [paraExcluir, setParaExcluir] = useState<FotoGaleria | null>(null);

  // Rascunhos locais por foto — só viram dado persistido no clique de Salvar.
  const [altRascunho, setAltRascunho] = useState<Record<number, string>>({});
  const [varianteRascunho, setVarianteRascunho] = useState<Record<number, string>>({});
  // Metadados aplicados ao PRÓXIMO upload (opcionais).
  const [novoAlt, setNovoAlt] = useState('');
  const [novaVariante, setNovaVariante] = useState('');

  const caminho = useCallback((fid?: number) => `/produtos/${produtoId}/arquivos${fid ? `/${fid}` : ''}`, [produtoId]);

  const aplicar = useCallback((lista: FotoGaleria[]) => {
    const ordenada = (Array.isArray(lista) ? lista : []).slice().sort(ordenar);
    setFotos(ordenada);
    const alts: Record<number, string> = {};
    const vars: Record<number, string> = {};
    for (const f of ordenada) {
      alts[f.id] = f.alt_text ?? '';
      vars[f.id] = f.variante_id == null ? '' : String(f.variante_id);
    }
    setAltRascunho(alts);
    setVarianteRascunho(vars);
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [lista, opcoes] = await Promise.all([
        apiFetch<FotoGaleria[]>(caminho()).catch(() => [] as FotoGaleria[]),
        apiFetch<OpcaoVariante[]>('/tamanhos/options').catch(() => [] as OpcaoVariante[]),
      ]);
      aplicar(lista);
      setVariantes(Array.isArray(opcoes) ? opcoes : []);
    } catch (e) {
      setErro(mensagem(e, 'Não foi possível carregar a galeria.'));
    } finally {
      setCarregando(false);
    }
  }, [aplicar, caminho]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** PUT devolve a lista completa e autoritativa do servidor. */
  const atualizar = useCallback(
    async (fid: number, corpo: Record<string, unknown>, ok?: string) => {
      if (!canEdit) return;
      setOcupado(fid);
      setErro('');
      try {
        const lista = await apiFetch<FotoGaleria[]>(caminho(fid), { method: 'PUT', body: JSON.stringify(corpo) });
        aplicar(lista);
        if (ok) toast.success(ok);
      } catch (e) {
        setErro(mensagem(e, 'Falha ao atualizar a foto.'));
      } finally {
        setOcupado(null);
      }
    },
    [aplicar, caminho, canEdit, toast]
  );

  const mover = useCallback(
    (f: FotoGaleria, direcao: -1 | 1) => {
      const i = fotos.findIndex((x) => x.id === f.id);
      const destino = i + direcao;
      if (i < 0 || destino < 0 || destino >= fotos.length) return;
      const nova = fotos.slice();
      [nova[i], nova[destino]] = [nova[destino], nova[i]];
      // Persiste a ordem COMPLETA 1..n (o servidor grava índices contíguos).
      void atualizar(f.id, { ordem: nova.map((x) => x.id) }, `Ordem atualizada: posições 1 a ${nova.length}.`);
    },
    [atualizar, fotos]
  );

  const enviar = useCallback(
    async (arquivos: FileList | File[]) => {
      if (!canEdit) return;
      const lista = Array.from(arquivos);
      if (!lista.length) return;
      const restantes = MAX_FOTOS - fotos.length;
      if (restantes <= 0) {
        setErro(`Limite de ${MAX_FOTOS} fotos atingido. Desative ou exclua uma antes de adicionar outra.`);
        return;
      }
      if (lista.length > restantes) toast.info(`Só cabem ${restantes} foto(s); as demais foram ignoradas.`);
      setOcupado('upload');
      setErro('');
      let criadas = 0;
      for (const arquivo of lista.slice(0, restantes)) {
        try {
          // prepareImage valida formato/tamanho e já reduz para <=1600 px + thumb 240 px.
          const preparada = await prepareImage(arquivo);
          await apiFetch<FotoGaleria>(caminho(), {
            method: 'POST',
            body: JSON.stringify({
              ...preparada,
              alt_text: novoAlt.trim() || null,
              ativo: true,
              variante_id: novaVariante ? Number(novaVariante) : null,
            }),
          });
          criadas += 1;
        } catch (e) {
          setErro(mensagem(e, 'Falha ao enviar a imagem.'));
        }
      }
      setOcupado(null);
      await carregar();
      if (criadas) toast.success(`${criadas} imagem(ns) adicionada(s) à galeria.`);
      if (inputRef.current) inputRef.current.value = '';
    },
    [canEdit, carregar, caminho, fotos.length, novaVariante, novoAlt, toast]
  );

  const excluir = useCallback(async () => {
    if (!paraExcluir || !canEdit) return;
    setOcupado(paraExcluir.id);
    setErro('');
    try {
      await apiFetch(caminho(paraExcluir.id), { method: 'DELETE' });
      setParaExcluir(null);
      await carregar();
      toast.success('Imagem excluída. As demais fotos foram mantidas.');
    } catch (e) {
      setErro(mensagem(e, 'Falha ao excluir a imagem.'));
    } finally {
      setOcupado(null);
    }
  }, [canEdit, carregar, caminho, paraExcluir, toast]);

  const rotuloVariante = useMemo(() => {
    const mapa = new Map(variantes.map((v) => [Number(v.value), String(v.label)]));
    return (id: number | null) => (id == null ? 'Produto (todas as variações)' : mapa.get(Number(id)) ?? `Variação ${id}`);
  }, [variantes]);

  return (
    <section className="rounded-xl border border-line bg-surface p-4" aria-labelledby="galeria-admin-produto">
      <h2 id="galeria-admin-produto" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted">
        <ImagePlus className="h-4 w-4" aria-hidden="true" /> Galeria do produto
      </h2>
      <p className="mt-1 text-xs text-muted">
        Ordem 1 a {fotos.length} · imagem principal sem duplicar arquivo · ATIVA/INATIVA sem apagar · texto alternativo
        real em <code>arquivos.alt_text</code> · vínculo opcional produto → variação → imagem.
      </p>

      {erro && <Alert tone="red">{erro}</Alert>}

      {canEdit && (
        <div className="mt-3 grid gap-2 rounded-lg border border-line bg-canvas p-3 md:grid-cols-4">
          <label className="text-xs font-medium text-muted md:col-span-2">
            Texto alternativo das novas imagens (acessibilidade/SEO)
            <input
              className="input mt-1 w-full"
              value={novoAlt}
              maxLength={180}
              aria-label="Texto alternativo das novas imagens"
              placeholder="Ex.: Camiseta vermelha com logo branca"
              onChange={(e) => setNovoAlt(e.target.value)}
            />
          </label>
          <label className="text-xs font-medium text-muted">
            Variação das novas imagens
            <select
              className="input mt-1 w-full"
              value={novaVariante}
              aria-label="Variação das novas imagens"
              onChange={(e) => setNovaVariante(e.target.value)}
            >
              <option value="">Produto (todas)</option>
              {variantes.map((v) => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end">
            <button
              type="button"
              className="btn-primary w-full"
              disabled={ocupado === 'upload' || fotos.length >= MAX_FOTOS}
              onClick={() => inputRef.current?.click()}
            >
              {ocupado === 'upload' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" aria-hidden="true" />}
              {ocupado === 'upload' ? 'Enviando…' : 'Adicionar imagens'}
            </button>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            className="hidden"
            aria-label="Selecionar imagens da galeria"
            onChange={(e) => e.target.files && void enviar(e.target.files)}
          />
          <p className="text-xs text-muted md:col-span-4">
            JPG, PNG ou WebP · até 25 MB por arquivo (otimizada para 1600 px + miniatura de 240 px) · {fotos.length}/{MAX_FOTOS} imagens.
          </p>
        </div>
      )}

      {carregando ? (
        <p className="mt-3 text-sm text-muted" role="status">Carregando galeria…</p>
      ) : (
        <ol className="mt-3 grid gap-3 md:grid-cols-2" aria-label="Imagens da galeria em ordem de exibição">
          {fotos.map((f, i) => (
            <li key={f.id} className="rounded-lg border border-line bg-canvas p-3">
              <div className="flex gap-3">
                <img
                  src={f.thumb_url || f.url}
                  alt={f.alt_text || `Imagem ${i + 1} do produto`}
                  className="h-24 w-24 shrink-0 rounded-md border border-line object-cover"
                  loading="lazy"
                />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-xs font-semibold text-muted">Posição {i + 1}</span>
                    {f.principal && <Badge tone="green">Imagem principal</Badge>}
                    <Badge tone={f.ativo ? 'green' : 'slate'}>{f.ativo ? 'ATIVA' : 'INATIVA'}</Badge>
                  </div>
                  <p className="truncate text-xs text-muted">Variação: {rotuloVariante(f.variante_id)}</p>
                  {canEdit && (
                    <div className="flex flex-wrap gap-1.5">
                      {!f.principal && (
                        <button type="button" className="btn-ghost" disabled={ocupado === f.id}
                          onClick={() => void atualizar(f.id, { principal: true }, 'Imagem principal definida sem duplicar arquivo.')}>
                          <Star className="h-3.5 w-3.5" aria-hidden="true" /> Principal
                        </button>
                      )}
                      <button type="button" className="btn-ghost" aria-label={`Subir imagem ${i + 1}`} disabled={i === 0 || ocupado === f.id}
                        onClick={() => mover(f, -1)}>
                        <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button type="button" className="btn-ghost" aria-label={`Descer imagem ${i + 1}`} disabled={i === fotos.length - 1 || ocupado === f.id}
                        onClick={() => mover(f, 1)}>
                        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                      <button type="button" className="btn-ghost" disabled={ocupado === f.id}
                        onClick={() => void atualizar(f.id, { ativo: !f.ativo }, f.ativo ? 'Imagem marcada INATIVA (não foi apagada).' : 'Imagem marcada ATIVA.')}>
                        {f.ativo ? 'Desativar' : 'Ativar'}
                      </button>
                      <button type="button" className="btn-ghost" disabled={ocupado === f.id} onClick={() => setParaExcluir(f)}>
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Excluir
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {canEdit && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="text-xs font-medium text-muted">
                    Texto alternativo
                    <div className="mt-1 flex gap-1.5">
                      <input
                        className="input min-w-0 flex-1"
                        value={altRascunho[f.id] ?? ''}
                        maxLength={180}
                        aria-label={`Texto alternativo da imagem ${i + 1}`}
                        placeholder="Descreva a imagem"
                        onChange={(e) => setAltRascunho((p) => ({ ...p, [f.id]: e.target.value }))}
                      />
                      <button type="button" className="btn-secondary" disabled={ocupado === f.id}
                        onClick={() => void atualizar(f.id, { alt_text: (altRascunho[f.id] ?? '').trim() }, 'Texto alternativo salvo.')}>
                        <Save className="h-3.5 w-3.5" aria-hidden="true" /> Salvar
                      </button>
                    </div>
                  </label>
                  <label className="text-xs font-medium text-muted">
                    Variação (produto → variação → imagem)
                    <div className="mt-1 flex gap-1.5">
                      <select
                        className="input min-w-0 flex-1"
                        value={varianteRascunho[f.id] ?? ''}
                        aria-label={`Variação da imagem ${i + 1}`}
                        onChange={(e) => setVarianteRascunho((p) => ({ ...p, [f.id]: e.target.value }))}
                      >
                        <option value="">Produto (todas)</option>
                        {variantes.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
                      </select>
                      <button type="button" className="btn-secondary" disabled={ocupado === f.id}
                        onClick={() => {
                          const bruto = varianteRascunho[f.id] ?? '';
                          void atualizar(f.id, { variante_id: bruto ? Number(bruto) : null }, 'Vínculo com a variação salvo.');
                        }}>
                        <Save className="h-3.5 w-3.5" aria-hidden="true" /> Salvar
                      </button>
                    </div>
                  </label>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {!carregando && !fotos.length && <p className="mt-3 text-sm text-muted">Nenhuma imagem cadastrada. A loja mostra o placeholder honesto, sem inventar foto.</p>}

      <ConfirmacaoInline
        open={!!paraExcluir}
        title="Excluir imagem da galeria"
        message={paraExcluir ? `Confirma a exclusão da imagem na posição ${fotos.findIndex((f) => f.id === paraExcluir.id) + 1}? Ela será removida do cadastro; as demais imagens, a ordem e o produto permanecem intactos.` : ''}
        confirmLabel="Excluir imagem"
        danger
        busy={!!paraExcluir && ocupado === paraExcluir.id}
        onConfirm={() => void excluir()}
        onCancel={() => setParaExcluir(null)}
      />
    </section>
  );
}
