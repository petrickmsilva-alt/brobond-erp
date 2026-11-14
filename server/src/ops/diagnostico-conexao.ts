// ============================================================================
// DIAGNÓSTICO DE CONEXÃO — identificação SOMENTE LEITURA do banco publicado.
//
// Objetivo: provar de qual banco a credencial fala ANTES de qualquer ato
// operacional. Este módulo NUNCA escreve: a sessão inteira roda em transação
// `READ ONLY` e as consultas são apenas `SELECT`, `pg_catalog` e
// `current_setting` — não há `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `DROP`,
// DDL, migração nem saneamento.
//
// A identificação de destino é FECHADA (fail-closed): sem sinal suficiente para
// confirmar que o alvo é a branch de produção do projeto no Neon, o diagnóstico
// REPROVA e o chamador interrompe.
//
// Sinais lidos (todos somente leitura):
//   • current_database(), current_user, current_schema(), version(), now();
//   • pg_stat_ssl (prova que a conexão cifrou);
//   • `neon.project_id`, `neon.branch_id`, `neon.branch_name`,
//     `neon.endpoint_id`, `neon.timeline_id` — GUCs publicadas pelo Neon no
//     servidor (`neon.project_id`/`neon.branch_id`/`neon.endpoint_id`/
//     `neon.timeline_id` definidas em `pgxn/neon/libpagestore.c`). A leitura usa
//     `missing_ok = true`: fora do Neon o valor é NULL, nunca erro.
//   • existência de tabelas-marcador do ERP (impressão digital do schema).
//
// Nenhuma credencial é lida nem devolvida: `identificacaoOrigem` guarda só
// host:porta/banco.
// ============================================================================
import type { Pool } from 'pg';
import { identificacaoOrigem } from './backup-verificacao';

/** Sufixo de host do Neon. Um destino que não case aqui NÃO é confirmado. */
export const SUFIXO_HOST_NEON = '.neon.tech';

/** Tabela-marcador padrão do ERP (existe desde as primeiras migrações). */
export const MARCADOR_PADRAO = 'empresas';

export interface EsperadoDestino {
  /** Id do projeto Neon esperado (`neon.project_id`). Vazio = não conferido. */
  projetoId?: string | null;
  /** Nome da branch esperado (`neon.branch_name`). Padrão: `production`. */
  branchNome?: string | null;
  /** Id da branch esperado (`neon.branch_id`). Alternativa quando o nome não existe. */
  branchId?: string | null;
  /** Tabela que precisa existir no schema corrente (impressão digital do ERP). */
  marcador?: string | null;
  /** Sufixo de host que confirma o Neon (default `SUFIXO_HOST_NEON`). */
  hostSufixo?: string;
}

export interface NeonIdentidade {
  projetoId: string | null;
  branchId: string | null;
  branchNome: string | null;
  endpointId: string | null;
  timelineId: string | null;
}

export interface IdentidadeConexao {
  /** host:porta/banco — NUNCA usuário, senha ou query string. */
  origem: string;
  host: string;
  banco: string;
  usuario: string;
  schema: string;
  versao: string;
  agora: string;
  ssl: boolean | null;
  neon: NeonIdentidade;
  /** O schema tem o histórico versionado de migrações do ERP. */
  migracoesPresentes: boolean;
  /** A tabela-marcador do ERP existe no schema corrente. */
  marcadorPresente: boolean;
}

export interface Verificacao {
  nome: string;
  ok: boolean;
  detalhe: string;
}

export interface ResultadoDestino {
  ok: boolean;
  verificacoes: Verificacao[];
}

const limpo = (v: unknown): string | null => {
  if (v instanceof Date) return v.toISOString();
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s : null;
};

const semAcento = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
};

/**
 * Decide se o destino observado corresponde ao esperado. Regra FECHADA: um
 * sinal ausente reprova, nunca aprova por omissão.
 */
