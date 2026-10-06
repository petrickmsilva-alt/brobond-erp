// ============================================================
// Documentação OpenAPI 3.0 — gerada automaticamente a partir dos recursos.
//
// GET /api/docs/openapi.json — JSON OpenAPI completo
// GET /api/docs              — Swagger UI (HTML)
//
// Lê os recursos definidos em resources.ts e gera endpoints documentados.
// ============================================================
import type { Request, Response } from 'express';
import { publicMeta } from './resources';
import { VERSION } from './index';

function generateOpenAPISpec() {
  const meta = publicMeta();
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

  // Auth
  paths['/api/auth/login'] = {
    post: {
      tags: ['Auth'],
      summary: 'Login no sistema',
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, lembrar: { type: 'boolean' } }, required: ['email', 'password'] } } } },
      responses: { '200': { description: 'Token JWT + dados do usuário' }, '401': { description: 'Credenciais inválidas' }, '429': { description: 'Muitas tentativas' } },
    },
  };
  paths['/api/auth/me'] = { get: { tags: ['Auth'], summary: 'Dados do usuário autenticado', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } };
  paths['/api/auth/forgot'] = { post: { tags: ['Auth'], summary: 'Esqueci minha senha', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' } } } } } }, responses: { '200': { description: 'E-mail enviado' } } } };
  paths['/api/auth/login/mfa'] = { post: { tags: ['Auth'], summary: 'Conclui o login com o código TOTP', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { mfa_ticket: { type: 'string' }, codigo: { type: 'string' } }, required: ['mfa_ticket', 'codigo'] } } } }, responses: { '200': { description: 'Token JWT + usuário' }, '401': { description: 'Código inválido' }, '429': { description: 'Muitas tentativas de código' } } } };
  paths['/api/convites/{token}'] = { get: { tags: ['Auth'], summary: 'Valida convite de acesso', parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Dados do convite' }, '404': { description: 'Convite inválido' } } } };
  paths['/api/convites/aceitar'] = { post: { tags: ['Auth'], summary: 'Aceita convite definindo a própria senha', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, senha: { type: 'string' } }, required: ['token', 'senha'] } } } }, responses: { '200': { description: 'Senha definida' }, '400': { description: 'Convite inválido/expirado ou senha fora da política' } } } };
  paths['/api/auth/reautenticar'] = { post: { tags: ['Auth'], summary: 'Reautenticação (step-up) para ações sensíveis', security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { senha: { type: 'string' } }, required: ['senha'] } } } }, responses: { '200': { description: 'Autorizado por 5 minutos' }, '401': { description: 'Senha incorreta' } } } };
  paths['/api/auth/sessoes'] = { get: { tags: ['Auth'], summary: 'Sessões ativas do usuário', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Lista de sessões' } } } };
  paths['/api/auth/mfa/status'] = { get: { tags: ['Auth'], summary: 'Status do MFA do usuário', security: [{ bearerAuth: [] }], responses: { '200': { description: 'OK' } } } };
  paths['/api/auth/mfa/setup'] = { post: { tags: ['Auth'], summary: 'Gera segredo/QR do TOTP', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Segredo + QR (Cache-Control: no-store)' } } } };
  paths['/api/auth/mfa/ativar'] = { post: { tags: ['Auth'], summary: 'Ativa o MFA com o código', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Ativado' }, '400': { description: 'Código inválido' } } } };
  paths['/api/auth/mfa/desativar'] = { post: { tags: ['Auth'], summary: 'Desativa o MFA (exige reautenticação + código)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Desativado' }, '400': { description: 'Código inválido' }, '403': { description: 'Reautenticação necessária' } } } };
  paths['/api/usuarios/{id}/senha-temporaria'] = { post: { tags: ['Auth'], summary: 'Gera senha temporária (exibição única; admin + reautenticação)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Senha temporária exibida uma única vez' }, '403': { description: 'Reautenticação necessária' } } } };
  paths['/api/admin/auditoria/verificar'] = { get: { tags: ['Auth'], summary: 'Verifica a cadeia de hashes da auditoria', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Resultado da verificação' } } } };

  // Dashboard
  paths['/api/dashboard'] = { get: { tags: ['Dashboard'], summary: 'KPIs e gráficos do Dashboard', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Dados do dashboard' } } } };

  // CRUD genérico por recurso
  for (const [key, resource] of Object.entries(meta)) {
    const tag = resource.label;
    const base = `/api/${key}`;

    // Schema
    const properties: Record<string, any> = { id: { type: 'integer' } };
    for (const field of resource.fields) {
      if (field.virtual) continue;
      const typeMap: Record<string, string> = { text: 'string', textarea: 'string', email: 'string', phone: 'string', document: 'string', integer: 'integer', number: 'number', money: 'number', percent: 'number', boolean: 'boolean', date: 'string', datetime: 'string', select: 'string', ref: 'integer', multiref: 'array', password: 'string', color: 'string' };
      properties[field.name] = { type: typeMap[field.type] || 'string', description: field.label };
    }
    schemas[key] = { type: 'object', properties };

    // List
    paths[base] = {
      get: { tags: [tag], summary: `Listar ${resource.label}`, security: [{ bearerAuth: [] }], parameters: [{ name: 'page', in: 'query', schema: { type: 'integer' } }, { name: 'pageSize', in: 'query', schema: { type: 'integer' } }, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'sort', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: `Lista de ${resource.label}` } } },
      ...(resource.ops.create ? { post: { tags: [tag], summary: `Criar ${resource.singular}`, security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${key}` } } } }, responses: { '201': { description: 'Criado' } } } } : {}),
    };

    // Get/Update/Delete by ID
    paths[`${base}/{id}`] = {
      get: { tags: [tag], summary: `Obter ${resource.singular}`, security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Não encontrado' } } },
      ...(resource.ops.update ? { put: { tags: [tag], summary: `Atualizar ${resource.singular}`, security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${key}` } } } }, responses: { '200': { description: 'Atualizado' } } } } : {}),
      ...(resource.ops.delete ? { delete: { tags: [tag], summary: `Excluir ${resource.singular}`, security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Excluído' } } } } : {}),
    };
  }

  // Endpoints especiais
  paths['/api/produtos/{id}/tamanhos'] = { get: { tags: ['Produtos'], summary: 'Tamanhos da grade efetiva do produto (grade do produto, senão da categoria)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } };
  paths['/api/produtos/{id}/detalhe'] = { get: { tags: ['Produtos'], summary: 'Detalhe completo do produto (grade, movimentações, OPs, ficha)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } };
  paths['/api/produtos/{id}/qrcode'] = { get: { tags: ['Produtos'], summary: 'QR Code do produto (PNG)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'size', in: 'query', schema: { type: 'integer', default: 300 } }], responses: { '200': { description: 'Imagem PNG', content: { 'image/png': {} } } } } };
  paths['/api/vendas/{id}/pdf'] = { get: { tags: ['Vendas'], summary: 'PDF do pedido de venda', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'PDF', content: { 'application/pdf': {} } } } } };
  paths['/api/compras/{id}/pdf'] = { get: { tags: ['Compras'], summary: 'PDF do pedido de compra', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'PDF', content: { 'application/pdf': {} } } } } };
  paths['/api/predicao/demanda'] = { get: { tags: ['Previsão IA'], summary: 'Previsão de demanda por produto', security: [{ bearerAuth: [] }], parameters: [{ name: 'dias', in: 'query', schema: { type: 'integer', default: 30 } }], responses: { '200': { description: 'Previsões' } } } };
  paths['/api/aprovacoes'] = { get: { tags: ['Aprovações'], summary: 'Fila de aprovação de pedidos', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Pedidos pendentes' } } } };

  // 1. MEU NEGÓCIOS — motor analítico (margem por pedido, curva ABC, BI)
  const filtrosBi = [
    { name: 'de', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Início do período (AAAA-MM-DD, inclusivo)' },
    { name: 'ate', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Fim do período (AAAA-MM-DD, inclusivo)' },
    { name: 'empresa_id', in: 'query', schema: { type: 'integer' }, description: 'Empresa (multi-empresa)' },
    { name: 'canal', in: 'query', schema: { type: 'string', enum: ['LOJA_FISICA', 'BROBOND', 'NUVEMSHOP', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO', 'MERCADOLIVRE', 'loja_fisica', 'ecommerce', 'marketplace'] }, description: 'Canal específico ou grupo (loja_fisica, ecommerce, marketplace)' },
    { name: 'status', in: 'query', schema: { type: 'string', enum: ['PAID', 'PENDING', 'CANCELED', 'REFUNDED'] } },
  ];
  paths['/api/negocios/canais'] = { get: { tags: ['Meu Negócio'], summary: 'Mapa de canais de venda (Loja Física, E-commerce, Marketplaces)', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Grupos e canais' } } } };
  paths['/api/negocios/resumo'] = { get: { tags: ['Meu Negócio'], summary: 'Dashboard de BI: KPIs, faturamento por canal/mês/status e top produtos (só PAID fatura)', security: [{ bearerAuth: [] }], parameters: filtrosBi, responses: { '200': { description: 'Agregados do período' }, '400': { description: 'Filtro inválido' } } } };
  paths['/api/negocios/margens'] = { get: { tags: ['Meu Negócio'], summary: 'Margem por pedido: líquido, CMV, impostos, frete, lucro bruto e margem % (gerente/admin)', security: [{ bearerAuth: [] }], parameters: [...filtrosBi, { name: 'classe', in: 'query', schema: { type: 'string', enum: ['A', 'B', 'C'] } }], responses: { '200': { description: 'Pedidos com margem materializada' } } } };
  paths['/api/negocios/margens/recalcular'] = { post: { tags: ['Meu Negócio'], summary: 'Recalcula o lucro bruto e a margem de todos os pedidos no filtro (gerente/admin)', security: [{ bearerAuth: [] }], parameters: filtrosBi, responses: { '200': { description: 'Pedidos recalculados' } } } };
  paths['/api/negocios/abc'] = { get: { tags: ['Meu Negócio'], summary: 'Curva ABC por faturamento acumulado (A=80%, B=15%, C=5%)', security: [{ bearerAuth: [] }], parameters: [...filtrosBi, { name: 'classe', in: 'query', schema: { type: 'string', enum: ['A', 'B', 'C'] } }], responses: { '200': { description: 'Classificação por produto' } } } };
  paths['/api/negocios/abc/recalcular'] = { post: { tags: ['Meu Negócio'], summary: 'Reclassifica a curva ABC (opcionalmente com janela De/Até; gerente/admin)', security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { de: { type: 'string', format: 'date' }, ate: { type: 'string', format: 'date' } } } } } }, responses: { '200': { description: 'Produtos classificados' } } } };
  paths['/api/negocios/vendas'] = { post: { tags: ['Meu Negócio'], summary: 'Registra venda manual (Loja Física e checkouts) com margem calculada na hora', security: [{ bearerAuth: [] }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['itens'], properties: { canal: { type: 'string', enum: ['LOJA_FISICA', 'BROBOND', 'NUVEMSHOP', 'INSTAGRAM_SHOPPING', 'MERCADOPAGO', 'MERCADOLIVRE'] }, status: { type: 'string', enum: ['PAID', 'PENDING'] }, occurred_at: { type: 'string', description: 'AAAA-MM-DD ou ISO 8601' }, freight_cents: { type: 'integer', minimum: 0 }, empresa_id: { type: 'integer' }, currency: { type: 'string' }, itens: { type: 'array', minItems: 1, items: { type: 'object', required: ['product_id', 'unit_price_cents'], properties: { product_id: { type: 'integer' }, size_id: { type: 'integer' }, quantity: { type: 'integer', minimum: 1 }, unit_price_cents: { type: 'integer', minimum: 0 }, discount_cents: { type: 'integer', minimum: 0 } } } } } } } } }, responses: { '201': { description: 'Venda criada com margem e curva ABC atualizadas' }, '400': { description: 'Payload inválido' } } } };

  return {
    openapi: '3.0.3',
    info: { title: 'BROBOND ERP API', version: VERSION, description: 'API do sistema de gestão BROBOND — estoque, produção, compras, vendas, qualidade e previsões.', contact: { email: 'admin@brobond.com.br' } },
    servers: [{ url: '/api', description: 'API' }],
    paths,
    components: {
      schemas,
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    },
  };
}

function swaggerUI(): string {
  return `<!DOCTYPE html>
<html><head><title>BROBOND ERP — API Docs</title>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css"/>
</head><body><div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/api/docs/openapi.json',dom_id:'#swagger-ui',deepLinking:true,presets:[SwaggerUIBundle.presets.apis]})</script>
</body></html>`;
}

export function openapiJSON(_req: Request, res: Response) {
  res.json(generateOpenAPISpec());
}

export function openapiUI(_req: Request, res: Response) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(swaggerUI());
}
