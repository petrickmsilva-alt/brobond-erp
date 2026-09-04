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
      const typeMap: Record<string, string> = { text: 'string', textarea: 'string', email: 'string', phone: 'string', document: 'string', integer: 'integer', number: 'number', money: 'number', percent: 'number', boolean: 'boolean', date: 'string', datetime: 'string', select: 'string', ref: 'integer', password: 'string', color: 'string' };
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
  paths['/api/produtos/{id}/detalhe'] = { get: { tags: ['Produtos'], summary: 'Detalhe completo do produto (grade, movimentações, OPs, ficha)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'OK' } } } };
  paths['/api/produtos/{id}/qrcode'] = { get: { tags: ['Produtos'], summary: 'QR Code do produto (PNG)', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }, { name: 'size', in: 'query', schema: { type: 'integer', default: 300 } }], responses: { '200': { description: 'Imagem PNG', content: { 'image/png': {} } } } } };
  paths['/api/vendas/{id}/pdf'] = { get: { tags: ['Vendas'], summary: 'PDF do pedido de venda', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'PDF', content: { 'application/pdf': {} } } } } };
  paths['/api/compras/{id}/pdf'] = { get: { tags: ['Compras'], summary: 'PDF do pedido de compra', security: [{ bearerAuth: [] }], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'PDF', content: { 'application/pdf': {} } } } } };
  paths['/api/predicao/demanda'] = { get: { tags: ['Previsão IA'], summary: 'Previsão de demanda por produto', security: [{ bearerAuth: [] }], parameters: [{ name: 'dias', in: 'query', schema: { type: 'integer', default: 30 } }], responses: { '200': { description: 'Previsões' } } } };
  paths['/api/aprovacoes'] = { get: { tags: ['Aprovações'], summary: 'Fila de aprovação de pedidos', security: [{ bearerAuth: [] }], responses: { '200': { description: 'Pedidos pendentes' } } } };

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
