-- Fase 3A: motor de políticas comerciais sazonais e hierárquicas.
CREATE TABLE IF NOT EXISTS politicas_comerciais (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  escopo TEXT NOT NULL DEFAULT 'geral' CHECK (escopo IN ('geral','canal','colecao','catalogo','cliente')),
  canal TEXT CHECK (canal IS NULL OR canal IN ('varejo','atacado','todos')),
  colecao_id INTEGER REFERENCES colecoes(id) ON DELETE CASCADE,
  catalogo_id INTEGER REFERENCES catalogos(id) ON DELETE CASCADE,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE CASCADE,
  inicio_em DATE,
  fim_em DATE,
  prioridade INTEGER NOT NULL DEFAULT 0,
  desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (desconto_pct BETWEEN 0 AND 100),
  pedido_min_valor NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pedido_min_valor >= 0),
  pedido_min_pecas INTEGER NOT NULL DEFAULT 0 CHECK (pedido_min_pecas >= 0),
  produto_min_qtd INTEGER NOT NULL DEFAULT 0 CHECK (produto_min_qtd >= 0),
  multiplo_qtd INTEGER NOT NULL DEFAULT 1 CHECK (multiplo_qtd >= 1),
  reserva_horas INTEGER NOT NULL DEFAULT 0 CHECK (reserva_horas >= 0),
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_politicas_vigencia ON politicas_comerciais(ativo, inicio_em, fim_em);
CREATE INDEX IF NOT EXISTS idx_politicas_contexto ON politicas_comerciais(escopo, catalogo_id, colecao_id, cliente_id, canal);
