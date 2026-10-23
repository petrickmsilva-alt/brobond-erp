import { useEffect, useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { barcodeSvg } from '../lib/barcode';
import { formatMoney } from '../lib/format';
import {
  getPreferredTerminal,
  imprimirEtiquetasTermicas,
  listarTerminaisImpressao,
  novaChaveIdempotencia,
  type TerminalConfigCliente,
} from '../lib/printAgent';
import { Modal, useToast } from './ui';

type Tam = { id: number; codigo: string };
type Grade = { local: string; celulas: { tamanho_id: number; quantidade: number }[] }[];
type Medidas = {
  medidas: { id: number; nome: string; unidade: string }[];
  linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[];
  instrucoes?: string | null;
  atualizada_em?: string | null;
} | null;

/** "2026-09-08T10:00:00Z" → "08/09/2026" (para a nota de rodapé da etiqueta). */
function dataCurta(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (m) return `${m[3]}/${m[2]}/${m[1]}`;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('pt-BR');
}

/**
 * Impressão de etiquetas do produto (código de barras + SKU/nome/tamanho/cor/preço).
 * Abre uma janela só com as etiquetas e chama a impressão do navegador.
 * Formato padrão: 3 colunas em A4 (compatível com Pimaco A4263 / 6182 e similares);
 * também há o modo "bobina 50×30 mm" para impressoras térmicas.
 */
export function LabelSheet({
  open,
  onClose,
  produto,
  tamanhos,
  grade,
  medidas,
  user,
}: {
  open: boolean;
  onClose: () => void;
  produto: Record<string, any>;
  tamanhos: Tam[];
  grade: Grade;
  medidas?: Medidas;
  user?: string;
}) {
  const toast = useToast();
  const [mode, setMode] = useState<'a4' | 'roll' | 'zpl' | 'epl2'>('a4');
  const [showPrice, setShowPrice] = useState(true);
  const [showMedidas, setShowMedidas] = useState(false);
  const [terminal, setTerminal] = useState(() => getPreferredTerminal());
  const [terminais, setTerminais] = useState<TerminalConfigCliente[]>([]);
  const [labelDims, setLabelDims] = useState<'50x30' | '40x25' | '60x40' | '100x50'>('50x30');
  const [dpi, setDpi] = useState<203 | 300>(203);
  const [enviandoFila, setEnviandoFila] = useState(false);
  const [idemKey, setIdemKey] = useState(() => novaChaveIdempotencia());

  useEffect(() => {
    if (!open) return;
    setIdemKey(novaChaveIdempotencia());
    listarTerminaisImpressao()
      .then((r) => setTerminais(r.rows.filter((t) => t.ativo)))
      .catch(() => {});
  }, [open]);
  const [qtd, setQtd] = useState<Record<number, number>>(() => {
    // sugestão: 1 por tamanho; se houver estoque, usa o saldo total do tamanho
    const out: Record<number, number> = {};
    for (const t of tamanhos) {
      const total = grade.reduce((a, g) => a + (g.celulas.find((c) => c.tamanho_id === t.id)?.quantidade || 0), 0);
      out[t.id] = total > 0 ? Math.min(total, 200) : 1;
    }
    return out;
  });
  const [extra, setExtra] = useState(tamanhos.length === 0 ? 10 : 0);

  const code = String(produto.codigo_barras || produto.sku || '').trim();
  const cor = produto.cor_id__label || produto.cor || '';
  const total = useMemo(() => Object.values(qtd).reduce((a, b) => a + (Number(b) || 0), 0) + (Number(extra) || 0), [qtd, extra]);

  async function print() {
    if (mode === 'zpl' || mode === 'epl2') {
      const itens: { produto_id: number; tamanho_id?: number | null; quantidade: number }[] = [];
      for (const t of tamanhos) {
        const q = Number(qtd[t.id]) || 0;
        if (q > 0) itens.push({ produto_id: Number(produto.id), tamanho_id: t.id, quantidade: q });
      }
      if ((Number(extra) || 0) > 0) {
        itens.push({ produto_id: Number(produto.id), tamanho_id: null, quantidade: Number(extra) });
      }
      if (!itens.length) return;
      const [wMm, hMm] = labelDims.split('x').map(Number);
      setEnviandoFila(true);
      try {
        const res = await imprimirEtiquetasTermicas({
          itens,
          protocol: mode,
          terminal: terminal || undefined,
          incluir_preco: showPrice,
          label_width_mm: wMm,
          label_height_mm: hMm,
          dpi,
          idempotency_key: idemKey,
        });
        toast.success(
          `${res.total_etiquetas} etiqueta(s) ${res.protocol.toUpperCase()} enfileirada(s) (Job #${res.job.public_id.slice(0, 8)}).`
        );
        setIdemKey(novaChaveIdempotencia());
        onClose();
      } catch (e: any) {
        toast.error(e?.message || 'Erro ao enfileirar etiquetas térmicas.');
      } finally {
        setEnviandoFila(false);
      }
      return;
    }

    const { svg, kind } = barcodeSvg(code, { height: mode === 'roll' ? 30 : 34, module: mode === 'roll' ? 1 : 1.1, fontSize: 8 });
    const items: { size: string }[] = [];
    for (const t of tamanhos) for (let i = 0; i < (Number(qtd[t.id]) || 0); i++) items.push({ size: t.codigo });
    for (let i = 0; i < (Number(extra) || 0); i++) items.push({ size: '' });
    if (!items.length) return;

    const label = (size: string) => `
      <div class="lb">
        <div class="brand">BROBOND</div>
        <div class="name">${esc(produto.nome || '')}</div>
        <div class="meta">${esc(produto.sku || '')}${cor ? ' · ' + esc(cor) : ''}${size ? ' · <b>' + esc(size) + '</b>' : ''}</div>
        <div class="bc">${svg}</div>
        ${showPrice && Number(produto.preco_venda) > 0 ? `<div class="price">${formatMoney(produto.preco_venda)}</div>` : ''}
      </div>`;

    const medidasBlock =
      showMedidas && medidas && medidas.medidas.length
        ? `<div class="medidas">
            <div class="medidas-title">Tabela de medidas — ${esc(produto.nome || '')}</div>
            <table>
              <thead><tr><th>Tamanho</th>${medidas.medidas.map((m) => `<th>${esc(m.nome)}<span class="un"> ${esc(m.unidade || '')}</span></th>`).join('')}</tr></thead>
              <tbody>${medidas.linhas
                .map(
                  (l) =>
                    `<tr><td>${esc(l.codigo)}</td>${medidas!.medidas
                      .map((m) => {
                        const v = l.valores[String(m.id)];
                        return `<td>${v === null || v === undefined ? '—' : v}</td>`;
                      })
                      .join('')}</tr>`
                )
                .join('')}</tbody>
            </table>
            ${medidas.instrucoes ? `<div class="medidas-nota">${esc(medidas.instrucoes)}</div>` : ''}
            ${medidas.atualizada_em ? `<div class="medidas-data">Atualizada em ${esc(dataCurta(medidas.atualizada_em))}</div>` : ''}
          </div>`
        : '';

    const css =
      mode === 'a4'
        ? `@page{size:A4;margin:8mm 6mm}
           body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}
           .sheet{display:grid;grid-template-columns:repeat(3,1fr);gap:0 3mm}
           .lb{height:33.9mm;box-sizing:border-box;padding:2mm 3mm;border:0.2mm dashed #bbb;display:flex;flex-direction:column;justify-content:space-between;page-break-inside:avoid;overflow:hidden}
           .brand{font-size:8pt;font-weight:800;letter-spacing:2px}
           .name{font-size:9pt;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
           .meta{font-size:7.5pt;color:#333}
           .bc svg{width:100%;height:auto;max-height:13mm}
           .price{font-size:11pt;font-weight:800;text-align:right}
           .medidas{grid-column:1/-1;margin-top:3mm;page-break-inside:avoid;border:0.2mm dashed #bbb;padding:3mm}
           .medidas-title{font-size:9pt;font-weight:800;letter-spacing:.5px;margin-bottom:2mm}
           .medidas table{width:100%;border-collapse:collapse;font-size:8pt}
           .medidas th,.medidas td{border:0.2mm solid #999;padding:1mm 2mm;text-align:center}
           .medidas th{background:#eee;font-weight:700}
           .medidas td:first-child,.medidas th:first-child{font-weight:700;text-align:left}
           .medidas .un{font-weight:400;font-size:6.5pt;color:#666}
           .medidas-nota{font-size:7pt;color:#333;margin-top:2mm}
           .medidas-data{font-size:6.5pt;color:#888;margin-top:1mm}`
        : `@page{size:50mm 30mm;margin:0}
           body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}
           .sheet{display:block}
           .lb{width:50mm;height:30mm;box-sizing:border-box;padding:1.5mm 2.5mm;display:flex;flex-direction:column;justify-content:space-between;page-break-after:always;overflow:hidden}
           .brand{font-size:6.5pt;font-weight:800;letter-spacing:1.5px}
           .name{font-size:7.5pt;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
           .meta{font-size:6.5pt;color:#333}
           .bc svg{width:100%;height:auto;max-height:11mm}
           .price{font-size:9pt;font-weight:800;text-align:right}`;

    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Etiquetas — ${esc(produto.sku || '')}</title><style>${css}</style></head>
      <body><div class="sheet">${items.map((i) => label(i.size)).join('')}${medidasBlock}</div></body></html>`;

    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site.');
    w.document.open();
    w.document.write(html);
    w.document.close();
    // O gatilho de impressão vem da janela pai: um <script> inline dentro do
    // documento impresso seria bloqueado pela CSP do app.
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch {
        /* a janela foi fechada antes de imprimir */
      }
    }, 250);
    void kind;
    void user;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Imprimir etiquetas"
      subtitle={`${produto.sku} — ${produto.nome}`}
      size="md"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn-primary" onClick={() => void print()} disabled={enviandoFila || total === 0 || !code || ((mode === 'zpl' || mode === 'epl2') && total > 500)}>
            <Printer className="h-4 w-4" />{' '}
            {enviandoFila
              ? 'Enfileirando...'
              : `${mode === 'zpl' || mode === 'epl2' ? 'Enviar para fila' : 'Imprimir'} ${total} etiqueta${total === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="text-xs text-slate-500">Código que sairá na etiqueta</div>
          <div className="mt-1 flex items-center justify-between gap-3">
            <span className="font-mono font-bold text-navy-900">{code || '—'}</span>
            <span className="text-xs text-slate-500">{produto.codigo_barras ? barcodeSvg(code).kind : 'Code 128 (SKU interno)'}</span>
          </div>
          {code && <div className="mt-2 max-w-[220px] [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: barcodeSvg(code, { height: 28 }).svg }} />}
        </div>

        <div>
          <div className="label">Quantidade por tamanho</div>
          {tamanhos.length === 0 && <p className="text-xs text-slate-400">Este produto ainda não tem saldo por tamanho. Use o campo "sem tamanho" abaixo.</p>}
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {tamanhos.map((t) => (
              <label key={t.id} className="block">
                <span className="mb-0.5 block text-center text-xs font-bold text-slate-600">{t.codigo}</span>
                <input type="number" min={0} max={999} className="input text-center" value={qtd[t.id] ?? 0} onChange={(e) => setQtd((q) => ({ ...q, [t.id]: Math.max(0, Number(e.target.value) || 0) }))} />
              </label>
            ))}
            <label className="block">
              <span className="mb-0.5 block text-center text-xs font-bold text-slate-600">sem tam.</span>
              <input type="number" min={0} max={999} className="input text-center" value={extra} onChange={(e) => setExtra(Math.max(0, Number(e.target.value) || 0))} />
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="label">Formato / Destino</span>
            <select
              className="input"
              value={mode}
              onChange={(e) => {
                setMode(e.target.value as 'a4' | 'roll' | 'zpl' | 'epl2');
                setIdemKey(novaChaveIdempotencia());
              }}
            >
              <option value="a4">Folha A4 — 3 colunas (Pimaco A4263 / 6182)</option>
              <option value="roll">Bobina 50 × 30 mm (Navegador)</option>
              <option value="zpl">Térmica ZPL II — Fila do Agente (Zebra)</option>
              <option value="epl2">Térmica EPL2 — Fila do Agente (Elgin / TLP)</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
            <span className="text-sm text-slate-700">Mostrar preço de venda</span>
          </label>
        </div>

        {(mode === 'zpl' || mode === 'epl2') && (
          <div className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3">
            <label className="block">
              <span className="label text-xs">Tamanho da etiqueta</span>
              <select className="input text-xs" value={labelDims} onChange={(e) => setLabelDims(e.target.value as any)}>
                <option value="50x30">50 × 30 mm</option>
                <option value="40x25">40 × 25 mm</option>
                <option value="60x40">60 × 40 mm</option>
                <option value="100x50">100 × 50 mm</option>
              </select>
            </label>
            <label className="block">
              <span className="label text-xs">Resolução</span>
              <select className="input text-xs" value={dpi} onChange={(e) => setDpi(Number(e.target.value) as 203 | 300)}>
                <option value={203}>203 dpi (8 dots/mm)</option>
                <option value={300}>300 dpi (12 dots/mm)</option>
              </select>
            </label>
            <label className="block">
              <span className="label text-xs">Terminal</span>
              <select className="input text-xs" value={terminal} onChange={(e) => setTerminal(e.target.value)}>
                <option value="">Padrão da empresa</option>
                {terminais.map((t) => (
                  <option key={t.id} value={t.codigo}>
                    {t.codigo} ({t.nome})
                  </option>
                ))}
              </select>
            </label>
            {total > 500 && (
              <p className="col-span-full text-xs text-red-600">
                Limite de segurança por lote térmico: máximo de 500 etiquetas por envio (atual: {total}).
              </p>
            )}
          </div>
        )}

        {medidas && medidas.medidas.length > 0 && (
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={showMedidas} onChange={(e) => setShowMedidas(e.target.checked)} />
            <span className="text-sm text-slate-700">Incluir tabela de medidas (na folha A4)</span>
          </label>
        )}
        <p className="text-xs text-slate-400">Uma nova aba será aberta com as etiquetas e a caixa de impressão do navegador. Na impressão, desative "ajustar à página" e as margens extras.</p>
      </div>
    </Modal>
  );
}

function esc(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
}
