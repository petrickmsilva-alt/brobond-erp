import { useMemo, useState } from 'react';
import { Printer } from 'lucide-react';
import { barcodeSvg } from '../lib/barcode';
import { formatMoney } from '../lib/format';
import { Modal } from './ui';

type Tam = { id: number; codigo: string };
type Grade = { local: string; celulas: { tamanho_id: number; quantidade: number }[] }[];
type Medidas = { medidas: { id: number; nome: string; unidade: string }[]; linhas: { tamanho_id: number; codigo: string; valores: Record<string, number | null> }[] } | null;

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
  const [mode, setMode] = useState<'a4' | 'roll'>('a4');
  const [showPrice, setShowPrice] = useState(true);
  const [showMedidas, setShowMedidas] = useState(false);
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

  function print() {
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
              <thead><tr><th>Tamanho</th>${medidas.medidas.map((m) => `<th>${esc(m.nome)}</th>`).join('')}</tr></thead>
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
           .medidas td:first-child,.medidas th:first-child{font-weight:700;text-align:left}`
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
      <body><div class="sheet">${items.map((i) => label(i.size)).join('')}${medidasBlock}</div>
      <script>window.onload=function(){setTimeout(function(){window.print()},150)}</script></body></html>`;

    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) return alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site.');
    w.document.open();
    w.document.write(html);
    w.document.close();
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
          <button className="btn-primary" onClick={print} disabled={total === 0 || !code}>
            <Printer className="h-4 w-4" /> Imprimir {total} etiqueta{total === 1 ? '' : 's'}
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
            <span className="label">Formato</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as 'a4' | 'roll')}>
              <option value="a4">Folha A4 — 3 colunas (Pimaco A4263 / 6182)</option>
              <option value="roll">Bobina térmica 50 × 30 mm</option>
            </select>
          </label>
          <label className="flex items-end gap-2 pb-2">
            <input type="checkbox" className="h-4 w-4 rounded border-slate-300" checked={showPrice} onChange={(e) => setShowPrice(e.target.checked)} />
            <span className="text-sm text-slate-700">Mostrar preço de venda</span>
          </label>
        </div>

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
