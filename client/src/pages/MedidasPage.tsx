import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle, ClipboardCopy, Copy, Info, Loader2, Plus, Printer, Ruler, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import { Alert, Badge, ConfirmDialog, Modal, PageHeader, Spinner, useToast } from '../components/ui';

type Tamanho = { id: number; codigo: string };
type Valor = { id: number; medida_id: number; tamanho_id: number; valor: number | null };
type GradeMedidas = {
  grade: { id: number; nome: string; instrucoes_medidas: string | null };
  medidas: { id: number; nome: string; unidade: string; ordem: number }[];
  tamanhos: Tamanho[];
  valores: Valor[];
  resumo: { celulas_total: number; celulas_preenchidas: number; pct: number; atualizada_em: string | null };
};
type ResumoGrade = {
  id: number;
  nome: string;
  ativo: boolean;
  tamanhos: number;
  colunas: number;
  celulas_total: number;
  celulas_preenchidas: number;
  pct: number;
  atualizada_em: string | null;
};
type Col = { nome: string; unidade: string };

const UNIDADES = [
  { value: 'cm', label: 'cm' },
  { value: 'mm', label: 'mm' },
  { value: 'pol', label: 'pol' },
];

/** Mesmos limites da API (server/src/medidas.ts) — feedback local antes do envio. */
const LIMITE_POR_UNIDADE: Record<string, number> = { cm: 300, mm: 3000, pol: 150 };

/** Modelos profissionais por tipo de peça — colunas padrão que o setor usa o tempo todo. */
const MODELOS: { label: string; colunas: string[] }[] = [
  { label: 'Camiseta / Regata', colunas: ['Largura (A)', 'Comprimento (B)', 'Manga (C)', 'Ombro (D)'] },
  { label: 'Camisa / Social', colunas: ['Largura (A)', 'Comprimento (B)', 'Manga (C)', 'Ombro (D)'] },
  { label: 'Calça', colunas: ['Cintura (A)', 'Quadril (B)', 'Coxa (C)', 'Entrepernas (D)', 'Comprimento (E)'] },
  { label: 'Bermuda / Shorts', colunas: ['Cintura (A)', 'Quadril (B)', 'Coxa (C)', 'Comprimento (D)'] },
  { label: 'Agasalho / Moletom', colunas: ['Largura (A)', 'Comprimento (B)', 'Manga (C)', 'Ombro (D)'] },
  { label: 'Calçado', colunas: ['Comprimento do pé (A)', 'Largura do pé (B)'] },
];

