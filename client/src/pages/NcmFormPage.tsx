// ============================================================================
// NCM / TRIBUTAÇÃO — cadastro e edição em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: a criação (`/ncm/novo`) e a edição
// (`/ncm/:id/editar`) de uma alíquota por NCM são páginas, como qualquer outro
// cadastro do ERP. A listagem apenas navega.
//
// Nada muda na regra de negócio: o servidor continua validando a chave (dígitos
// 2..8, vazio = PADRÃO) e a alíquota (0..100). A tela NÃO calcula imposto —
// apenas cadastra a tabela que o motor de impostos consulta.
// ============================================================================
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import type { ListResult } from '../lib/meta';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

type ImpostoNcm = {
  id: number;
  ncm: string | null;
  descricao: string | null;
  aliquota_pct: number | null;
};

type Formulario = { ncm: string; descricao: string; aliquota_pct: string };

const FORM_VAZIO: Formulario = { ncm: '', descricao: '', aliquota_pct: '' };

function ehPadrao(i: ImpostoNcm): boolean {
  return i.ncm === null || i.ncm === undefined || String(i.ncm) === '';
}

export default function NcmFormPage({ modo = 'novo' }: { modo?: 'novo' | 'editar' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { id } = useParams();
  const { user } = useAuth();
  const podeEscrever = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [carregando, setCarregando] = useState(modo === 'editar');
  const [registro, setRegistro] = useState<ImpostoNcm | null>(null);
  const [form, setForm] = useState<Formulario>(FORM_VAZIO);
  const [erroCarga, setErroCarga] = useState('');
  const [erroSalvar, setErroSalvar] = useState('');
  const [campos, setCampos] = useState<Record<string, string>>({});
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (modo !== 'editar') return;
    let vivo = true;
    (async () => {
      setCarregando(true);
      setErroCarga('');
      try {
        // O recurso não tem rota GET /:id dedicada; a lista canônica é a fonte.
        const d = await api.get<ListResult<ImpostoNcm>>('/impostos_ncm?page=1&pageSize=500&sort=ncm&dir=asc');
        const achado = d.rows.find((r) => Number(r.id) === Number(id)) ?? null;
        if (!vivo) return;
        if (!achado) {
          setErroCarga('Alíquota não encontrada nesta empresa.');
          return;
        }
        setRegistro(achado);
        setForm({
          ncm: ehPadrao(achado) ? '' : String(achado.ncm),
          descricao: achado.descricao ?? '',
          aliquota_pct: achado.aliquota_pct === null || achado.aliquota_pct === undefined ? '' : String(achado.aliquota_pct),
        });
      } catch (e) {
        if (vivo) setErroCarga(e instanceof ApiError ? e.message : 'Não foi possível carregar a alíquota.');
      } finally {
        if (vivo) setCarregando(false);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [id, modo]);

  async function salvar() {
    const invalidos: Record<string, string> = {};
    const ncm = form.ncm.replace(/\D/g, '');
    if (form.ncm.trim() !== '' && !/^\d{2,8}$/.test(ncm)) {
      invalidos.ncm = 'Use apenas dígitos (2 a 8) ou deixe vazio para a alíquota padrão.';
    }
    const aliquota = Number(String(form.aliquota_pct).replace(',', '.'));
    if (!Number.isFinite(aliquota) || aliquota < 0 || aliquota > 100) {
      invalidos.aliquota_pct = 'Informe uma alíquota entre 0 e 100.';
    }
    if (Object.keys(invalidos).length) {
      setCampos(invalidos);
      return;
    }
    setCampos({});
    setSalvando(true);
    setErroSalvar('');
    try {
      const corpo = { ncm, descricao: form.descricao.trim() || null, aliquota_pct: aliquota };
      if (modo === 'editar' && registro) await api.put(`/impostos_ncm/${registro.id}`, corpo);
      else await api.post('/impostos_ncm', corpo);
      toast.success(modo === 'editar' ? 'Alíquota atualizada.' : 'Alíquota cadastrada.');
      navigate('/ncm');
    } catch (e) {
      if (e instanceof ApiError) {
        setCampos(e.fields ?? {});
        setErroSalvar(e.message);
      } else {
        setErroSalvar('Não foi possível salvar a alíquota.');
      }
    } finally {
      setSalvando(false);
    }
  }

  if (!podeEscrever) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="NCM / Tributação"
          description="Cadastro de alíquotas por NCM."
          actions={
            <Link to="/ncm" className="btn-secondary">
              Voltar
            </Link>
          }
        />
        <Alert tone="amber">
          Seu perfil não pode cadastrar tributos. A listagem continua disponível; peça a um gerente ou administrador para
          criar ou alterar uma alíquota.
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={modo === 'editar' ? 'Editar alíquota por NCM' : 'Nova alíquota por NCM'}
        description="A chave vazia é a alíquota PADRÃO (NCMs sem chave cadastrada). O motor de impostos usa sempre a chave mais longa que casa com o NCM do produto."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/ncm')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-accent" onClick={() => void salvar()} disabled={salvando || carregando}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              {salvando ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        }
      />

      {carregando && <Spinner label="Carregando alíquota..." />}
      {erroCarga && <Alert tone="red">{erroCarga}</Alert>}
      {erroSalvar && <Alert tone="red">{erroSalvar}</Alert>}

      {!carregando && !erroCarga && (
        <div className="card mx-auto max-w-2xl space-y-4 p-5">
          <label className="label" htmlFor="ncm-chave">
            NCM (chave)
            <input
              id="ncm-chave"
              className={`input font-mono ${campos.ncm ? 'input-error' : ''}`}
              placeholder="61091000, 6109, 61... (vazio = padrão)"
              maxLength={8}
              value={form.ncm}
              onChange={(e) => setForm((f) => ({ ...f, ncm: e.target.value }))}
            />
          </label>
          {campos.ncm && <p className="text-xs text-red-600">{campos.ncm}</p>}
          <p className="text-xs text-slate-400">
            Somente dígitos (2 a 8). Vazio = alíquota padrão para os NCMs sem chave cadastrada.
          </p>

          <label className="label" htmlFor="ncm-descricao">
            Descrição
            <input
              id="ncm-descricao"
              className="input"
              placeholder="Camisetas de malha de algodão — carga tributária"
              maxLength={120}
              value={form.descricao}
              onChange={(e) => setForm((f) => ({ ...f, descricao: e.target.value }))}
            />
          </label>

          <label className="label" htmlFor="ncm-aliquota">
            Alíquota (%)
            <input
              id="ncm-aliquota"
              className={`input ${campos.aliquota_pct ? 'input-error' : ''}`}
              inputMode="decimal"
              placeholder="12"
              value={form.aliquota_pct}
              onChange={(e) => setForm((f) => ({ ...f, aliquota_pct: e.target.value }))}
            />
          </label>
          {campos.aliquota_pct && <p className="text-xs text-red-600">{campos.aliquota_pct}</p>}
          <p className="text-xs text-slate-400">
            A alíquota é dada (não é derivada de NCM/CFOP pelo ERP). Quem calcula o imposto da venda é o servidor.
          </p>
        </div>
      )}
    </div>
  );
}
