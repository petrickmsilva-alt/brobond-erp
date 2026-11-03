import { useEffect, useState, type ReactNode } from 'react';
import { Link2, LockKeyhole, Mail, MessageCircle, RefreshCw, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useAuth } from '../../auth/AuthContext';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '../../components/ui';
import { apiFetch, ApiError } from '../../lib/api';
import { visibleModules } from '../../modules';

type StatusConfiguracao = 'CONFIGURADO' | 'NAO_CONFIGURADO';

type ConfiguracaoCanal = {
  status_configuracao: StatusConfiguracao;
  variaveis_ausentes: string[];
};

/** Projeção de diagnóstico: não há campos para credenciais, IDs ou pedidos. */
export type StatusNotificacoes = {
  ok: boolean;
  consultado_em: string;
  email: ConfiguracaoCanal & { smtp_configurado: boolean; remetente_dedicado: boolean };
  whatsapp: ConfiguracaoCanal & {
    token_configurado: boolean;
    phone_number_id_configurado: boolean;
    modelos_configurados: Record<string, boolean>;
    templates: Record<string, boolean>;
    eventos_sem_template: string[];
    idioma: string | null;
    idioma_configurado: boolean;
  };
  link_publico: ConfiguracaoCanal;
};

const VARIAVEIS_EMAIL = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'];
const MODELOS = [
  { variavel: 'WHATSAPP_TEMPLATE_ORDER_CREATED', esperado: 'brobond_pedido_recebido' },
  { variavel: 'WHATSAPP_TEMPLATE_PAYMENT_APPROVED', esperado: 'brobond_pagamento_confirmado' },
  { variavel: 'WHATSAPP_TEMPLATE_TRANSACIONAL', esperado: 'brobond_transacional' },
];
const VARIAVEIS_WHATSAPP = [
  'WHATSAPP_CLOUD_API_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  ...MODELOS.map((modelo) => modelo.variavel),
  'WHATSAPP_TEMPLATE_IDIOMA',
];
const VARIAVEIS_LINK = ['APP_URL', 'PUBLIC_BASE_URL'];
const EVENTOS: Record<string, string> = {
  ORDER_CREATED: 'Pedido recebido',
  PIX_GENERATED: 'PIX gerado',
  PAYMENT_PENDING: 'Pagamento pendente',
  PAYMENT_APPROVED: 'Pagamento confirmado',
  PAYMENT_REJECTED: 'Pagamento recusado',
  ORDER_PROCESSING: 'Pedido em preparação',
  ORDER_SHIPPED: 'Pedido enviado',
  ORDER_DELIVERED: 'Pedido entregue',
  ORDER_CANCELLED: 'Pedido cancelado',
  ORDER_EXPIRED: 'Pedido expirado',
};

function ConfiguracaoBadge({ status, parcial = false }: { status: StatusConfiguracao; parcial?: boolean }) {
  const configurado = status === 'CONFIGURADO';
  return (
    <Badge tone={configurado && !parcial ? 'green' : 'amber'}>
      {configurado ? (parcial ? 'Configuração parcial' : 'Configurado') : 'Não configurado'}
    </Badge>
  );
}

function Presenca({ configurado }: { configurado: boolean }) {
  return <Badge tone={configurado ? 'green' : 'amber'}>{configurado ? 'Configurado' : 'Ausente'}</Badge>;
}

function CardCanal({
  id,
  titulo,
  icon: Icon,
  status,
  parcial,
  children,
}: {
  id: string;
  titulo: string;
  icon: LucideIcon;
  status: StatusConfiguracao;
  parcial?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-5 rounded-xl border border-line bg-surface p-5">
      <div className="flex items-center gap-2">
        <Icon className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
        <h2 id={id} className="text-base font-semibold text-ink">
          {titulo}
        </h2>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="text-muted">Configuração local</span>
        <ConfiguracaoBadge status={status} parcial={parcial} />
      </div>
      {children}
    </section>
  );
}

