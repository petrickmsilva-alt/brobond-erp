import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Plus, Ruler, Save, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';

type Medida = { id: number; nome: string; unidade: string; ordem: number };
type Tamanho = { id: number; codigo: string };
type Valor = { id: number; medida_id: number; tamanho_id: number; valor: number | null };
type GradeMedidas = { grade: { id: number; nome: string }; medidas: Medida[]; tamanhos: Tamanho[]; valores: Valor[] };

type Col = { nome: string; unidade: string };

const UNIDADES = [
  { value: 'cm', label: 'cm' },
  { value: 'mm', label: 'mm' },
  { value: 'pol', label: 'pol' },
];

export default function MedidasPage() {
  const toast = useToast();
  const [grades, setGrades] = useState<{ value: number; label: string }[]>([]);
  const [gradeId, setGradeId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const [gradeNome, setGradeNome] = useState('');
  const [tamanhos, setTamanhos] = useState<Tamanho[]>([]);
  const [cols, setCols] = useState<Col[]>([]);
  const [val, setVal] = useState<Record<string, string>>({});

  useEffect(() => {
    api
      .get<{ value: number; label: string }[]>('/grades/options')
      .then(setGrades)
      .catch(() => setGrades([]));
  }, []);

  const load = useCallback(async (id: string) => {
    if (!id) {
      setTamanhos([]);
      setCols([]);
      setVal({});
      setGradeNome('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const d = await api.get<GradeMedidas>(`/grades/${id}/medidas`);
      setGradeNome(d.grade.nome);
      setTamanhos(d.tamanhos);
      const cols = d.medidas.map((m) => ({ nome: m.nome, unidade: m.unidade || 'cm' }));
      setCols(cols.length ? cols : [{ nome: 'Largura (A)', unidade: 'cm' }]);
      // medida_id → índice de coluna
      const idxPorMedida = new Map(d.medidas.map((m, i) => [m.id, i]));
      const val: Record<string, string> = {};
      for (const v of d.valores) {
        const i = idxPorMedida.get(v.medida_id);
        if (i === undefined) continue;
        val[`${i}:${v.tamanho_id}`] = v.valor === null || v.valor === undefined ? '' : String(v.valor).replace('.', ',');
      }
      setVal(val);
    } catch (e: any) {
      setError(e.message || 'Erro ao carregar a tabela de medidas.');
    } finally {
      setLoading(false);
    }
  }, []);

  function setCell(i: number, tamanhoId: number, raw: string) {
    setVal((v) => ({ ...v, [`${i}:${tamanhoId}`]: raw }));
  }

  function setCol(i: number, patch: Partial<Col>) {
    setCols((c) => c.map((col, idx) => (idx === i ? { ...col, ...patch } : col)));
  }

  function addCol() {
    setCols((c) => [...c, { nome: '', unidade: 'cm' }]);
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
  }

  async function save() {
    if (!gradeId) return;
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
    } catch (e: any) {
      setError(e.message || 'Não foi possível salvar.');
      toast.error(e.message || 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

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
        description="Cadastre as medidas (largura, comprimento, manga, cintura...) de cada grade, por tamanho."
      />

      <div className="card p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="block">
            <span className="label">Grade</span>
            <select className="input min-w-[220px]" value={gradeId} onChange={(e) => { setGradeId(e.target.value); load(e.target.value); }}>
              <option value="">Selecione uma grade...</option>
              {grades.map((g) => (
                <option key={g.value} value={g.value}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
          {gradeNome && <span className="badge ml-1 !bg-navy-50 !text-navy-700">{gradeNome}</span>}
          {!gradeId && (
            <p className="text-sm text-slate-400">
              Cadastre uma grade em{' '}
              <Link to="/grades" className="font-medium text-brand-700 hover:underline">
                Grades
              </Link>{' '}
              antes de montar a tabela de medidas.
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
              Esta grade ainda não tem tamanhos. Adicione os tamanhos em <Link to="/grades" className="font-medium text-brand-700 hover:underline">Grades</Link>.
            </p>
          ) : (
            <>
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
                              <button type="button" className="btn-icon !p-1 text-red-400 hover:text-red-600" title="Remover coluna" onClick={() => removeCol(i)}>
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <select className="input !py-1 text-xs" value={c.unidade} onChange={(e) => setCol(i, { unidade: e.target.value })}>
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
                        {cols.map((c, i) => (
                          <td key={i} className="text-center">
                            <input
                              type="text"
                              inputMode="decimal"
                              className="input !py-1 text-center tabular-nums"
                              value={val[`${i}:${t.id}`] ?? ''}
                              placeholder="—"
                              onChange={(e) => setCell(i, t.id, e.target.value)}
                            />
                          </td>
                        ))}
                        <td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-4 py-3">
                {error ? <Alert tone="red">{error}</Alert> : <p className="text-xs text-slate-400">Deixe a célula em branco para remover o valor.</p>}
                <button className="btn-primary" onClick={save} disabled={saving}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Salvar tabela
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