function parseCelula(raw: string): number | null {
  const t = raw.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function celulaInvalida(col: Col, raw: string): boolean {
  const n = parseCelula(raw);
  if (n === null) return false;
  const lim = LIMITE_POR_UNIDADE[col.unidade] ?? LIMITE_POR_UNIDADE.cm;
  return Number.isNaN(n) || n <= 0 || n > lim;
}

export default function MedidasPage() {
  const toast = useToast();

  // Painel de completude (todas as grades)
  const [resumoGrades, setResumoGrades] = useState<ResumoGrade[]>([]);
  const [resumoLoading, setResumoLoading] = useState(true);

  // Grade selecionada
  const [gradeId, setGradeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [gradeNome, setGradeNome] = useState('');
  const [tamanhos, setTamanhos] = useState<Tamanho[]>([]);
  const [cols, setCols] = useState<Col[]>([]);
  const [val, setVal] = useState<Record<string, string>>({});
  const [instrucoes, setInstrucoes] = useState('');
  const [instrucoesSuja, setInstrucoesSuja] = useState(false);
  const [salvandoInstrucoes, setSalvandoInstrucoes] = useState(false);
  const [atualizadaEm, setAtualizadaEm] = useState<string | null>(null);

  // Alterações não salvas
  const [sujo, setSujo] = useState(false);

  // Diálogos
  const [colunaParaRemover, setColunaParaRemover] = useState<number | null>(null);
  const [modalCopiar, setModalCopiar] = useState(false);
  const [copiarDe, setCopiarDe] = useState('');
  const [gradeParaTrocar, setGradeParaTrocar] = useState<string | null>(null);
  const [confirmarSubstituirCopia, setConfirmarSubstituirCopia] = useState(false);

  const carregarResumo = useCallback(async () => {
    try {
      const d = await api.get<{ total: number; grades: ResumoGrade[] }>('/grades/medidas-resumo');
      setResumoGrades(d.grades);
    } catch {
      setResumoGrades([]);
    } finally {
      setResumoLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarResumo();
  }, [carregarResumo]);

  const load = useCallback(async (id: string) => {
    if (!id) {
      setTamanhos([]);
      setCols([]);
      setVal({});
      setGradeNome('');
      setInstrucoes('');
      setAtualizadaEm(null);
      setSujo(false);
      setInstrucoesSuja(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const d = await api.get<GradeMedidas>(`/grades/${id}/medidas`);
      setGradeNome(d.grade.nome);
      setTamanhos(d.tamanhos);
      const cs = d.medidas.map((m) => ({ nome: m.nome, unidade: m.unidade || 'cm' }));
      setCols(cs.length ? cs : [{ nome: '', unidade: 'cm' }]);
      const idxPorMedida = new Map(d.medidas.map((m, i) => [m.id, i]));
      const v: Record<string, string> = {};
      for (const vv of d.valores) {
        const i = idxPorMedida.get(vv.medida_id);
        if (i === undefined) continue;
        v[`${i}:${vv.tamanho_id}`] = vv.valor === null || vv.valor === undefined ? '' : String(vv.valor).replace('.', ',');
      }
      setVal(v);
      setInstrucoes(d.grade.instrucoes_medidas || '');
      setAtualizadaEm(d.resumo.atualizada_em);
      setSujo(false);
      setInstrucoesSuja(false);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a tabela de medidas.');
    } finally {
      setLoading(false);
    }
  }, []);

  function selecionarGrade(id: string) {
    if (id === gradeId) return;
    if (sujo || instrucoesSuja) {
      setGradeParaTrocar(id);
      return;
    }
    setGradeId(id);
    load(id);
  }

  function confirmarTrocaGrade() {
    if (gradeParaTrocar === null) return;
    setGradeId(gradeParaTrocar);
    load(gradeParaTrocar);
    setGradeParaTrocar(null);
  }

  // Aviso no navegador ao fechar/re carregar com alterações pendentes
  useEffect(() => {
    if (!sujo && !instrucoesSuja) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [sujo, instrucoesSuja]);

  function setCell(i: number, tamanhoId: number, raw: string) {
    setVal((v) => ({ ...v, [`${i}:${tamanhoId}`]: raw }));
    setSujo(true);
  }

  function setCol(i: number, patch: Partial<Col>) {
    setCols((c) => c.map((col, idx) => (idx === i ? { ...col, ...patch } : col)));
    setSujo(true);
  }

  function addCol() {
    setCols((c) => [...c, { nome: '', unidade: 'cm' }]);
    setSujo(true);
  }

  function removeCol(i: number) {
    setCols((c) => c.filter((_, idx) => idx !== i));
    setVal((v) => {
      const out: Record<string, string> = {};
      for (const [k, value] of Object.entries(v)) {
        const [ci, rest] = k.split(':');
        const idx = Number(ci);
        if (idx === i) continue;
        out[`${idx > i ? idx - 1 : idx}:${rest}`] = value;
      }
      return out;
    });
    setSujo(true);
  }

  const tabelaVazia = cols.every((c) => !c.nome.trim()) && Object.values(val).every((v) => !v.trim());
  const celulasInvalidas = useMemo(
    () => cols.reduce((acc, c, i) => acc + tamanhos.filter((t) => celulaInvalida(c, val[`${i}:${t.id}`] ?? '')).length, 0),
    [cols, tamanhos, val]
  );
  const preenchidas = useMemo(() => Object.values(val).filter((v) => v.trim() !== '').length, [val]);
  const celulasTotal = cols.filter((c) => c.nome.trim()).length * tamanhos.length;
  const faltando = Math.max(0, celulasTotal - preenchidas);

  async function salvarInstrucoes() {
    if (!gradeId) return;
    setSalvandoInstrucoes(true);
    setError('');
    try {
      await api.put(`/grades/${gradeId}`, { instrucoes_medidas: instrucoes.trim() || null });
      toast.success('Instruções de medição salvas.');
      setInstrucoesSuja(false);
    } catch (e: any) {
      setError(e.message || 'Não foi possível salvar as instruções.');
      toast.error(e.message || 'Não foi possível salvar as instruções.');
    } finally {
      setSalvandoInstrucoes(false);
    }
  }

  function aplicarModelo(idx: number) {
    const modelo = MODELOS[idx];
    if (!modelo) return;
    setCols(modelo.colunas.map((n) => ({ nome: n, unidade: 'cm' })));
    setVal({});
    setSujo(true);
    toast.success(`Modelo "${modelo.label}" aplicado — preencha os valores e salve.`);
  }

  function copiarDeGrade() {
    const src = Number(copiarDe);
    if (!src) return;
    const temConteudo = cols.some((c) => c.nome.trim()) || Object.values(val).some((v) => v.trim() !== '');
    if (temConteudo) {
      setConfirmarSubstituirCopia(true);
      return;
    }
    executarCopiaDeGrade();
  }

  async function executarCopiaDeGrade() {
    const src = Number(copiarDe);
    if (!src) return;
    try {
      const d = await api.get<GradeMedidas>(`/grades/${src}/medidas`);
      const cs = d.medidas.map((m) => ({ nome: m.nome, unidade: m.unidade || 'cm' }));
      setCols(cs.length ? cs : [{ nome: '', unidade: 'cm' }]);
      const idxPorMedida = new Map(d.medidas.map((m, i) => [m.id, i]));
      const v: Record<string, string> = {};
      for (const vv of d.valores) {
        const i = idxPorMedida.get(vv.medida_id);
        if (i === undefined) continue;
        v[`${i}:${vv.tamanho_id}`] = vv.valor === null || vv.valor === undefined ? '' : String(vv.valor).replace('.', ',');
      }
      setVal(v);
      setInstrucoes(d.grade.instrucoes_medidas || '');
      setInstrucoesSuja(true);
      setSujo(true);
      setModalCopiar(false);
      setCopiarDe('');
      setConfirmarSubstituirCopia(false);
      toast.success(`Tabela de "${d.grade.nome}" carregada — revise e clique em Salvar.`);
    } catch (e: any) {
      toast.error(e.message || 'Não foi possível carregar a tabela da grade.');
    }
  }

  // Colunas com nome, com o índice real no array `cols` (a célula usa esse índice).
  const colsValidas = useMemo(() => cols.map((c, idx) => ({ c, idx })).filter((x) => x.c.nome.trim()), [cols]);

  function textoDaTabela(): string {
    const linhas = [
      `TABELA DE MEDIDAS — ${gradeNome}`,
      ['Tamanho', ...colsValidas.map((x) => `${x.c.nome} (${x.c.unidade})`)].join('\t'),
      ...tamanhos.map((t) =>
        [
          t.codigo,
          ...colsValidas.map((x) => {
            const n = parseCelula(val[`${x.idx}:${t.id}`] ?? '');
            return n === null || Number.isNaN(n) ? '—' : formatNumber(n);
          }),
        ].join('\t')
      ),
    ];
    if (instrucoes.trim()) linhas.push('', `Como medir: ${instrucoes.trim()}`);
    if (atualizadaEm) linhas.push(`Tabela atualizada em ${formatDateTime(atualizadaEm)}.`);
    return linhas.join('\n');
  }

  async function copiarTexto() {
    try {
      await navigator.clipboard.writeText(textoDaTabela());
      toast.success('Tabela copiada — cole no WhatsApp, e-mail ou atendimento.');
    } catch {
      toast.error('O navegador bloqueou a cópia. Selecione e copie manualmente.');
    }
  }

  function imprimir() {
    if (!colsValidas.length) return toast.error('Adicione ao menos uma coluna com nome para imprimir.');
    const linhasHtml = tamanhos
      .map((t) => {
        const cels = colsValidas
          .map((x) => {
            const n = parseCelula(val[`${x.idx}:${t.id}`] ?? '');
            return `<td>${n === null || Number.isNaN(n) ? '—' : formatNumber(n)}</td>`;
          })
          .join('');
        return `<tr><td>${t.codigo}</td>${cels}</tr>`;
      })
      .join('');
    const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Tabela de medidas — ${gradeNome}</title>
<style>
  @page { size: A4; margin: 16mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
  h1 { font-size: 20pt; margin: 0; }
  .sub { color: #475569; font-size: 10pt; margin-top: 2mm; }
  table { width: 100%; border-collapse: collapse; margin-top: 6mm; font-size: 10.5pt; }
  th, td { border: 1px solid #cbd5e1; padding: 2.5mm 3mm; text-align: center; }
  th { background: #f1f5f9; }
  td:first-child, th:first-child { text-align: left; font-weight: 700; }
  .un { font-weight: 400; font-size: 8pt; color: #64748b; }
  .instr { margin-top: 6mm; font-size: 9.5pt; color: #334155; background: #f8fafc; border: 1px dashed #cbd5e1; padding: 4mm; }
  .foot { margin-top: 8mm; font-size: 8pt; color: #94a3b8; }
</style></head><body>
  <h1>Tabela de Medidas</h1>
  <div class="sub">BROBOND · ${gradeNome} · ${tamanhos.length} tamanhos</div>
  <table>
    <thead><tr><th>Tamanho</th>${colsValidas.map((x) => `<th>${x.c.nome}<br><span class="un">${x.c.unidade}</span></th>`).join('')}</tr></thead>
    <tbody>${linhasHtml}</tbody>
  </table>
  ${instrucoes.trim() ? `<div class="instr"><b>Como medir:</b> ${instrucoes.trim()}</div>` : ''}
  <div class="foot">${atualizadaEm ? `Tabela atualizada em ${formatDateTime(atualizadaEm)}.` : 'Tabela ainda sem valores registrados.'} Valores medidos na peça em repouso.</div>
</body></html>`;
    const w = window.open('', '_blank', 'width=860,height=1000');
    if (!w) return alert('O navegador bloqueou a janela de impressão. Permita pop-ups para este site.');
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => {
      try {
        w.focus();
        w.print();
      } catch {
        /* a janela foi fechada antes de imprimir */
      }
    }, 250);
  }

  async function save() {
    if (!gradeId) return;
    if (celulasInvalidas > 0) {
      const msg = `Corrija ${celulasInvalidas} célula(s) inválida(s) — valor deve ser numérico, maior que 0 e dentro do limite da unidade (cm até 300, mm até 3000, pol até 150).`;
      setError(msg);
      toast.error(msg);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const medidas = cols.filter((c) => c.nome.trim()).map((c) => ({ nome: c.nome.trim(), unidade: c.unidade }));
      const valores = Object.entries(val)
        .filter(([, v]) => v.trim() !== '')
        .map(([k, v]) => {
          const [ci, tid] = k.split(':');
          const nome = cols[Number(ci)]?.nome.trim() ?? '';
          return { medida_nome: nome, tamanho_id: Number(tid), valor: v };
        })
        .filter((v) => v.medida_nome);
      await api.put(`/grades/${gradeId}/medidas`, { medidas, valores });
      toast.success('Tabela de medidas salva.');
      await load(gradeId);
      carregarResumo();
    } catch (e: any) {
      setError(e.message || 'Não foi possível salvar.');
      toast.error(e.message || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  const podeImprimir = cols.some((c) => c.nome.trim()) && tamanhos.length > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <Ruler className="h-5 w-5" />
            </span>
            Tabela de Medidas
          </span>
        }
        description="Cadastre as medidas (largura, comprimento, manga, cintura...) de cada grade, por tamanho — com instruções de medição que o cliente vê no catálogo público, etiquetas e impressão."
      />

      {/* Painel de completude: todas as grades num único olhar */}
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-navy-900">Situação das grades</h2>
            <p className="text-xs text-slate-400">Clique em uma grade para editar a tabela.</p>
          </div>
          {resumoGrades.length > 0 && (
            <p className="text-xs text-slate-400">
              {resumoGrades.filter((g) => g.colunas > 0 && g.pct === 100).length} de {resumoGrades.length} completas
            </p>
          )}
        </div>
        {resumoLoading ? (
          <div className="flex justify-center p-8">
            <Spinner />
          </div>
        ) : resumoGrades.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">
            Nenhuma grade cadastrada. Crie em{' '}
            <Link to="/grades" className="font-medium text-brand-700 hover:underline">
              Grades
            </Link>{' '}
            para montar as tabelas de medidas.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table text-sm">
              <thead>
                <tr>
                  <th className="text-left">Grade</th>
                  <th>Tamanhos</th>
                  <th>Colunas</th>
                  <th className="min-w-[160px] text-left">Preenchimento</th>
                  <th>Status</th>
                  <th>Atualizada em</th>
                </tr>
              </thead>
              <tbody>
                {resumoGrades.map((g) => {
                  const status =
                    g.colunas === 0 ? (
                      <Badge tone="slate">Sem tabela</Badge>
                    ) : g.tamanhos === 0 ? (
                      <Badge tone="slate">Sem tamanhos</Badge>
                    ) : g.pct === 100 ? (
                      <Badge tone="green">
                        <CheckCircle className="mr-1 inline h-3 w-3" /> Completa
                      </Badge>
                    ) : (
                      <Badge tone="amber">Parcial · {g.pct}%</Badge>
                    );
                  return (
                    <tr
                      key={g.id}
                      onClick={() => selecionarGrade(String(g.id))}
                      className={`cursor-pointer transition-colors hover:bg-navy-50/40 ${String(g.id) === gradeId ? 'bg-navy-50/60' : ''}`}
                    >
                      <td className="font-semibold text-navy-900">
                        {g.nome}
                        {g.ativo === false && <span className="ml-2 text-[11px] font-normal text-slate-400">(inativa)</span>}
                      </td>
                      <td className="text-center tabular-nums">{g.tamanhos}</td>
                      <td className="text-center tabular-nums">{g.colunas}</td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={`h-full rounded-full ${g.pct === 100 ? 'bg-emerald-500' : 'bg-brand-500'}`}
                              style={{ width: `${g.pct}%` }}
                            />
                          </div>
                          <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">
                            {g.celulas_preenchidas}/{g.celulas_total}
                          </span>
                        </div>
                      </td>
                      <td className="text-center">{status}</td>
                      <td className="whitespace-nowrap text-center text-xs text-slate-500">
                        {g.atualizada_em ? formatDateTime(g.atualizada_em) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Seletor + ações da grade */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="block">
            <span className="label">Grade</span>
            <select className="input min-w-[240px]" value={gradeId} onChange={(e) => selecionarGrade(e.target.value)}>
              <option value="">Selecione uma grade...</option>
              {resumoGrades.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome}
                </option>
              ))}
            </select>
          </label>
          {tabelaVazia && gradeId && (
            <label className="block">
              <span className="label">Usar modelo (colunas padrão)</span>
              <select className="input min-w-[190px]" value="" onChange={(e) => e.target.value && aplicarModelo(Number(e.target.value))}>
                <option value="">Escolher modelo...</option>
                {MODELOS.map((m, i) => (
                  <option key={m.label} value={i}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {gradeId && (
            <div className="flex flex-wrap items-end gap-2">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setModalCopiar(true)}
                disabled={!resumoGrades.some((g) => g.id !== Number(gradeId) && g.colunas > 0)}
              >
                <ClipboardCopy className="h-4 w-4" /> Copiar de outra grade
              </button>
              <button type="button" className="btn-secondary" onClick={imprimir} disabled={!podeImprimir}>
                <Printer className="h-4 w-4" /> Imprimir
              </button>
              <button type="button" className="btn-secondary" onClick={copiarTexto} disabled={tabelaVazia}>
                <Copy className="h-4 w-4" /> Copiar texto
              </button>
            </div>
          )}
          {!gradeId && (
            <p className="text-sm text-slate-400">
              Escolha uma grade acima para montar a tabela. Precisa de nova grade? Cadastre em{' '}
              <Link to="/grades" className="font-medium text-brand-700 hover:underline">
                Grades
              </Link>
              .
            </p>
          )}
        </div>
      </div>

      {gradeId && (
        <div className="card overflow-hidden">
          {loading ? (
            <div className="flex justify-center p-10">
              <Spinner />
            </div>
          ) : tamanhos.length === 0 ? (
            <p className="p-10 text-center text-sm text-slate-400">
              Esta grade ainda não tem tamanhos. Adicione os tamanhos em{' '}
              <Link to="/grades" className="font-medium text-brand-700 hover:underline">
                Grades
              </Link>
              .
            </p>
          ) : (
            <>
              {/* Barra de status da tabela */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5">
                <div className="flex min-w-[220px] flex-1 items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-200/70">
                    <div
                      className={`h-full rounded-full transition-all ${celulasTotal > 0 && preenchidas === celulasTotal ? 'bg-emerald-500' : 'bg-brand-500'}`}
                      style={{ width: `${celulasTotal ? Math.min(100, Math.round((preenchidas / celulasTotal) * 100)) : 0}%` }}
                    />
                  </div>
                  <span className="whitespace-nowrap text-xs tabular-nums text-slate-500">
                    {celulasTotal === 0 ? 'sem colunas nomeadas' : `${preenchidas} de ${celulasTotal} células`}
                  </span>
                </div>
                {celulasTotal > 0 && preenchidas === celulasTotal && (
                  <span className="flex items-center gap-1 text-xs font-medium text-emerald-600">
                    <CheckCircle className="h-3.5 w-3.5" /> Tabela completa
                  </span>
                )}
                {celulasInvalidas > 0 && (
                  <span className="flex items-center gap-1 text-xs font-semibold text-red-600">
                    <Info className="h-3.5 w-3.5" /> {celulasInvalidas} célula(s) inválida(s)
                  </span>
                )}
                {sujo && (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-brand-700">
                    <span className="h-2 w-2 rounded-full bg-brand-500" /> Alterações não salvas
                  </span>
                )}
                <span className="ml-auto whitespace-nowrap text-xs text-slate-400">
                  {atualizadaEm ? `Atualizada em ${formatDateTime(atualizadaEm)}` : 'Ainda sem valores registrados'}
                </span>
              </div>

              <div className="overflow-x-auto">
                <table className="table text-sm">
                  <thead>
                    <tr>
                      <th className="sticky left-0 bg-white text-left">Tamanho</th>
                      {cols.map((c, i) => (
                        <th key={i} className="min-w-[150px] align-top">
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center gap-1">
                              <input
                                className="input !py-1 text-xs font-semibold"
                                value={c.nome}
                                placeholder="Ex.: Largura (A)"
                                onChange={(e) => setCol(i, { nome: e.target.value })}
                              />
                              <button
                                type="button"
                                className="btn-icon !p-1 text-red-400 hover:text-red-600"
                                title="Remover coluna"
                                onClick={() => {
                                  const temValor = tamanhos.some((t) => (val[`${i}:${t.id}`] ?? '').trim() !== '');
                                  setColunaParaRemover(temValor ? i : null);
                                  if (!temValor) removeCol(i);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <select
                              className="input !py-1 text-xs"
                              value={c.unidade}
                              onChange={(e) => setCol(i, { unidade: e.target.value })}
                            >
                              {UNIDADES.map((u) => (
                                <option key={u.value} value={u.value}>
                                  {u.label}
                                </option>
                              ))}
                            </select>
                          </div>
                        </th>
                      ))}
                      <th className="align-top">
                        <button type="button" className="btn-secondary !py-1.5 text-xs" onClick={addCol}>
                          <Plus className="h-3.5 w-3.5" /> Coluna
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {tamanhos.map((t) => (
                      <tr key={t.id}>
                        <td className="sticky left-0 bg-white font-semibold text-navy-900">{t.codigo}</td>
                        {cols.map((c, i) => {
                          const invalida = celulaInvalida(c, val[`${i}:${t.id}`] ?? '');
                          return (
                            <td key={i} className="text-center">
                              <input
                                type="text"
                                inputMode="decimal"
                                className={`input !py-1 text-center tabular-nums ${invalida ? '!border-red-400 !ring-2 !ring-red-100' : ''}`}
                                title={
                                  invalida
                                    ? `Valor inválido: use um número maior que 0 e até ${LIMITE_POR_UNIDADE[c.unidade] ?? 300} ${c.unidade}`
                                    : undefined
                                }
                                value={val[`${i}:${t.id}`] ?? ''}
                                placeholder="—"
                                onChange={(e) => setCell(i, t.id, e.target.value)}
                              />
                            </td>
                          );
                        })}
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Instruções para o cliente */}
              <div className="border-t border-slate-200 bg-slate-50/50 px-4 py-3">
                <label className="block">
                  <span className="label flex items-center gap-1.5">
                    <Info className="h-3.5 w-3.5 text-slate-400" /> Instruções de medição — visível ao cliente no catálogo, etiquetas e
                    impressão
                  </span>
                  <textarea
                    className="input mt-1"
                    rows={2}
                    maxLength={600}
                    placeholder="Ex.: Meça a peça sobre uma superfície plana, sem esticar. Tolerância de ±1 cm. Medidas em cm."
                    value={instrucoes}
                    onChange={(e) => {
                      setInstrucoes(e.target.value);
                      setInstrucoesSuja(true);
                    }}
                  />
                </label>
                <div className="mt-2 flex items-center justify-end">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={salvarInstrucoes}
                    disabled={!instrucoesSuja || salvandoInstrucoes}
                  >
                    {salvandoInstrucoes ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar instruções
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                {error ? (
                  <Alert tone="red">{error}</Alert>
                ) : faltando > 0 ? (
                  <p className="text-xs text-slate-400">
                    Faltam {faltando} célula(s) para completar a tabela — células em branco aparecem como "—" para o cliente.
                  </p>
                ) : (
                  <p className="text-xs text-slate-400">Deixe a célula em branco para remover o valor.</p>
                )}
                <button className="btn-primary" onClick={save} disabled={saving || celulasInvalidas > 0}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar tabela
                  {sujo && !saving && <span className="ml-2 h-2 w-2 rounded-full bg-amber-400" title="Alterações não salvas" />}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Confirmação: trocar de grade com alterações não salvas */}
      <ConfirmDialog
        open={gradeParaTrocar !== null}
        title="Sair sem salvar?"
        message="Há alterações não salvas nesta grade. Sair sem salvar descarta o que foi digitado."
        confirmLabel="Sair sem salvar"
        danger
        onConfirm={confirmarTrocaGrade}
        onCancel={() => setGradeParaTrocar(null)}
      />

      {/* Confirmação: substituir tabela atual ao copiar de outra grade */}
      <ConfirmDialog
        open={confirmarSubstituirCopia}
        title="Substituir tabela atual"
        message="Substituir a tabela atual de medidas pela de outra grade? Nada é gravado até você clicar em Salvar tabela."
        confirmLabel="Substituir"
        danger
        onConfirm={executarCopiaDeGrade}
        onCancel={() => setConfirmarSubstituirCopia(false)}
      />

      {/* Confirmação: remover coluna com valores */}
      <ConfirmDialog
        open={colunaParaRemover !== null}
        title="Remover coluna"
        message={
          <>
            A coluna <b>{colunaParaRemover !== null ? cols[colunaParaRemover]?.nome || '(sem nome)' : ''}</b> tem valores preenchidos.
            Remover a coluna apaga esses valores da tabela. Deseja continuar?
          </>
        }
        confirmLabel="Remover coluna"
        danger
        onConfirm={() => {
          if (colunaParaRemover !== null) removeCol(colunaParaRemover);
          setColunaParaRemover(null);
        }}
        onCancel={() => setColunaParaRemover(null)}
      />

      {/* Copiar de outra grade */}
      <Modal
        open={modalCopiar}
        onClose={() => setModalCopiar(false)}
        title="Copiar tabela de outra grade"
        subtitle="Útil quando o modelo é o mesmo e você está montando a grade de uma peça nova."
        size="sm"
        footer={
          <>
            <button className="btn-secondary" onClick={() => setModalCopiar(false)}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={copiarDeGrade} disabled={!copiarDe}>
              <ClipboardCopy className="h-4 w-4" /> Carregar tabela
            </button>
          </>
        }
      >
        <label className="block">
          <span className="label">Grade de origem</span>
          <select className="input" value={copiarDe} onChange={(e) => setCopiarDe(e.target.value)}>
            <option value="">Escolher grade...</option>
            {resumoGrades
              .filter((g) => g.id !== Number(gradeId) && g.colunas > 0)
              .map((g) => (
                <option key={g.id} value={g.id}>
                  {g.nome} · {g.celulas_preenchidas}/{g.celulas_total} medidas
                </option>
              ))}
          </select>
          <span className="mt-1.5 block text-xs text-slate-400">
            A tabela da grade selecionada (colunas, valores e instruções) substitui a atual. Nada é gravado até você clicar em “Salvar
            tabela”.
          </span>
        </label>
      </Modal>
    </div>
  );
}
