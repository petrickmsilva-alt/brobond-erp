// ============================================================================
// OPERATIONAL CONTROL › MCP › SERVIDOR (JSON-RPC 2.0 sobre HTTP)
//
// Monta o Remote MCP Server. O transporte é HTTP POST com JSON-RPC 2.0
// ("Streamable HTTP"): `initialize`, `notifications/initialized`, `ping`,
// `tools/list` e `tools/call`. NÃO há ferramenta genérica.
//
// Fluxo de cada chamada:
//   1. `autenticarMcp` valida o Bearer OAuth (RS256, audience) → ator;
//   2. rate limit por ator;
//   3. `tools/list`/`tools/call` aplicam a MESMA `exigirAutorizacao` do Control
//      Plane (escopo OAuth ∩ perfil ∩ política). A negação é devolvida como
//      resultado de ferramenta com `isError: true` (convenção MCP) e auditada.
//
// O MCP NUNCA acessa o banco diretamente por ferramenta, nunca executa shell e
// nunca aceita identidade vinda do cliente.
// ============================================================================
import { type NextFunction, type Request, type Response, Router } from 'express';
import { limitarOperacao } from '../infrastructure/rate-limit';
import { auditarOperacao } from '../infrastructure/audit';
import { OperationalError } from '../domain/errors';
import { autenticarMcp, atorMcp } from './auth';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  RPC,
  lerRequisicao,
  respostaErro,
  respostaOk,
  conteudoTexto,
  type RpcId,
} from './protocol';
import { ferramentaPorNome, ferramentasAutorizadas } from './tools';

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};
const wrapMw = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/** Instruções de uso enviadas ao cliente (deixam claro o limite de ação). */
const INSTRUCOES =
  'Servidor de controle operacional do Brobond ERP. Somente leitura e solicitação: as ferramentas de leitura consultam o estado; a de solicitação cria uma operação que exige APROVAÇÃO HUMANA no ERP. Não há execução de comandos, SQL, shell ou deploy.';

export const mcpRouter: Router = Router();

// Streamable HTTP: só POST. Um GET (SSE) não é oferecido — responde 405.
mcpRouter.get('/mcp', (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json(respostaErro(null, { code: RPC.invalidRequest, message: 'Use POST para o transporte JSON-RPC.' }));
});

// Corpo JSON inválido: o parser do Express lança antes do handler — convertemos
// em erro JSON-RPC (nunca vaza stack).
mcpRouter.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  const semCorpo = err instanceof SyntaxError || (err as { type?: string })?.type === 'entity.parse.failed';
  if (!semCorpo) return next(err);
  if (req.path !== '/mcp') return next(err);
  res.status(200).json(respostaErro(null, { code: RPC.parseError, message: 'Corpo JSON inválido.' }));
});

// Toda a superfície exige o Bearer OAuth do MCP.
mcpRouter.post('/mcp', wrapMw(autenticarMcp), wrap(async (req, res) => {
  const actor = atorMcp(req);
  await limitarOperacao(`mcp|${actor.id}`);

  const lida = lerRequisicao(req.body);
  if (!lida.ok) {
    res.status(200).json(respostaErro(lida.id, lida.erro));
    return;
  }
  const { req: rpc, notificacao } = lida;

  // Notificações não têm resposta.
  if (notificacao && rpc.method.startsWith('notifications/')) {
    res.status(202).end();
    return;
  }

  const id: RpcId = rpc.id;

  switch (rpc.method) {
    case 'initialize': {
      res.status(200).json(
        respostaOk(id, {
          protocolVersion: String(rpc.params?.protocolVersion ?? MCP_PROTOCOL_VERSION),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
          instructions: INSTRUCOES,
        })
      );
      return;
    }
    case 'ping': {
      res.status(200).json(respostaOk(id, {}));
      return;
    }
    case 'tools/list': {
      const ferramentas = ferramentasAutorizadas(actor).map((f) => ({ name: f.name, title: f.title, description: f.description, inputSchema: f.inputSchema }));
      res.status(200).json(respostaOk(id, { tools: ferramentas }));
      return;
    }
    case 'tools/call': {
      const nome = String(rpc.params?.name ?? '');
      const args = rpc.params?.arguments && typeof rpc.params.arguments === 'object' ? (rpc.params.arguments as Record<string, unknown>) : {};
      const ferramenta = ferramentaPorNome(nome);
      if (!ferramenta) {
        res.status(200).json(respostaOk(id, conteudoTexto({ error: `Ferramenta desconhecida: ${nome}` }, true)));
        return;
      }
      try {
        // Autorização: MESMA política do Control Plane. Nenhuma ferramenta
        // contorna o RBAC; sem escopo/perfil, é negada.
        if (ferramenta.acao) {
          const { exigirAutorizacao } = await import('../policies/authorization-policy');
          exigirAutorizacao(actor, ferramenta.acao);
        }
        const resultado = await ferramenta.handler({ actor, args });
        res.status(200).json(respostaOk(id, conteudoTexto(resultado)));
      } catch (e) {
        const mensagem = e instanceof OperationalError ? e.message : 'Falha ao executar a ferramenta.';
        await auditarOperacao({
          empresaId: actor.empresa_id,
          actorId: actor.id,
          eventType: 'access.denied',
          payload: { ferramenta: nome, motivo: e instanceof OperationalError ? e.code : 'erro' },
        }).catch(() => {});
        // Negação/validação: resultado de ferramenta com isError (convenção MCP).
        res.status(200).json(respostaOk(id, conteudoTexto({ error: mensagem, code: e instanceof OperationalError ? e.code : 'ERRO' }, true)));
      }
      return;
    }
    default: {
      res.status(200).json(respostaErro(id, { code: RPC.methodNotFound, message: `Método não suportado: ${rpc.method}` }));
      return;
    }
  }
}));

// Corpo JSON inválido: o parser do Express lança antes do handler — convertemos
// em erro JSON-RPC (nunca vaza stack).
mcpRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof OperationalError) {
    res.status(err.status).json({ ok: false, error: err.message, code: err.code, ...(err.fields ? { fields: err.fields } : {}) });
    return;
  }
  next(err);
});