export function avaliarDestino(id: IdentidadeConexao, esperado: EsperadoDestino = {}): ResultadoDestino {
  const sufixo = esperado.hostSufixo ?? SUFIXO_HOST_NEON;
  const projetoEsperado = limpo(esperado.projetoId);
  const branchNomeEsperado = limpo(esperado.branchNome) ?? 'production';
  const branchIdEsperado = limpo(esperado.branchId);
  const marcador = limpo(esperado.marcador) ?? MARCADOR_PADRAO;

  const verificacoes: Verificacao[] = [];

  const ehNeon = id.host.toLowerCase().endsWith(sufixo.toLowerCase());
  verificacoes.push({
    nome: 'host-neon',
    ok: ehNeon,
    detalhe: ehNeon ? `host ${id.host} termina em ${sufixo}` : `host ${id.host} não termina em ${sufixo} — não é o Neon`,
  });

  const projetoPresente = !!limpo(id.neon.projetoId);
  const projetoOk = projetoPresente && (!projetoEsperado || id.neon.projetoId === projetoEsperado);
  verificacoes.push({
    nome: 'projeto-neon',
    ok: projetoOk,
    detalhe: !projetoPresente
      ? 'neon.project_id ausente — o servidor não declarou projeto Neon'
      : projetoEsperado && id.neon.projetoId !== projetoEsperado
        ? `neon.project_id=${id.neon.projetoId} difere do esperado ${projetoEsperado}`
        : `neon.project_id=${id.neon.projetoId}${projetoEsperado ? ' (confere)' : ' (sem valor esperado)'}`,
  });

  const nomeObservado = limpo(id.neon.branchNome);
  const idObservado = limpo(id.neon.branchId);
  let branchOk: boolean;
  let branchDetalhe: string;
  if (nomeObservado) {
    branchOk = nomeObservado === branchNomeEsperado && (!branchIdEsperado || !idObservado || idObservado === branchIdEsperado);
    branchDetalhe =
      nomeObservado === branchNomeEsperado
        ? `neon.branch_name=${nomeObservado} confere com ${branchNomeEsperado}`
        : `neon.branch_name=${nomeObservado} difere da branch esperada ${branchNomeEsperado}`;
  } else if (branchIdEsperado && idObservado) {
    branchOk = idObservado === branchIdEsperado;
    branchDetalhe = branchOk
      ? `neon.branch_id=${idObservado} confere com o esperado`
      : `neon.branch_id=${idObservado} difere do esperado ${branchIdEsperado}`;
  } else {
    branchOk = false;
    branchDetalhe =
      'branch não confirmável: o servidor não expôs neon.branch_name e nenhum neon.branch_id esperado foi informado';
  }
  verificacoes.push({ nome: 'branch-confirmada', ok: branchOk, detalhe: branchDetalhe });

  verificacoes.push({
    nome: 'schema-erp',
    ok: id.marcadorPresente,
    detalhe: id.marcadorPresente
      ? `tabela-marcador "${marcador}" presente`
      : `tabela-marcador "${marcador}" ausente — o schema não parece ser o do ERP`,
  });

  return { ok: verificacoes.every((v) => v.ok), verificacoes };
}

/** Linha crua devolvida pela consulta de identificação. */
interface LinhaIdentidade {
  banco: string;
  usuario: string;
  schema: string;
  versao: string;
  agora: string;
  ssl: boolean | null;
  neon_projeto_id: string | null;
  neon_branch_id: string | null;
  neon_branch_nome: string | null;
  neon_endpoint_id: string | null;
  neon_timeline_id: string | null;
  migracoes_presentes: boolean;
  marcador_presente: boolean;
}

const CONSULTA_IDENTIDADE = `
  SELECT
    current_database() AS banco,
    current_user AS usuario,
    current_schema() AS schema,
    version() AS versao,
    now() AS agora,
    (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS ssl,
    current_setting('neon.project_id', true) AS neon_projeto_id,
    current_setting('neon.branch_id', true) AS neon_branch_id,
    current_setting('neon.branch_name', true) AS neon_branch_nome,
    current_setting('neon.endpoint_id', true) AS neon_endpoint_id,
    current_setting('neon.timeline_id', true) AS neon_timeline_id,
    to_regclass('schema_migrations') IS NOT NULL AS migracoes_presentes,
    to_regclass($1) IS NOT NULL AS marcador_presente
`;

export interface OpcoesColeta {
  url: string;
  marcador?: string;
  /** Limite de tempo de cada consulta (ms). */
  timeoutMs?: number;
}

/**
 * Abre a conexão, roda a identificação numa transação `READ ONLY` e a encerra
 * com `ROLLBACK`. O `ROLLBACK` é explícito: mesmo que algo tente escrever, a
 * transação somente leitura recusa e nada persiste.
 */
export async function coletarIdentidade(pool: Pool, opts: OpcoesColeta): Promise<IdentidadeConexao> {
  const marcador = limpo(opts.marcador) ?? MARCADOR_PADRAO;
  const client = await pool.connect();
  try {
    await client.query(`SET statement_timeout = ${Number(opts.timeoutMs ?? 15_000)}`);
    await client.query('BEGIN READ ONLY');
    try {
      const { rows } = await client.query<LinhaIdentidade>(CONSULTA_IDENTIDADE, [marcador]);
      const r = rows[0];
      const host = new URL(opts.url).hostname;
      return {
        origem: identificacaoOrigem(opts.url),
        host,
        banco: semAcento(r.banco),
        usuario: semAcento(r.usuario),
        schema: semAcento(r.schema),
        versao: semAcento(r.versao),
        agora: semAcento(r.agora),
        ssl: r.ssl ?? null,
        neon: {
          projetoId: limpo(r.neon_projeto_id),
          branchId: limpo(r.neon_branch_id),
          branchNome: limpo(r.neon_branch_nome),
          endpointId: limpo(r.neon_endpoint_id),
          timelineId: limpo(r.neon_timeline_id),
        },
        migracoesPresentes: r.migracoes_presentes === true,
        marcadorPresente: r.marcador_presente === true,
      };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  } finally {
    client.release();
  }
}
