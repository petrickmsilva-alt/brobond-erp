-- ============================================================================
-- 0105 — SUPPLY CHAIN: DEVOLUÇÃO AO FORNECEDOR (rastreável, integrada)
--
-- POR QUE ESTA MIGRAÇÃO EXISTE
-- ----------------------------
-- O fluxo de compras já cobre requisição → cotação → pedido → aprovação →
-- recebimento (parcial/total) → entrada no estoque/custo → conta a pagar. O que
-- NÃO existia era a operação inversa: devolver mercadoria ao fornecedor por
-- avaria, divergência de qualidade, compra errada ou recall — retirando do
-- estoque VENDÁVEL e abastecendo a trilha de suprimentos.
--
-- Esta migração adiciona o DOCUMENTO de devolução ao fornecedor, com itens,
-- trilha de eventos e vínculo ao documento de compra de origem. Regras:
--
--   • Só se devolve o que foi EFETIVAMENTE RECEBIDO: o item referencia um
--     `item_compra` e a soma das devoluções ativas daquele item nunca ultrapassa
--     `itens_compra.quantidade_recebida` — garantido por trigger (o backstop de
--     banco) e pelo compare-and-swap do serviço (a garantia primária).
--   • O SALDO NÃO É TOCADO PELO DOCUMENTO. Quem movimenta estoque é a
--     movimentação oficial (`movimentacoes.tipo = 'saida'`, motivo explícito),
--     lançada uma única vez na expedição da devolução.
--   • Nada é apagado: CANCELADA é estado, não DELETE.
--   • Multiempresa: `empresa_id` NOT NULL em todas as tabelas; FK para o
--     documento de compra; nunca há devolução sem fornecedor e compra de
--     origem dentro da mesma empresa.
--
-- Estado: SOLICITADA → AUTORIZADA → EXPEDIDA → ENCERRADA (ou CANCELADA antes de
-- expedir, quando ainda não houve baixa de estoque).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) DOCUMENTO
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucoes_fornecedor (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  compra_id INTEGER NOT NULL REFERENCES compras(id),
  fornecedor_id INTEGER NOT NULL REFERENCES fornecedores(id),
  numero TEXT,
  status TEXT NOT NULL DEFAULT 'solicitada',
  motivo TEXT NOT NULL,
  observacoes TEXT,
  -- Local de onde a mercadoria sai (origem da baixa de estoque).
  local_origem_id INTEGER REFERENCES locais(id),
  local TEXT,
  -- Documento de compra que origina a devolução (rastreabilidade ponta a ponta).
  documento_origem TEXT,
  solicitante_id INTEGER REFERENCES usuarios(id),
  autorizador_id INTEGER REFERENCES usuarios(id),
  solicitada_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  autorizada_em TIMESTAMPTZ,
  expedida_em TIMESTAMPTZ,
  encerrada_em TIMESTAMPTZ,
  cancelada_em TIMESTAMPTZ,
  motivo_cancelamento TEXT,
  -- Chave de idempotência da criação (índice único parcial por empresa).
  idempotency_key TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT devolucoes_fornecedor_status_valido CHECK (status IN (
    'solicitada', 'autorizada', 'expedida', 'encerrada', 'cancelada'
  )),
  CONSTRAINT devolucoes_fornecedor_motivo_obrigatorio CHECK (TRIM(COALESCE(motivo, '')) <> ''),
  -- Autorizada exige carimbo de autorização; expedida/encerrada exigem
  -- autorização e expedição prévias (não existe saída "espontânea").
  CONSTRAINT devolucoes_fornecedor_status_coerente CHECK (
    (status <> 'autorizada' OR autorizada_em IS NOT NULL)
    AND (status NOT IN ('expedida', 'encerrada') OR (autorizada_em IS NOT NULL AND expedida_em IS NOT NULL))
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucoes_fornecedor_numero
  ON devolucoes_fornecedor (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucoes_fornecedor_idempotency
  ON devolucoes_fornecedor (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS devolucoes_fornecedor_empresa_status_idx
  ON devolucoes_fornecedor (empresa_id, status);
CREATE INDEX IF NOT EXISTS devolucoes_fornecedor_compra_idx
  ON devolucoes_fornecedor (empresa_id, compra_id);
CREATE INDEX IF NOT EXISTS devolucoes_fornecedor_fornecedor_idx
  ON devolucoes_fornecedor (empresa_id, fornecedor_id);

-- ----------------------------------------------------------------------------
-- 2) ITENS
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucao_fornecedor_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  devolucao_id INTEGER NOT NULL REFERENCES devolucoes_fornecedor(id) ON DELETE CASCADE,
  item_compra_id INTEGER NOT NULL REFERENCES itens_compra(id),
  insumo_id INTEGER REFERENCES insumos(id),
  produto_id INTEGER REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  custo_unitario NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Só vira TRUE quando a saída de estoque foi realmente lançada.
  estoque_baixado BOOLEAN NOT NULL DEFAULT FALSE,
  movimentacao_id INTEGER,
  movimentacao_insumo_id INTEGER,
  CONSTRAINT devolucao_fornecedor_itens_qtd_positiva CHECK (quantidade > 0),
  CONSTRAINT devolucao_fornecedor_itens_origem_check CHECK (insumo_id IS NOT NULL OR produto_id IS NOT NULL),
  CONSTRAINT devolucao_fornecedor_itens_custo_valido CHECK (custo_unitario >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucao_fornecedor_item
  ON devolucao_fornecedor_itens (devolucao_id, item_compra_id);
CREATE INDEX IF NOT EXISTS devolucao_fornecedor_itens_idx
  ON devolucao_fornecedor_itens (empresa_id, devolucao_id);
CREATE INDEX IF NOT EXISTS devolucao_fornecedor_itens_item_idx
  ON devolucao_fornecedor_itens (item_compra_id);

-- ----------------------------------------------------------------------------
-- 2b) FUNÇÕES DE APOIO + TRAVA DE DEFESA EM PROFUNDIDADE
--
-- A garantia primária contra excesso é o compare-and-swap na transação do
-- serviço (sob lock de domínio). O backstop é um TRIGGER, não um CHECK: um
-- CHECK com função agregada NÃO vê a própria linha que está sendo inserida
-- (o agregado roda sobre o snapshot da tabela, sem o NEW), então
-- `soma(itens) <= recebido` nunca disparava. O trigger soma explicitamente
-- NEW.quantidade às demais linhas ativas e recusa com SQLSTATE 23514.
-- ----------------------------------------------------------------------------

-- Quantidade já devolvida (em devoluções ativas) de um item de compra.
CREATE OR REPLACE FUNCTION brobond_qtd_devolvida_fornecedor_item(item_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(dfi.quantidade), 0)
  FROM devolucao_fornecedor_itens dfi
  JOIN devolucoes_fornecedor df ON df.id = dfi.devolucao_id
  WHERE dfi.item_compra_id = item_id AND df.status <> 'cancelada';
$$ LANGUAGE sql STABLE;

-- Quantidade efetivamente recebida do item de compra (coluna materializada).
CREATE OR REPLACE FUNCTION brobond_recebido_item_compra(item_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE((SELECT quantidade_recebida FROM itens_compra WHERE id = item_id), 0);
$$ LANGUAGE sql STABLE;

-- Backstop: recusa item cuja quantidade (somada às demais devoluções ativas do
-- mesmo item de compra) ultrapassa o recebido. `NEW.id` é excluído do somatório
-- para que a própria linha em UPDATE não conte duas vezes.
CREATE OR REPLACE FUNCTION brobond_validar_devolucao_fornecedor_item()
RETURNS TRIGGER AS $$
DECLARE
  recebido NUMERIC;
  ja_devolvido NUMERIC;
BEGIN
  SELECT COALESCE(quantidade_recebida, 0) INTO recebido FROM itens_compra WHERE id = NEW.item_compra_id;
  SELECT COALESCE(SUM(dfi.quantidade), 0) INTO ja_devolvido
    FROM devolucao_fornecedor_itens dfi
    JOIN devolucoes_fornecedor df ON df.id = dfi.devolucao_id
   WHERE dfi.item_compra_id = NEW.item_compra_id
     AND df.status <> 'cancelada'
     AND dfi.id <> COALESCE(NEW.id, -1);
  IF ja_devolvido + NEW.quantidade > recebido THEN
    RAISE EXCEPTION 'Devolução ao fornecedor excede o recebido do item % (recebido %, já devolvido %)',
      NEW.item_compra_id, recebido, ja_devolvido USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS devolucao_fornecedor_itens_limite ON devolucao_fornecedor_itens;
CREATE TRIGGER devolucao_fornecedor_itens_limite
  BEFORE INSERT OR UPDATE OF item_compra_id, quantidade, devolucao_id ON devolucao_fornecedor_itens
  FOR EACH ROW EXECUTE FUNCTION brobond_validar_devolucao_fornecedor_item();

-- Remove o CHECK antigo (que nunca disparava) em bases que já aplicaram a versão
-- anterior desta migração. Idempotente e sem perda de dados.
ALTER TABLE devolucao_fornecedor_itens DROP CONSTRAINT IF EXISTS devolucao_fornecedor_itens_nao_excede_recebido;

-- ----------------------------------------------------------------------------
-- 3) TRILHA DE EVENTOS (imutável, cronológica)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucao_fornecedor_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  devolucao_id INTEGER NOT NULL REFERENCES devolucoes_fornecedor(id) ON DELETE CASCADE,
  status_anterior TEXT,
  status_novo TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  observacao TEXT,
  dados JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devolucao_fornecedor_eventos_idx
  ON devolucao_fornecedor_eventos (empresa_id, devolucao_id, criado_em DESC);

-- Vincula a movimentação de saída à devolução (rastreabilidade da baixa).
ALTER TABLE movimentacoes ADD COLUMN IF NOT EXISTS devolucao_fornecedor_id INTEGER;
ALTER TABLE movimentacoes_insumos ADD COLUMN IF NOT EXISTS devolucao_fornecedor_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_movimentacoes_devolucao_fornecedor
  ON movimentacoes (devolucao_fornecedor_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_insumos_devolucao_fornecedor
  ON movimentacoes_insumos (devolucao_fornecedor_id);