/** Allowlist: nem campos extras nem strings arbitrárias da API viram valores na UI. */
function VariaveisAusentes({ nomes, permitidas }: { nomes: string[]; permitidas: string[] }) {
  const ausentes = permitidas.filter((nome) => nomes.includes(nome));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-ink">Variáveis ausentes</h3>
      {ausentes.length ? (
        <ul className="space-y-1 text-xs text-muted">
          {ausentes.map((nome) => (
            <li key={nome}>
              <code className="break-all">{nome}</code>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Nenhuma variável ausente.</p>
      )}
    </div>
  );
}

function Diagnostico({ dados }: { dados: StatusNotificacoes }) {
  const { email, whatsapp, link_publico: link } = dados;
  // Só eventos conhecidos são apresentados; mensagens/erros brutos não são renderizados.
  const semModelo = Object.keys(EVENTOS).filter((evento) => whatsapp.eventos_sem_template.includes(evento));
  const idioma = whatsapp.idioma && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(whatsapp.idioma) ? whatsapp.idioma : null;
  const pendencias: string[] = [];
  if (!email.smtp_configurado) pendencias.push('E-mail: complete as variáveis SMTP obrigatórias.');
  if (!email.remetente_dedicado) pendencias.push('E-mail: SMTP_FROM ausente; defina um remetente dedicado.');
  if (!whatsapp.token_configurado) pendencias.push('WhatsApp: WHATSAPP_CLOUD_API_TOKEN ausente.');
  if (!whatsapp.phone_number_id_configurado) pendencias.push('WhatsApp: WHATSAPP_PHONE_NUMBER_ID ausente.');
  if (semModelo.length)
    pendencias.push(
      `WhatsApp: ${semModelo.length} evento(s) sem modelo. Defina os modelos por evento ou WHATSAPP_TEMPLATE_TRANSACIONAL como fallback.`
    );
  if (!idioma) pendencias.push('WhatsApp: revise WHATSAPP_TEMPLATE_IDIOMA; o formato do idioma é inválido (valor oculto).');
  else if (!whatsapp.idioma_configurado) pendencias.push('WhatsApp: WHATSAPP_TEMPLATE_IDIOMA ausente; o padrão de envio é pt_BR.');
  if (link.status_configuracao !== 'CONFIGURADO') pendencias.push('Link Público: defina APP_URL ou PUBLIC_BASE_URL.');

  return (
    <>
      <div className="grid items-start gap-4 md:grid-cols-2 xl:grid-cols-3">
        <CardCanal id="notificacoes-email" titulo="E-mail" icon={Mail} status={email.status_configuracao}>
          <dl className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt>SMTP</dt>
              <dd>
                <Presenca configurado={email.smtp_configurado} />
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt>Remetente dedicado</dt>
              <dd>
                <Presenca configurado={email.remetente_dedicado} />
              </dd>
            </div>
          </dl>
          <VariaveisAusentes nomes={email.variaveis_ausentes} permitidas={VARIAVEIS_EMAIL} />
          <p className="text-xs text-muted">
            SMTP_FROM é opcional para o transporte, mas permite um remetente dedicado. Endereços e credenciais não são exibidos.
          </p>
        </CardCanal>

        <CardCanal
          id="notificacoes-whatsapp"
          titulo="WhatsApp — Meta Cloud API"
          icon={MessageCircle}
          status={whatsapp.status_configuracao}
          parcial={semModelo.length > 0 || !idioma}
        >
          <dl className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt>Token</dt>
              <dd>
                <Presenca configurado={whatsapp.token_configurado} />
              </dd>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt>Phone Number ID</dt>
              <dd>
                <Presenca configurado={whatsapp.phone_number_id_configurado} />
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted">Idioma</dt>
              <dd>
                {idioma
                  ? `${idioma} (${whatsapp.idioma_configurado ? 'configurado' : 'padrão; variável ausente'})`
                  : 'Inválido (valor oculto)'}
              </dd>
            </div>
          </dl>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Modelos transacionais</h3>
            <p className="text-xs text-muted">
              Referências esperadas, não os valores das variáveis nem uma confirmação de aprovação na Meta.
            </p>
            <ul className="space-y-3">
              {MODELOS.map(({ variavel, esperado }) => (
                <li key={variavel} className="space-y-1 rounded-lg border border-line p-3 text-xs">
                  <code className="block break-all font-semibold">{esperado}</code>
                  <code className="block break-all text-muted">{variavel}</code>
                  <Presenca configurado={whatsapp.modelos_configurados[variavel] === true} />
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              O modelo transacional é fallback para eventos sem modelo específico. Uma variável específica ausente não bloqueia o evento
              coberto pelo fallback.
            </p>
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-ink">Eventos sem modelo</h3>
            {semModelo.length ? (
              <ul className="list-inside list-disc space-y-1 text-xs text-muted">
                {semModelo.map((evento) => (
                  <li key={evento}>
                    {EVENTOS[evento]} <code>({evento})</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Todos os eventos com mensagem têm modelo local.</p>
            )}
          </div>
          <VariaveisAusentes nomes={whatsapp.variaveis_ausentes} permitidas={VARIAVEIS_WHATSAPP} />
        </CardCanal>

        <CardCanal id="notificacoes-link" titulo="Link Público do pedido" icon={Link2} status={link.status_configuracao}>
          <p className="text-sm text-muted">Base pública para acompanhamento do pedido. Basta configurar APP_URL ou PUBLIC_BASE_URL.</p>
          <VariaveisAusentes nomes={link.variaveis_ausentes} permitidas={VARIAVEIS_LINK} />
          <p className="text-xs text-muted">O endereço da base e os tokens individuais dos pedidos nunca são exibidos nesta central.</p>
        </CardCanal>
      </div>

      <section aria-labelledby="notificacoes-pendencias" className="space-y-3 rounded-xl border border-line bg-surface p-5">
        <h2 id="notificacoes-pendencias" className="text-base font-semibold text-ink">
          Pendências de configuração
        </h2>
        {pendencias.length ? (
          <ul className="list-inside list-disc space-y-2 text-sm text-muted">
            {pendencias.map((pendencia) => (
              <li key={pendencia}>{pendencia}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nenhuma pendência de configuração identificada. Conexão e entrega não foram testadas.</p>
        )}
      </section>
    </>
  );
}

export default function CommerceNotificacoesPage() {
  const { user } = useAuth();
  // Mesma descoberta de permissões usada por menu, palette e ModuleAccess.
  // A autorização efetiva continua no checkAccess do endpoint autenticado.
  const podeConsultar = visibleModules(user).some((modulo) => modulo.id === 'commerce-notificacoes');
  const [dados, setDados] = useState<StatusNotificacoes | null>(null);
  const [carregando, setCarregando] = useState(podeConsultar);
  const [erro, setErro] = useState<{ status: number; mensagem: string } | null>(null);
  const [ultimaConsulta, setUltimaConsulta] = useState<Date | null>(null);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    if (!podeConsultar) {
      setDados(null);
      setCarregando(false);
      setUltimaConsulta(null);
      return;
    }
    const controller = new AbortController();
    setCarregando(true);
    setDados(null);
    setErro(null);
    // Reutiliza JWT, timeout, retry e tratamento de sessão do cliente canônico.
    // O Layout remonta a página na troca de empresa; o abort descarta a consulta anterior.
    apiFetch<StatusNotificacoes>('/commerce/notificacoes/status', { signal: controller.signal })
      .then((resposta) => {
        if (controller.signal.aborted) return;
        const quando = new Date(resposta.consultado_em);
        setDados(resposta);
        setUltimaConsulta(Number.isNaN(quando.getTime()) ? new Date() : quando);
      })
      .catch((falha: unknown) => {
        if (controller.signal.aborted) return;
        const status = falha instanceof ApiError ? falha.status : -1;
        // Não renderiza mensagens arbitrárias de erros/provedores.
        const mensagem =
          status === 403
            ? 'Apenas gerentes e administradores podem consultar a Central de Notificações.'
            : status === 401
              ? 'Sessão expirada. Entre novamente no ERP.'
              : status === 0
                ? 'Sem conexão com o servidor. Verifique sua internet e tente Atualizar Status novamente.'
                : 'Não foi possível consultar o status das notificações. Tente Atualizar Status novamente.';
        setErro({ status, mensagem });
      })
      .finally(() => {
        if (!controller.signal.aborted) setCarregando(false);
      });
    return () => controller.abort();
  }, [podeConsultar, tentativa]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Central de Notificações"
        description="Diagnóstico dos canais transacionais da BroBond."
        actions={
          <button
            type="button"
            className="btn-ghost"
            disabled={carregando || !podeConsultar}
            onClick={() => setTentativa((atual) => atual + 1)}
          >
            <RefreshCw className={`h-4 w-4 ${carregando ? 'animate-spin' : ''}`} aria-hidden="true" /> Atualizar Status
          </button>
        }
      />
      <Alert>
        <span className="font-semibold">Configuração local não comprova conexão nem entrega.</span> Esta consulta não envia e-mails ou
        WhatsApp e não verifica a aprovação dos modelos na Meta.
      </Alert>
      <p className="flex items-center gap-2 text-xs text-muted" aria-live="polite">
        <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
        Última consulta bem-sucedida:{' '}
        {ultimaConsulta ? (
          <time dateTime={ultimaConsulta.toISOString()}>{ultimaConsulta.toLocaleString('pt-BR')}</time>
        ) : (
          'ainda não realizada.'
        )}
      </p>
      {!podeConsultar || erro?.status === 403 ? (
        <EmptyState
          icon={<LockKeyhole className="h-6 w-6" aria-hidden="true" />}
          title="Sem permissão"
          description="Apenas gerentes e administradores podem consultar a Central de Notificações."
        />
      ) : (
        <div aria-busy={carregando} aria-live="polite">
          {erro && <Alert tone="red">{erro.mensagem}</Alert>}
          {carregando ? <Spinner label="Consultando configuração dos canais…" /> : dados && <Diagnostico dados={dados} />}
        </div>
      )}
    </div>
  );
}
