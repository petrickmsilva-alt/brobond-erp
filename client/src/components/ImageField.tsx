import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Camera, ImagePlus, Loader2, Star, Trash2, X, ZoomIn } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { PublicFile, ResourceMeta } from '../lib/meta';
import { prepareImage } from '../lib/images';
import { formatBytes } from '../lib/format';
import { useToast } from './ui';

/**
 * Galeria de fotos de um registro já salvo: upload (arrastar/soltar, câmera),
 * marcar principal, reordenar, remover e ampliar.
 */
export function ImageField({
  resource,
  recordId,
  initial,
  canEdit,
  onChange,
  compact = false,
}: {
  resource: ResourceMeta;
  recordId: number;
  initial?: PublicFile[];
  canEdit: boolean;
  onChange?: (files: PublicFile[]) => void;
  compact?: boolean;
}) {
  const toast = useToast();
  const max = resource.images?.max ?? 5;
  const [files, setFiles] = useState<PublicFile[]>(initial ?? []);
  const [loading, setLoading] = useState(!initial);
  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [zoom, setZoom] = useState<PublicFile | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const apply = useCallback(
    (list: PublicFile[]) => {
      setFiles(list);
      onChange?.(list);
    },
    [onChange]
  );

  useEffect(() => {
    if (initial) return;
    let alive = true;
    api
      .get<PublicFile[]>(`/${resource.key}/${recordId}/arquivos`)
      .then((l) => alive && apply(l))
      .catch(() => alive && apply([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource.key, recordId]);

  async function addFiles(list: FileList | File[]) {
    const arr = Array.from(list);
    if (!arr.length) return;
    const room = max - files.length - uploading.length;
    if (room <= 0) {
      toast.error(`Limite de ${max} fotos atingido. Remova uma antes.`);
      return;
    }
    const batch = arr.slice(0, room);
    if (batch.length < arr.length) toast.info(`Só ${room} foto(s) cabem — as demais foram ignoradas.`);
    for (const f of batch) {
      const key = `${f.name}-${f.size}-${Date.now()}`;
      setUploading((u) => [...u, key]);
      try {
        const prepared = await prepareImage(f);
        const created = await api.post<PublicFile>(`/${resource.key}/${recordId}/arquivos`, prepared);
        setFiles((cur) => {
          const next = [...cur, created];
          onChange?.(next);
          return next;
        });
      } catch (e: any) {
        toast.error(e instanceof ApiError || e instanceof Error ? e.message : 'Falha ao enviar a foto.');
      } finally {
        setUploading((u) => u.filter((k) => k !== key));
      }
    }
  }

  async function setPrincipal(f: PublicFile) {
    try {
      apply(await api.put<PublicFile[]>(`/${resource.key}/${recordId}/arquivos/${f.id}`, { principal: true }));
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function move(f: PublicFile, dir: -1 | 1) {
    const idx = files.findIndex((x) => x.id === f.id);
    const to = idx + dir;
    if (idx < 0 || to < 0 || to >= files.length) return;
    const next = files.slice();
    [next[idx], next[to]] = [next[to], next[idx]];
    // reordenar não muda a principal: quem está em 1º vira principal
    try {
      let out = await api.put<PublicFile[]>(`/${resource.key}/${recordId}/arquivos/${f.id}`, { ordem: next.map((x) => x.id) });
      if (out[0] && !out[0].principal) out = await api.put<PublicFile[]>(`/${resource.key}/${recordId}/arquivos/${out[0].id}`, { principal: true });
      apply(out);
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function remove(f: PublicFile) {
    if (!window.confirm('Remover esta foto?')) return;
    try {
      await api.del(`/${resource.key}/${recordId}/arquivos/${f.id}`);
      apply(await api.get<PublicFile[]>(`/${resource.key}/${recordId}/arquivos`));
      toast.success('Foto removida.');
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  const tile = compact ? 'h-20 w-20' : 'h-28 w-28 sm:h-32 sm:w-32';

  return (
    <div>
      <div
        className={`flex flex-wrap gap-3 rounded-xl border-2 border-dashed p-3 transition ${dragging ? 'border-brand-500 bg-brand-50/50' : 'border-slate-200 bg-slate-50/50'}`}
        onDragOver={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          if (!canEdit) return;
          e.preventDefault();
          setDragging(false);
          addFiles(e.dataTransfer.files);
        }}
      >
        {loading && (
          <div className={`${tile} flex items-center justify-center text-slate-400`}>
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        )}

        {files.map((f, i) => (
          <figure key={f.id} className={`group relative ${tile} overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm`}>
            <img src={f.thumb_url} alt={f.nome || 'Foto'} className="h-full w-full cursor-zoom-in object-cover" loading="lazy" onClick={() => setZoom(f)} />
            {f.principal && (
              <span className="absolute left-1 top-1 inline-flex items-center gap-0.5 rounded bg-brand-500 px-1.5 py-0.5 text-[10px] font-bold uppercase text-white shadow">
                <Star className="h-3 w-3 fill-current" /> principal
              </span>
            )}
            {canEdit && (
              <figcaption className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-gradient-to-t from-navy-950/80 to-transparent p-1 opacity-0 transition group-hover:opacity-100">
                {!f.principal && (
                  <button type="button" className="rounded p-1 text-white hover:bg-white/20" title="Marcar como principal" onClick={() => setPrincipal(f)}>
                    <Star className="h-3.5 w-3.5" />
                  </button>
                )}
                <button type="button" className="rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="Mover para a esquerda" disabled={i === 0} onClick={() => move(f, -1)}>
                  <ArrowLeft className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="rounded p-1 text-white hover:bg-white/20 disabled:opacity-30" title="Mover para a direita" disabled={i === files.length - 1} onClick={() => move(f, 1)}>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
                <button type="button" className="rounded p-1 text-white hover:bg-red-500/80" title="Remover" onClick={() => remove(f)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </figcaption>
            )}
          </figure>
        ))}

        {uploading.map((k) => (
          <div key={k} className={`${tile} flex flex-col items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white text-xs text-slate-400`}>
            <Loader2 className="h-5 w-5 animate-spin text-brand-500" />
            enviando...
          </div>
        ))}

        {canEdit && files.length + uploading.length < max && (
          <div className={`${tile} flex flex-col gap-1.5`}>
            <button
              type="button"
              className="flex flex-1 flex-col items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white text-xs font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700"
              onClick={() => inputRef.current?.click()}
            >
              <ImagePlus className="h-5 w-5" />
              {compact ? 'Foto' : 'Adicionar'}
            </button>
            <button
              type="button"
              className="flex items-center justify-center gap-1 rounded-lg border border-slate-300 bg-white py-1 text-[11px] font-medium text-slate-600 hover:border-brand-400 hover:text-brand-700 sm:hidden"
              onClick={() => cameraRef.current?.click()}
            >
              <Camera className="h-3.5 w-3.5" /> Câmera
            </button>
          </div>
        )}

        {!loading && !files.length && !canEdit && <p className="self-center text-sm text-slate-400">Sem fotos.</p>}

        <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" onChange={(e) => e.target.files && addFiles(e.target.files).then(() => (e.target.value = ''))} />
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => e.target.files && addFiles(e.target.files).then(() => (e.target.value = ''))} />
      </div>
      {canEdit && (
        <p className="mt-1.5 text-xs text-slate-400">
          {files.length}/{max} fotos · arraste e solte ou clique em Adicionar · as imagens são otimizadas automaticamente (máx. 1600 px)
        </p>
      )}

      {zoom && <Lightbox file={zoom} files={files} onClose={() => setZoom(null)} onNav={setZoom} />}
    </div>
  );
}

export function Lightbox({ file, files, onClose, onNav }: { file: PublicFile; files: PublicFile[]; onClose: () => void; onNav: (f: PublicFile) => void }) {
  const idx = files.findIndex((f) => f.id === file.id);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight' && files[idx + 1]) onNav(files[idx + 1]);
      if (e.key === 'ArrowLeft' && files[idx - 1]) onNav(files[idx - 1]);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [idx, files, onClose, onNav]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-navy-950/90 p-4" onClick={onClose} role="dialog" aria-modal="true">
      <button className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={onClose} aria-label="Fechar">
        <X className="h-5 w-5" />
      </button>
      {files[idx - 1] && (
        <button className="absolute left-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={(e) => (e.stopPropagation(), onNav(files[idx - 1]))} aria-label="Anterior">
          <ArrowLeft className="h-5 w-5" />
        </button>
      )}
      <img src={file.url} alt={file.nome || ''} className="max-h-[88vh] max-w-full rounded-lg object-contain shadow-2xl" onClick={(e) => e.stopPropagation()} />
      {files[idx + 1] && (
        <button className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" onClick={(e) => (e.stopPropagation(), onNav(files[idx + 1]))} aria-label="Próxima">
          <ArrowRight className="h-5 w-5" />
        </button>
      )}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-white/10 px-3 py-1 text-xs text-white">
        {idx + 1} / {files.length} · {file.nome} {file.tamanho_bytes ? `· ${formatBytes(file.tamanho_bytes)}` : ''}
      </div>
    </div>
  );
}

/** Miniatura para listas (com fallback quando não há foto). */
export function Thumb({ src, alt, size = 40, onClick }: { src?: string | null; alt?: string; size?: number; onClick?: () => void }) {
  const cls = 'shrink-0 overflow-hidden rounded-md border border-slate-200 bg-slate-100';
  if (!src)
    return (
      <span className={`${cls} flex items-center justify-center text-slate-300`} style={{ width: size, height: size }} title="Sem foto">
        <Camera className="h-4 w-4" />
      </span>
    );
  return (
    <button type="button" className={`${cls} ${onClick ? 'cursor-zoom-in' : 'cursor-default'}`} style={{ width: size, height: size }} onClick={onClick} title={alt}>
      <img src={src} alt={alt || ''} className="h-full w-full object-cover" loading="lazy" />
    </button>
  );
}

/** Amostra de cor (bolinha) + nome. */
export function ColorDot({ hex, label, size = 14 }: { hex?: string | null; label?: string | null; size?: number }) {
  if (!hex && !label) return <span className="text-slate-300">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {hex && <span className="inline-block shrink-0 rounded-full border border-slate-300 shadow-inner" style={{ width: size, height: size, backgroundColor: hex }} title={hex} />}
      {label && <span>{label}</span>}
    </span>
  );
}
