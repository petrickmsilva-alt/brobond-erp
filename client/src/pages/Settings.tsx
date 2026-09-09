import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Copy, Database, Download, Eye, EyeOff, FileSpreadsheet, KeyRound, Loader2, LogOut, Monitor, Moon, Server, Settings2, ShieldCheck, Smartphone, Sun, UserRound, Users } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { Alert, Badge, Modal, PageHeader, useToast } from '../components/ui';
import ReauthModal from '../components/ReauthModal';
import { useTheme, type ThemePref } from '../lib/theme';

const PERFIL_LABEL: Record<string, string> = { admin: 'Administrador', gerente: 'Gerente', operador: 'Operador' };
const PERFIL_DESC: Record<string, string> = {
  admin: 'Acesso total, incluindo Usuários e Auditoria.',
  gerente: 'Inclui, altera e exclui em todos os módulos, exceto Usuários e Auditoria.',
  operador: 'Inclui e altera registros, mas não exclui.',
};

const PREF_KEY = 'brobond_prefs';

export default function Settings() {
  const { user, meta, refreshMeta, logout } = useAuth();
  const location = useLocation();
  const [refreshing, setRefreshing] = useState(false);
  const trocarPedido = new URLSearchParams(location.search).get('trocar') === '1';
  const precisaTrocar = (user?.trocar_senha || trocarPedido) && !refreshing;

  useEffect(() => {
    if (location.hash === '#senha') document.getElementById('senha')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [location.hash]);

  // Onda 4: aviso de vencimento da senha (vem de /auth/me, calculado no servidor).
  const [avisoSenha, setAvisoSenha] = useState<{ senha_vence_em_dias: number | null; senha_expirada: boolean } | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const d = await api.get<{ senha_vence_em_dias?: number | null; senha_expirada?: boolean }>('/auth/me');
        if (typeof d.senha_vence_em_dias === 'number' || d.senha_expirada) {
          setAvisoSenha({ senha_vence_em_dias: d.senha_vence_em_dias ?? null, senha_expirada: d.senha_expirada === true });
        }
      } catch {
        /* sem aviso: política sem expiração ou /me indisponível */
      }
    })();
  }, []);

  async function concluirTroca() {
    await refreshMeta();
    setRefreshing(true);
    window.setTimeout(() => {
      window.history.replaceState({}, '', '/config');
      setRefreshing(false);
    }, 400);
  }

  return (
    <div className="p-4 sm:p-6">
      <PageHeader title="Configurações" description="Sua conta, senha, sessão e informações do sistema." />

      {precisaTrocar && (
        <div className="mb-4">
          <Alert tone="amber">
            <strong>Sua senha é provisória.</strong> Por segurança, defina uma nova senha abaixo antes de usar os outros módulos. Ela precisa ter pelo menos 8
            caracteres e não pode ser uma palavra óbvia.
          </Alert>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* Minha conta */}
          <section className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <UserRound className="h-4 w-4 text-navy-400" /> Minha conta
            </h2>
            <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <dt className="label">Nome</dt>
                <dd className="text-sm font-medium text-slate-800">{user?.name}</dd>
              </div>
              <div>
                <dt className="label">E-mail</dt>
                <dd className="truncate text-sm font-medium text-slate-800">{user?.email}</dd>
              </div>
              <div>
                <dt className="label">Perfil</dt>
                <dd>
                  <Badge tone={user?.perfil === 'admin' ? 'amber' : user?.perfil === 'gerente' ? 'blue' : 'slate'}>{PERFIL_LABEL[user?.perfil || ''] || user?.perfil}</Badge>
                  <p className="mt-1 text-xs text-slate-500">{PERFIL_DESC[user?.perfil || '']}</p>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs text-slate-400">Para alterar nome, e-mail ou perfil, peça a um administrador (Configurações › Usuários).</p>
          </section>

          {/* Trocar senha */}
          {avisoSenha && !user?.trocar_senha && (
            <Alert tone={avisoSenha.senha_vence_em_dias !== null && avisoSenha.senha_vence_em_dias <= 7 ? 'amber' : 'blue'}>
              Sua senha {avisoSenha.senha_vence_em_dias === 1 ? 'vence amanhã' : `vence em ${avisoSenha.senha_vence_em_dias} dias`} (política da empresa).
              Troque abaixo para não ficar sem acesso.
            </Alert>
          )}
          <section id="senha" className="card p-5 scroll-mt-6">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <KeyRound className="h-4 w-4 text-navy-400" /> Trocar senha
            </h2>
            <ChangePasswordForm disabled={!user || user.id <= 0} onChangeSenha={precisaTrocar ? concluirTroca : undefined} />
          </section>

          {/* MFA (segundo fator) */}
          <MfaCard />

          {/* Sessões por dispositivo */}
          <SessoesCard onSairDeTodos={logout} />
        </div>

        <div className="space-y-4">
          <PreferenciasCard />
          {/* Sistema */}
          <section className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <Server className="h-4 w-4 text-navy-400" /> Sistema
            </h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Versão</dt>
                <dd className="font-medium text-slate-800">BROBOND ERP {meta?.version ?? ''}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <Database className="h-3.5 w-3.5" /> Banco de dados
                </dt>
                <dd>{meta?.mode === 'postgres' ? <Badge tone="green">PostgreSQL</Badge> : <Badge tone="amber">Demonstração (memória)</Badge>}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">Fotos</dt>
                <dd>
                  {meta?.uploads === 'cloudinary' ? (
                    <Badge tone="green">Cloudinary (CDN) — OK</Badge>
                  ) : (
                    <Badge tone="green">No banco de dados — OK</Badge>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-slate-500">E-mail (recuperação)</dt>
                <dd>{meta?.smtp?.configurado ? <Badge tone="green">SMTP configurado</Badge> : <Badge tone="slate">Sem SMTP (link no console)</Badge>}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-500">Links de e-mail (convite)</dt>
                <dd className="text-right">
                  {meta?.emailLinks?.configurada ? (
                    meta.emailLinks.appUrlIgnorada ? (
                      <Badge tone="red">APP_URL ignorada (endereço interno) — usando {meta.emailLinks.base}</Badge>
                    ) : (
                      <Badge tone="green">Endereço fixo (APP_URL): {meta.emailLinks.base}</Badge>
                    )
                  ) : meta?.emailLinks?.base ? (
                    <Badge tone="amber">Sem APP_URL — usando {meta.emailLinks.base}</Badge>
                  ) : (
                    <Badge tone="red">Sem origem definida — o link não abre</Badge>
                  )}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="flex items-center gap-1.5 text-slate-500">
                  <ShieldCheck className="h-3.5 w-3.5" /> Senhas
                </dt>
                <dd className="font-medium text-slate-800">Argon2id + MFA (admin)</dd>
              </div>
            </dl>
            {meta?.emailLinks?.appUrlIgnorada || (meta?.emailLinks && meta.emailLinks.base && meta.emailLinks.publica === false) ? (
              <div className="mt-4">
                <Alert tone="red">
                  <strong>Os links de e-mail não abrem para quem recebe (“URL inválida”).</strong> O endereço configurado
                  existe só dentro do servidor (localhost, IP privado ou nome sem domínio), então ele é descartado. Defina{' '}
                  <code>APP_URL</code> com o endereço público do ERP (na Render: Environment → <code>APP_URL</code>, ex.{' '}
                  <code>https://erp.brobond.com.br</code>) e reenvie o convite.
                </Alert>
              </div>
            ) : meta?.emailLinks?.aviso ? (
              <div className="mt-4">
                <Alert tone="amber">
                  <strong>Convites por e-mail podem abrir como “URL inválida”.</strong> O servidor não tem{' '}
                  <code>APP_URL</code> configurada, então o endereço do link é deduzido de quem o gerou. Defina{' '}
                  <code>APP_URL</code> com o endereço público do ERP (na Render: Environment → <code>APP_URL</code>, ex.{' '}
                  <code>https://erp.brobond.com.br</code>) e reenvie o convite.
                </Alert>
              </div>
            ) : null}
            {meta?.uploadsConfigError && (
              <div className="mt-4">
                <Alert tone="amber">
                  O Cloudinary está configurado (<code>UPLOAD_PROVIDER=cloudinary</code>), mas a variável{' '}
                  <code>CLOUDINARY_URL</code> não foi aceita — as fotos estão sendo salvas no banco de dados.
                  Verifique na Render se o valor começa exatamente com <code>cloudinary://</code>, sem o nome da
                  variável na frente, sem aspas nem espaços.
                </Alert>
              </div>
            )}
            {meta?.mode === 'memory' && (
              <div className="mt-4">
                <Alert tone="amber">Sem <code>DATABASE_URL</code> os dados são apagados ao reiniciar o servidor.</Alert>
              </div>
            )}
          </section>

          {user?.perfil === 'admin' && (
            <section className="card p-5">
              <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
                <Users className="h-4 w-4 text-navy-400" /> Administração
              </h2>
              <p className="mt-2 text-sm text-slate-500">Cadastre usuários, defina perfis e redefina senhas.</p>
              <div className="mt-3 flex flex-col gap-2">
                <Link to="/usuarios" className="btn-primary justify-start">
                  <Users className="h-4 w-4" /> Gerenciar usuários
                </Link>
                <Link to="/auditoria" className="btn-secondary justify-start">
                  <ShieldCheck className="h-4 w-4" /> Ver auditoria
                </Link>
                <BackupCard />
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

type Sessao = { sid: string; atual: boolean; criada_em: string; expira_em: string; ip: string | null; user_agent: string | null };

function dataCurta(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** MFA/TOTP: ativação com QR; desativação exige reautenticação + código. */
function MfaCard() {
  const { user } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<{ ativado: boolean; obrigatorio: boolean; backup_restantes?: number } | null>(null);
  const [setup, setSetup] = useState<{ segredo: string; qr: string } | null>(null);
  const [codigo, setCodigo] = useState('');
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState('');
  const [pedirReauth, setPedirReauth] = useState(false);
  const [codigosNovos, setCodigosNovos] = useState<string[] | null>(null);
  const [gerarBusy, setGerarBusy] = useState(false);
  const [aposReauth, setAposReauth] = useState<'codigos' | null>(null);

  const carregar = useCallback(async () => {
    try {
      setStatus(await api.get('/auth/mfa/status'));
    } catch {
      setStatus({ ativado: false, obrigatorio: false });
    }
  }, []);
  useEffect(() => {
    if (user && user.id > 0) carregar();
  }, [user, carregar]);

  async function iniciarSetup() {
    setBusy(true);
    setErro('');
    try {
      const d = await api.post<{ segredo: string; qr: string }>('/auth/mfa/setup', {});
      setSetup(d);
    } catch (e: any) {
      setErro(e instanceof ApiError ? e.message : 'Não foi possível iniciar o cadastro do MFA.');
    } finally {
      setBusy(false);
    }
  }

  async function ativar() {
    if (!codigo) return;
    setBusy(true);
    setErro('');
    try {
      const d = await api.post<{ codigos?: string[] }>('/auth/mfa/ativar', { codigo });
      toast.success('MFA ativado! A partir de agora o login pede o código do app autenticador.');
      setSetup(null);
      setCodigo('');
      await carregar();
      if (d.codigos?.length) setCodigosNovos(d.codigos);

    } catch (e: any) {
      if (e instanceof ApiError && e.fields?.codigo) setErro(e.fields.codigo);
      else setErro(e instanceof ApiError ? e.message : 'Código inválido.');
    } finally {
      setBusy(false);
    }
  }

  async function gerarCodigos() {
    setGerarBusy(true);
    setErro('');
    try {
      const d = await api.post<{ codigos: string[] }>('/auth/mfa/codigos', {});
      setCodigosNovos(d.codigos);
      await carregar();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setAposReauth('codigos');
        setPedirReauth(true);
        setErro('');
        return;
      }
      setErro(e instanceof ApiError ? e.message : 'Não foi possível gerar os códigos.');
    } finally {
      setGerarBusy(false);
    }
  }

  function baixarCodigos() {
    if (!codigosNovos) return;
    const blob = new Blob([`BROBOND ERP — códigos de recuperação do MFA (${user?.email || ''})\nGerados em ${new Date().toLocaleString('pt-BR')}. Cada código vale UM acesso. Guarde em local seguro.\n\n${codigosNovos.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'brobond-codigos-recuperacao.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function desativar() {
    if (!codigo) {
      setErro('Informe o código atual do app para desativar.');
      return;
    }
    setBusy(true);
    setErro('');
    try {
      await api.post('/auth/mfa/desativar', { codigo });
      toast.success('MFA desativado. Sessões de outros dispositivos foram encerradas.');
      setCodigo('');
      await carregar();
    } catch (e: any) {
      if (e instanceof ApiError && e.code === 'reauth_necessaria') {
        setPedirReauth(true);
        setErro('');
        return;
      }
      setErro(e instanceof ApiError ? e.message : 'Não foi possível desativar.');
    } finally {
      setBusy(false);
    }
  }

  if (!user || user.id <= 0) return null;
  const obrigatorio = status?.obrigatorio || user.perfil === 'admin';

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
        <Smartphone className="h-4 w-4 text-navy-400" /> Autenticação em dois fatores (MFA)
      </h2>
      {!status ? (
        <p className="mt-2 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
        </p>
      ) : status.ativado ? (
        <div className="mt-3 space-y-3">
          <p className="flex items-center gap-2 text-sm text-slate-600">
            <Badge tone="green">Ativado</Badge> Seu login exige o código de 6 dígitos do app autenticador.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50/60 p-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-navy-900">
              <KeyRound className="h-4 w-4 text-navy-400" /> Códigos de recuperação
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {status.backup_restantes === 0 ? (
                <>Você <strong>não tem códigos válidos</strong> — se perder o celular, perde o acesso. Gere um lote agora.</>
              ) : (
                <>Você tem <strong>{status.backup_restantes ?? 0} código(s)</strong> válidos para emergências (cada um vale um acesso).</>
              )}
            </p>
            <button className="btn-secondary mt-2 !px-2.5 !py-1.5 text-xs" onClick={gerarCodigos} disabled={gerarBusy}>
              {gerarBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Gerar novos códigos
            </button>
            <p className="mt-1 text-xs text-slate-400">Gerar invalida o lote anterior. Exige a sua senha (reautenticação).</p>
          </div>
          {erro && <Alert tone="red">{erro}</Alert>}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-36">
              <label className="label" htmlFor="mfa-codigo-desativar">
                Código atual
              </label>
              <input id="mfa-codigo-desativar" className="input font-mono" inputMode="numeric" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
            </div>
            <button className="btn-secondary" onClick={desativar} disabled={busy || codigo.length !== 6}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Desativar MFA
            </button>
          </div>
          <p className="text-xs text-slate-400">Desativar exige a sua senha recente (reautenticação) e encerra as sessões de outros dispositivos.</p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-slate-600">
            {obrigatorio ? (
              <>
                <Badge tone="amber">Obrigatório para administradores</Badge> Proteja sua conta com um app autenticador (Google Authenticator, Aegis, 1Password…).
              </>
            ) : (
              'Recomendado: adicione uma segunda camada de proteção ao seu acesso com um app autenticador.'
            )}
          </p>
          {!setup ? (
            <>
              {erro && <Alert tone="red">{erro}</Alert>}
              <button className="btn-primary" onClick={iniciarSetup} disabled={busy}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Ativar MFA
              </button>
            </>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col items-start gap-3 sm:flex-row">
                <img src={setup.qr} alt="QR Code do app autenticador" className="h-40 w-40 rounded-lg border border-slate-200 p-1" />
                <div className="flex-1 text-sm text-slate-600">
                  <p>1. Escaneie o QR no seu app autenticador.</p>
                  <p className="mt-1">
                    2. Ou digite o segredo manualmente:{' '}
                    <button className="font-mono text-xs underline-offset-2 hover:underline" onClick={() => navigator.clipboard.writeText(setup.segredo).then(() => toast.success('Segredo copiado.'))}>
                      {setup.segredo.slice(0, 8)}… <Copy className="inline h-3 w-3" />
                    </button>
                  </p>
                  <p className="mt-1">3. Informe o código de 6 dígitos que o app mostrar.</p>
                </div>
              </div>
              {erro && <Alert tone="red">{erro}</Alert>}
              <div className="flex flex-wrap items-end gap-2">
                <div className="w-36">
                  <label className="label" htmlFor="mfa-codigo-ativar">
                    Código atual
                  </label>
                  <input id="mfa-codigo-ativar" className="input font-mono" inputMode="numeric" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value.replace(/\D/g, ''))} placeholder="000000" />
                </div>
                <button className="btn-primary" onClick={ativar} disabled={busy || codigo.length !== 6}>
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirmar e ativar
                </button>
                <button className="btn-secondary" onClick={() => { setSetup(null); setErro(''); }}>
                  Cancelar
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      <ReauthModal
        open={pedirReauth}
        onClose={() => {
          setPedirReauth(false);
          setAposReauth(null);
        }}
        onConfirmed={() => {
          setErro('');
          if (aposReauth === 'codigos') {
            setAposReauth(null);
            void gerarCodigos();
          }
        }}
        titulo={aposReauth === 'codigos' ? 'Autorizar novos códigos de recuperação' : 'Autorizar desativação do MFA'}
      />
      <Modal open={!!codigosNovos} onClose={() => setCodigosNovos(null)} title="Códigos de recuperação" subtitle="Exibição única: guarde agora, cada código vale um acesso." size="md">
        <div className="space-y-4">
          <Alert tone="amber">
            Estes códigos <strong>não aparecem de novo</strong>. Sem eles (e sem o celular), só o administrador — com reset do MFA — devolve o seu acesso.
          </Alert>
          <div className="grid grid-cols-2 gap-1.5">
            {(codigosNovos || []).map((c) => (
              <span key={c} className="rounded-md bg-slate-50 px-2 py-1.5 text-center font-mono text-sm font-semibold tracking-wider text-navy-900 ring-1 ring-slate-200">
                {c}
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText((codigosNovos || []).join('\n'));
                toast.success('Códigos copiados.');
              }}
            >
              <Copy className="h-4 w-4" /> Copiar todos
            </button>
            <button className="btn-secondary" onClick={baixarCodigos}>
              <Download className="h-4 w-4" /> Baixar .txt
            </button>
            <button className="btn-primary ml-auto" onClick={() => setCodigosNovos(null)}>
              Guardei — fechar
            </button>
          </div>
        </div>
      </Modal>
    </section>
  );
}

/** Lista de sessões ativas com revogação por dispositivo. */
function SessoesCard({ onSairDeTodos }: { onSairDeTodos: () => void }) {
  const { user } = useAuth();
  const toast = useToast();
  const [sessoes, setSessoes] = useState<Sessao[] | null>(null);

  const carregar = useCallback(async () => {
    try {
      const d = await api.get<{ sessoes: Sessao[] }>('/auth/sessoes');
      setSessoes(d.sessoes);
    } catch {
      setSessoes([]);
    }
  }, []);
  useEffect(() => {
    if (user && user.id > 0) carregar();
  }, [user, carregar]);

  async function revogar(sid: string) {
    try {
      await api.post(`/auth/sessoes/${sid}/revogar`, {});
      toast.success('Sessão revogada.');
      await carregar();
    } catch (e: any) {
      toast.error(e instanceof ApiError ? e.message : 'Não foi possível revogar.');
    }
  }

  async function sairDeTodos() {
    try {
      await api.post('/auth/logout-all', {});
    } catch {
      /* segue mesmo se a API falhar: limpa o dispositivo local */
    }
    onSairDeTodos();
  }

  if (!user || user.id <= 0) return null;

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
        <LogOut className="h-4 w-4 text-navy-400" /> Sessões e dispositivos
      </h2>
      <p className="mt-2 text-sm text-slate-500">Cada acesso cria uma sessão que pode ser revogada individualmente — derruba o token daquele dispositivo na hora.</p>
      {!sessoes ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando...
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {sessoes.map((s) => (
            <li key={s.sid} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-800">
                  {s.atual && <Badge tone="green">Este dispositivo</Badge>} <span className="font-mono text-xs text-slate-400">{s.sid.slice(0, 8)}</span>{' '}
                  <span className="text-slate-500">· {s.ip || 'ip desconhecido'}</span>
                </p>
                <p className="truncate text-xs text-slate-400">
                  Entrou em {dataCurta(s.criada_em)} · {s.user_agent || 'agente desconhecido'}
                </p>
              </div>
              {!s.atual && (
                <button className="btn-secondary shrink-0 !px-2 !py-1 text-xs" onClick={() => revogar(s.sid)}>
                  Revogar
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <button className="btn-secondary mt-3" onClick={sairDeTodos}>
        <LogOut className="h-4 w-4 text-red-500" /> Sair de todos os dispositivos
      </button>
    </section>
  );
}

/** Botão olhinho dentro do campo de senha: alterna entre mostrar e ocultar. */
function PasswordEye({ show, onToggle, disabled }: { show: boolean; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-400 hover:text-slate-600"
      onClick={onToggle}
      tabIndex={-1}
      disabled={disabled}
      title={show ? 'Ocultar senha' : 'Mostrar senha'}
      aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}
    >
      {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  );
}

function ChangePasswordForm({ disabled, onChangeSenha }: { disabled: boolean; onChangeSenha?: () => void }) {
  const toast = useToast();
  const [atual, setAtual] = useState('');
  const [nova, setNova] = useState('');
  const [confirma, setConfirma] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState('');

  function clear() {
    setAtual('');
    setNova('');
    setConfirma('');
    setErrors({});
    setMsg('');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const errs: Record<string, string> = {};
    if (!atual) errs.senha_atual = 'Informe a senha atual';
    if (nova.length < 8) errs.senha_nova = 'Mínimo de 8 caracteres';
    if (nova !== confirma) errs.confirma = 'As senhas não conferem';
    if (nova && nova === atual) errs.senha_nova = 'A nova senha deve ser diferente da atual';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setBusy(true);
    try {
      await api.post('/auth/change-password', { senha_atual: atual, senha_nova: nova });
      toast.success('Senha alterada com sucesso.');
      clear();
      if (onChangeSenha) onChangeSenha();
    } catch (e: any) {
      if (e instanceof ApiError && e.fields) setErrors(e.fields);
      setMsg(e.message || 'Não foi possível alterar a senha.');
    } finally {
      setBusy(false);
    }
  }

  const type = show ? 'text' : 'password';

  return (
    <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
      {disabled && <Alert tone="slate">O acesso de emergência não permite trocar a senha por aqui.</Alert>}
      {msg && <Alert tone="red">{msg}</Alert>}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="senha_atual">
            Senha atual
          </label>
          <div className="relative">
            <input
              id="senha_atual"
              type={type}
              className={`input pr-10 ${errors.senha_atual ? 'input-error' : ''}`}
              value={atual}
              onChange={(e) => setAtual(e.target.value)}
              autoComplete="current-password"
              disabled={disabled || busy}
            />
            <PasswordEye show={show} onToggle={() => setShow((s) => !s)} disabled={disabled || busy} />
          </div>
          {errors.senha_atual && <p className="mt-1 text-xs font-medium text-red-600">{errors.senha_atual}</p>}
        </div>
        <div>
          <label className="label" htmlFor="senha_nova">
            Nova senha
          </label>
          <div className="relative">
            <input
              id="senha_nova"
              type={type}
              className={`input pr-10 ${errors.senha_nova ? 'input-error' : ''}`}
              value={nova}
              onChange={(e) => setNova(e.target.value)}
              autoComplete="new-password"
              disabled={disabled || busy}
            />
            <PasswordEye show={show} onToggle={() => setShow((s) => !s)} disabled={disabled || busy} />
          </div>
          {errors.senha_nova ? <p className="mt-1 text-xs font-medium text-red-600">{errors.senha_nova}</p> : <p className="mt-1 text-xs text-slate-400">Mínimo de 8 caracteres, sem palavras óbvias.</p>}
        </div>
        <div>
          <label className="label" htmlFor="confirma">
            Confirmar nova senha
          </label>
          <div className="relative">
            <input
              id="confirma"
              type={type}
              className={`input pr-10 ${errors.confirma ? 'input-error' : ''}`}
              value={confirma}
              onChange={(e) => setConfirma(e.target.value)}
              autoComplete="new-password"
              disabled={disabled || busy}
            />
            <PasswordEye show={show} onToggle={() => setShow((s) => !s)} disabled={disabled || busy} />
          </div>
          {errors.confirma && <p className="mt-1 text-xs font-medium text-red-600">{errors.confirma}</p>}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={() => setShow((s) => !s)}>
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {show ? 'Ocultar senhas' : 'Mostrar senhas'}
        </button>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary" onClick={clear} disabled={busy}>
            Limpar
          </button>
          <button type="submit" className="btn-primary" disabled={disabled || busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Salvar nova senha
          </button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Preferências por usuário (F7) — local no navegador + cópia no servidor (JSONB)
// ---------------------------------------------------------------------------
const TEMA_OPCOES: { value: ThemePref; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Automático', icon: Monitor },
];

function TemaSelector() {
  const [tema, setTema] = useTheme();
  return (
    <div className="mt-1.5 inline-flex rounded-lg border border-slate-200 bg-slate-100 p-1 dark:border-navy-700 dark:bg-navy-800" role="radiogroup" aria-label="Aparência">
      {TEMA_OPCOES.map((o) => {
        const Icon = o.icon;
        const ativo = tema === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={ativo}
            onClick={() => setTema(o.value)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors ${
              ativo ? 'bg-white text-navy-900 shadow-sm dark:bg-navy-700 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:text-navy-300 dark:hover:text-navy-200'
            }`}
          >
            <Icon className="h-3.5 w-3.5" /> {o.label}
          </button>
        );
      })}
    </div>
  );
}

function PreferenciasCard() {
  const toast = useToast();
  const [locais, setLocais] = useState<{ value: number; label: string }[]>([]);
  const [gradeLocal, setGradeLocal] = useState('');
  const [carregou, setCarregou] = useState(false);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    api
      .get<{ value: number; label: string }[]>('/locais/options')
      .then((o) => {
        setLocais(o);
        // preferência local primeiro (navegador); servidor como backup
        const local = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
        if (local?.gradeLocal) setGradeLocal(local.gradeLocal);
      })
      .catch(() => {});
    api
      .get<{ preferencias: Record<string, any> }>('/auth/preferences')
      .then((d) => {
        setCarregou(true);
        if (d.preferencias?.gradeLocal && !JSON.parse(localStorage.getItem(PREF_KEY) || '{}')?.gradeLocal) {
          setGradeLocal(String(d.preferencias.gradeLocal));
        }
      })
      .catch(() => setCarregou(true));
  }, []);

  useEffect(() => {
    if (!gradeLocal || !carregou) return;
    const timer = window.setTimeout(() => {
      localStorage.setItem(PREF_KEY, JSON.stringify({ gradeLocal }));
      api.put('/auth/preferences', { preferencias: { gradeLocal } }).catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [gradeLocal, carregou]);

  async function salvarTudo() {
    setSalvando(true);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify({ gradeLocal }));
      await api.put('/auth/preferences', { preferencias: { gradeLocal } });
      toast.success('Preferências salvas neste usuário.');
    } catch (e: any) {
      toast.error(e.message || 'Falha ao salvar preferências.');
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section className="card p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
        <Settings2 className="h-4 w-4 text-navy-400" /> Preferências
      </h2>
      <p className="mt-2 text-sm text-slate-500">Aplicadas no seu usuário em qualquer dispositivo (ficam também salvas localmente).</p>

      <div className="mt-3">
        <span className="label">Aparência</span>
        <TemaSelector />
      </div>

      <label className="mt-4 block">
        <span className="label">Local padrão na grade de estoque</span>
        <select className="input" value={gradeLocal} onChange={(e) => setGradeLocal(e.target.value)}>
          <option value="">Todos os locais (soma)</option>
          {locais.map((o) => (
            <option key={o.value} value={o.label}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button className="btn-secondary mt-3" onClick={salvarTudo} disabled={salvando}>
        {salvando && <Loader2 className="h-4 w-4 animate-spin" />} Salvar preferências
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Backup do banco (admin)
// ---------------------------------------------------------------------------
function BackupCard() {
  const toast = useToast();
  const [info, setInfo] = useState<{ kind: string; registros?: number; tabelas?: number } | null>(null);
  useEffect(() => {
    api
      .get<{ kind: string; registros?: number; tabelas?: number }>('/admin/backup/info')
      .then(setInfo)
      .catch(() => {});
  }, []);

  if (!info) return null;
  return (
    <div className="mt-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-500">
        {info.kind === 'postgres' ? (
          <>
            <strong>Backup do banco:</strong> {info.tabelas ?? '—'} tabelas · {info.registros ?? '—'} registros. Dump SQL completo (sem as fotos) ou planilha XLSX com todas as tabelas.
          </>
        ) : (
          'Modo demonstração (memória): o dump SQL só existe com Postgres, mas a planilha XLSX completa funciona aqui também.'
        )}
      </p>
      <div className="mt-2 flex flex-col gap-2">
        {info.kind === 'postgres' && (
          <button
            className="btn-secondary w-full justify-start text-xs"
            onClick={() =>
              downloadFile('/admin/backup', `brobond-backup-${new Date().toISOString().slice(0, 10)}.sql`).catch((e) => toast.error(e.message || 'Falha no backup.'))
            }
          >
            <Download className="h-4 w-4" /> Baixar backup (.sql)
          </button>
        )}
        <button
          className="btn-secondary w-full justify-start text-xs"
          onClick={() => downloadFile('/admin/backup/xlsx', `brobond-completo-${new Date().toISOString().slice(0, 10)}.xlsx`).catch((e) => toast.error(e.message || 'Falha na exportação.'))}
        >
          <FileSpreadsheet className="h-4 w-4 text-emerald-600" /> Exportar tudo (.xlsx)
        </button>
      </div>
    </div>
  );
}
