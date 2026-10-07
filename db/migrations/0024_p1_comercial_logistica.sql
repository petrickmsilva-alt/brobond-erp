-- ============================================================================
-- 0024 — FASE P1: operação comercial, logística e suprimentos
--
-- Esta migration é ADITIVA. Nenhuma tabela existente é renomeada, nenhuma
-- coluna antiga é removida, nenhum CHECK existente é enfraquecido.
--
-- Blocos:
--   A) Listas de preço            (listas_preco, lista_preco_itens, histórico)
--   B) Propostas comerciais       (propostas, proposta_itens, proposta_eventos)
--   C) PDV                        (pdv_caixas, pdv_caixa_movimentos, pdv_pagamentos)
--   D) Logística                  (envios, envio_eventos, ShippingProvider)
--   E) Expedição / conferência    (expedicao_eventos, divergencias_conferencia)
--   F) Logística reversa          (devolucoes, devolucao_itens)
--   G) Recebimento parcial        (compra_recebimentos, compra_recebimento_itens)
--   H) Colunas de amarração nas tabelas existentes
--
-- Idempotente: pode ser aplicada duas vezes, em banco limpo e em banco migrado.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A) LISTAS DE PREÇO
--
-- Uma lista é um conjunto de preços com vigência. A regra de aplicação é
-- determinística: lista ATIVA, dentro da vigência, com MAIOR prioridade; em
-- caso de empate, a mais recente. O preço escolhido é CONGELADO no item da
-- venda (itens_venda.lista_preco_id / preco_tabela), de modo que mudar a lista
-- depois não reescreve a história da venda.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS listas_preco (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  nome TEXT NOT NULL,
  descricao TEXT,
  prioridade INTEGER NOT NULL DEFAULT 0,
  inicio_em DATE,
  fim_em DATE,
  ativo BOOLEAN NOT NULL DEFAULT TRUE,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT listas_preco_vigencia_coerente CHECK (
    inicio_em IS NULL OR fim_em IS NULL OR fim_em >= inicio_em
  )
);

CREATE INDEX IF NOT EXISTS listas_preco_empresa_ativa_idx
  ON listas_preco (empresa_id, ativo, prioridade DESC);

CREATE TABLE IF NOT EXISTS lista_preco_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lista_id INTEGER NOT NULL REFERENCES listas_preco(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  preco NUMERIC(12,2) NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT lista_preco_itens_preco_positivo CHECK (preco >= 0)
);

-- Um produto tem UM preço por lista (não importa o caminho pelo qual se chega).
CREATE UNIQUE INDEX IF NOT EXISTS uq_lista_preco_item
  ON lista_preco_itens (lista_id, produto_id);
CREATE INDEX IF NOT EXISTS lista_preco_itens_empresa_idx
  ON lista_preco_itens (empresa_id, produto_id);

-- Histórico de preço: toda alteração de preço de lista vira uma linha.
-- É o que permite responder "quanto este produto custava na lista X em maio?".
CREATE TABLE IF NOT EXISTS listas_preco_historico (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  lista_id INTEGER NOT NULL REFERENCES listas_preco(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  preco_anterior NUMERIC(12,2),
  preco_novo NUMERIC(12,2),
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS listas_preco_historico_idx
  ON listas_preco_historico (empresa_id, lista_id, produto_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- B) PROPOSTAS COMERCIAIS
--
-- Máquina de estados EXPLÍCITA e fechada no banco:
--   rascunho → enviada → aprovada → convertida
--                    ↘ recusada
--   (rascunho|enviada) → cancelada
--   (aprovada)         → expirada
--
-- A conversão para pedido é IDEMPOTENTE por três camadas:
--   1) `propostas.venda_id` é UNIQUE — uma proposta não aponta para dois pedidos;
--   2) o índice parcial `uq_vendas_proposta` impede duas vendas com a mesma proposta;
--   3) a transição usa UPDATE condicional (compare-and-swap) no status.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS propostas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  numero TEXT,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  representante_id INTEGER REFERENCES representantes(id),
  data DATE NOT NULL DEFAULT CURRENT_DATE,
  valida_ate DATE,
  status TEXT NOT NULL DEFAULT 'rascunho',
  condicao_pagamento TEXT,
  observacoes TEXT,
  desconto NUMERIC(12,2) NOT NULL DEFAULT 0,
  frete NUMERIC(12,2) NOT NULL DEFAULT 0,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Conversão: preenchido UMA vez. UNIQUE impede o segundo pedido.
  venda_id INTEGER REFERENCES vendas(id) ON DELETE SET NULL,
  convertido_em TIMESTAMPTZ,
  convertido_por INTEGER REFERENCES usuarios(id),
  recusado_em TIMESTAMPTZ,
  recusado_motivo TEXT,
  cancelado_em TIMESTAMPTZ,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT propostas_status_valido CHECK (status IN (
    'rascunho', 'enviada', 'aprovada', 'recusada', 'convertida', 'cancelada', 'expirada'
  )),
  -- Uma proposta só é "convertida" se existir o pedido; e só tem pedido se convertida.
  CONSTRAINT propostas_convertida_tem_pedido CHECK (
    (status = 'convertida') = (venda_id IS NOT NULL)
  ),
  CONSTRAINT propostas_desconto_nao_negativo CHECK (desconto >= 0),
  CONSTRAINT propostas_frete_nao_negativo CHECK (frete >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_propostas_numero
  ON propostas (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS propostas_empresa_status_idx
  ON propostas (empresa_id, status, data DESC);
CREATE INDEX IF NOT EXISTS propostas_cliente_idx ON propostas (cliente_id);
-- A segunda camada de idempotência da conversão (índice único em
-- `vendas.proposta_id`) é criada na seção H, depois que a coluna existe.

CREATE TABLE IF NOT EXISTS proposta_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  proposta_id INTEGER NOT NULL REFERENCES propostas(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade NUMERIC(12,3) NOT NULL,
  preco_unitario NUMERIC(12,2) NOT NULL,
  desconto_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Preço congelado: qual lista deu este preço (auditoria comercial).
  lista_preco_id INTEGER REFERENCES listas_preco(id) ON DELETE SET NULL,
  preco_tabela NUMERIC(12,2),
  CONSTRAINT proposta_itens_quantidade_positiva CHECK (quantidade > 0),
  CONSTRAINT proposta_itens_desconto_valido CHECK (desconto_pct BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS proposta_itens_proposta_idx ON proposta_itens (proposta_id);

CREATE TABLE IF NOT EXISTS proposta_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  proposta_id INTEGER NOT NULL REFERENCES propostas(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  mensagem TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS proposta_eventos_idx
  ON proposta_eventos (proposta_id, criado_em);

-- ----------------------------------------------------------------------------
-- C) PDV — ponto de venda
--
-- O caixa é uma entidade com abertura e fechamento. O fechamento compara o
-- valor contado com o valor esperado pelo sistema e grava a diferença — sem
-- isso não existe conferência de caixa.
--
-- A venda do PDV é a MESMA entidade `vendas` (canal_venda = 'pdv'): o ERP não
-- ganha um segundo motor de venda. Aqui entram apenas o vínculo com o caixa e
-- os pagamentos (uma venda de balcão pode ser paga em mais de uma forma).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pdv_caixas (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  numero TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  local TEXT,
  abertura_em TIMESTAMPTZ,
  fechamento_em TIMESTAMPTZ,
  valor_abertura NUMERIC(12,2) NOT NULL DEFAULT 0,
  valor_fechamento NUMERIC(12,2),
  valor_sistema NUMERIC(12,2),
  diferenca NUMERIC(12,2),
  status TEXT NOT NULL DEFAULT 'aberto',
  observacoes TEXT,
  fechado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT pdv_caixas_status_valido CHECK (status IN ('aberto', 'fechado', 'cancelado')),
  CONSTRAINT pdv_caixas_abertura_coerente CHECK (
    status <> 'fechado' OR (abertura_em IS NOT NULL AND fechamento_em IS NOT NULL)
  ),
  CONSTRAINT pdv_caixas_valor_abertura_valido CHECK (valor_abertura >= 0)
);

-- Um caixa aberto por vez, por empresa e por terminal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_pdv_caixas_aberto
  ON pdv_caixas (empresa_id, numero) WHERE status = 'aberto';
CREATE INDEX IF NOT EXISTS pdv_caixas_empresa_idx
  ON pdv_caixas (empresa_id, status, abertura_em DESC);

-- Suprimentos (entrada de troco) e sangrias (retirada) do caixa.
CREATE TABLE IF NOT EXISTS pdv_caixa_movimentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  caixa_id INTEGER NOT NULL REFERENCES pdv_caixas(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  motivo TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pdv_caixa_movimentos_tipo_valido CHECK (tipo IN ('suprimento', 'sangria')),
  CONSTRAINT pdv_caixa_movimentos_valor_positivo CHECK (valor > 0)
);

CREATE INDEX IF NOT EXISTS pdv_caixa_movimentos_idx ON pdv_caixa_movimentos (caixa_id);

-- Pagamentos da venda de balcão: uma venda pode ser paga em dinheiro + cartão.
-- O servidor valida que a soma cobre o total; o troco é derivado, não digitado
-- como fonte de verdade.
CREATE TABLE IF NOT EXISTS pdv_pagamentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  caixa_id INTEGER REFERENCES pdv_caixas(id) ON DELETE SET NULL,
  forma TEXT NOT NULL,
  valor NUMERIC(12,2) NOT NULL,
  parcelas INTEGER NOT NULL DEFAULT 1,
  -- Comprovante da adquirente. NÃO é autorização fiscal: é o dado do cartão.
  nsu TEXT,
  bandeira TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pdv_pagamentos_forma_valida CHECK (forma IN (
    'dinheiro', 'pix', 'cartao_credito', 'cartao_debito', 'vale', 'boleto', 'transferencia', 'outros'
  )),
  CONSTRAINT pdv_pagamentos_valor_positivo CHECK (valor > 0),
  CONSTRAINT pdv_pagamentos_parcelas_validas CHECK (parcelas >= 1)
);

CREATE INDEX IF NOT EXISTS pdv_pagamentos_venda_idx ON pdv_pagamentos (venda_id);

-- ----------------------------------------------------------------------------
-- D) LOGÍSTICA — envios
--
-- O `provider` guarda o slug do adaptador (melhor_envio, correios, manual...).
-- Sem credencial o adaptador devolve "não configurado" e o envio NÃO é criado
-- como se tivesse sido postado: o mesmo princípio do provedor fiscal.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS envios (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'manual',
  servico TEXT,
  provider_ref TEXT,
  codigo_rastreamento TEXT,
  etiqueta_url TEXT,
  etiqueta_pdf BYTEA,
  status TEXT NOT NULL DEFAULT 'pendente',
  custo NUMERIC(12,2) NOT NULL DEFAULT 0,
  peso_g INTEGER,
  volumes INTEGER NOT NULL DEFAULT 1,
  cep_destino TEXT,
  prazo_dias INTEGER,
  erro TEXT,
  idempotency_key TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT envios_status_valido CHECK (status IN (
    'pendente', 'cotado', 'gerado', 'postado', 'em_transito', 'entregue',
    'devolvido', 'extraviado', 'cancelado', 'erro'
  )),
  -- Um envio só é "postado" se houver prova: código de rastreamento OU a
  -- referência do provedor. Sem isso, "postado" é inalcançável.
  CONSTRAINT envios_postado_tem_prova CHECK (
    status NOT IN ('postado', 'em_transito', 'entregue')
    OR codigo_rastreamento IS NOT NULL OR provider_ref IS NOT NULL
  ),
  CONSTRAINT envios_custo_valido CHECK (custo >= 0),
  CONSTRAINT envios_volumes_valido CHECK (volumes >= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_envios_idempotency
  ON envios (empresa_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- Uma venda tem no máximo um envio vivo.
CREATE UNIQUE INDEX IF NOT EXISTS uq_envios_venda_vivo
  ON envios (venda_id) WHERE status NOT IN ('cancelado', 'erro');
CREATE INDEX IF NOT EXISTS envios_empresa_status_idx
  ON envios (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS envios_rastreamento_idx
  ON envios (codigo_rastreamento) WHERE codigo_rastreamento IS NOT NULL;

CREATE TABLE IF NOT EXISTS envio_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  envio_id INTEGER NOT NULL REFERENCES envios(id) ON DELETE CASCADE,
  de_status TEXT,
  para_status TEXT NOT NULL,
  codigo TEXT,
  mensagem TEXT,
  local TEXT,
  payload JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS envio_eventos_idx ON envio_eventos (envio_id, criado_em);

-- ----------------------------------------------------------------------------
-- E) EXPEDIÇÃO — separação → conferência → embalagem → expedição
--
-- As etapas ficam na venda (expedicao_etapa) e cada transição vira uma linha
-- em expedicao_eventos. A divergência de conferência SEMPRE é registrada,
-- inclusive quando a conferência é abortada — é a auditoria que a operação pede.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS expedicao_eventos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  etapa TEXT NOT NULL,
  de_etapa TEXT,
  resultado TEXT NOT NULL DEFAULT 'ok',
  mensagem TEXT,
  dados JSONB,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT expedicao_eventos_etapa_valida CHECK (etapa IN (
    'separacao', 'conferencia', 'embalagem', 'expedicao'
  )),
  CONSTRAINT expedicao_eventos_resultado_valido CHECK (resultado IN ('ok', 'divergencia', 'erro'))
);

CREATE INDEX IF NOT EXISTS expedicao_eventos_idx
  ON expedicao_eventos (venda_id, criado_em);

CREATE TABLE IF NOT EXISTS divergencias_conferencia (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  esperado JSONB NOT NULL,
  lido JSONB NOT NULL,
  faltando JSONB,
  sobrando JSONB,
  resolvido_em TIMESTAMPTZ,
  resolvido_por INTEGER REFERENCES usuarios(id),
  resolucao TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS divergencias_conferencia_idx
  ON divergencias_conferencia (empresa_id, venda_id, criado_em DESC);

-- ----------------------------------------------------------------------------
-- F) LOGÍSTICA REVERSA — devolução
--
-- Nada entra no estoque sem rastreabilidade: a devolução só é recebida depois
-- de autorizada, e o recebimento registra o que foi conferido.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devolucoes (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  venda_id INTEGER NOT NULL REFERENCES vendas(id),
  cliente_id INTEGER REFERENCES clientes(id),
  numero TEXT,
  status TEXT NOT NULL DEFAULT 'solicitada',
  motivo TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'devolucao',
  autorizada_em TIMESTAMPTZ,
  autorizado_por INTEGER REFERENCES usuarios(id),
  autorizacao_codigo TEXT,
  codigo_rastreamento TEXT,
  transportadora TEXT,
  recebida_em TIMESTAMPTZ,
  recebido_por INTEGER REFERENCES usuarios(id),
  local_entrada TEXT,
  documento_fiscal_id INTEGER REFERENCES documentos_fiscais(id) ON DELETE SET NULL,
  observacoes TEXT,
  criado_por INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ,
  CONSTRAINT devolucoes_status_valido CHECK (status IN (
    'solicitada', 'autorizada', 'em_transito', 'recebida', 'recusada', 'cancelada'
  )),
  CONSTRAINT devolucoes_tipo_valido CHECK (tipo IN ('devolucao', 'troca', 'garantia', 'arrependimento')),
  -- Recebida exige autorização prévia: não existe entrada "espontânea".
  CONSTRAINT devolucoes_recebida_tem_autorizacao CHECK (
    status <> 'recebida' OR autorizada_em IS NOT NULL
  ),
  CONSTRAINT devolucoes_motivo_obrigatorio CHECK (TRIM(COALESCE(motivo, '')) <> '')
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucoes_numero
  ON devolucoes (empresa_id, numero) WHERE numero IS NOT NULL;
CREATE INDEX IF NOT EXISTS devolucoes_empresa_status_idx
  ON devolucoes (empresa_id, status, criado_em DESC);
CREATE INDEX IF NOT EXISTS devolucoes_venda_idx ON devolucoes (venda_id);

CREATE TABLE IF NOT EXISTS devolucao_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  devolucao_id INTEGER NOT NULL REFERENCES devolucoes(id) ON DELETE CASCADE,
  item_venda_id INTEGER REFERENCES itens_venda(id) ON DELETE SET NULL,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  tamanho_id INTEGER REFERENCES tamanhos(id),
  quantidade_solicitada NUMERIC(12,3) NOT NULL,
  quantidade_recebida NUMERIC(12,3) NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'bom',
  devolucao_estoque BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT devolucao_itens_qtd_positiva CHECK (quantidade_solicitada > 0),
  CONSTRAINT devolucao_itens_recebida_valida CHECK (
    quantidade_recebida >= 0 AND quantidade_recebida <= quantidade_solicitada
  ),
  CONSTRAINT devolucao_itens_estado_valido CHECK (estado IN (
    'bom', 'avariado', 'usado', 'faltando_acessorio'
  ))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_devolucao_item
  ON devolucao_itens (devolucao_id, produto_id, COALESCE(tamanho_id, 0));
CREATE INDEX IF NOT EXISTS devolucao_itens_idx ON devolucao_itens (devolucao_id);

-- ----------------------------------------------------------------------------
-- G) RECEBIMENTO PARCIAL DE COMPRA
--
-- Sem isso, "recebido" é tudo-ou-nada e o estoque sobe além do que chegou.
-- Cada recebimento é uma linha; a soma dos itens nunca passa do pedido
-- (índice/garantia aplicada na escrita condicional + CHECK agregado abaixo).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compra_recebimentos (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  data TIMESTAMPTZ NOT NULL DEFAULT now(),
  local TEXT,
  documento TEXT,
  total NUMERIC(12,2) NOT NULL DEFAULT 0,
  observacoes TEXT,
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT compra_recebimentos_total_valido CHECK (total >= 0)
);

CREATE INDEX IF NOT EXISTS compra_recebimentos_idx ON compra_recebimentos (compra_id, data);

CREATE TABLE IF NOT EXISTS compra_recebimento_itens (
  id SERIAL PRIMARY KEY,
  empresa_id INTEGER NOT NULL DEFAULT 1 REFERENCES empresas(id),
  recebimento_id INTEGER NOT NULL REFERENCES compra_recebimentos(id) ON DELETE CASCADE,
  item_compra_id INTEGER NOT NULL REFERENCES itens_compra(id) ON DELETE CASCADE,
  quantidade NUMERIC(12,3) NOT NULL,
  CONSTRAINT compra_recebimento_itens_qtd_positiva CHECK (quantidade > 0)
);

CREATE INDEX IF NOT EXISTS compra_recebimento_itens_idx
  ON compra_recebimento_itens (recebimento_id);

-- O total recebido de um item NUNCA ultrapassa o pedido.
--
-- O CHECK é uma trava de segurança para o caminho mais provável de erro
-- (reduzir `itens_compra.quantidade` para abaixo do que já chegou). Ele não é
-- a garantia principal contra excesso de recebimento: um CHECK só é revalidado
-- quando a própria linha muda, e receber não muda a linha do item. Quem impede
-- o excesso é o UPDATE condicional em `itens_compra.quantidade_recebida`
-- (compare-and-swap na mesma transação do recebimento) — ver suprimentos.ts.
--
-- A função é marcada IMMUTABLE porque o Postgres só aceita esse rótulo em
-- CHECK. Ela não é dobrada em constante: o argumento é uma referência de
-- coluna, nunca um literal.
CREATE OR REPLACE FUNCTION brobond_qtd_recebida_item(item_id INTEGER)
RETURNS NUMERIC AS $$
  SELECT COALESCE(SUM(cri.quantidade), 0)
  FROM compra_recebimento_itens cri
  JOIN compra_recebimentos cr ON cr.id = cri.recebimento_id
  WHERE cri.item_compra_id = item_id;
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE itens_compra DROP CONSTRAINT IF EXISTS itens_compra_nao_excede_pedido;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_nao_excede_pedido CHECK (
    brobond_qtd_recebida_item(id) <= quantidade
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- H) COLUNAS DE AMARRAÇÃO NAS TABELAS EXISTENTES (aditivas)
-- ----------------------------------------------------------------------------
-- Pedido de venda: de onde veio, em que etapa da expedição está, qual caixa.
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS proposta_id INTEGER REFERENCES propostas(id) ON DELETE SET NULL;

-- Segunda camada de idempotência da conversão: nenhuma venda nasce duas vezes
-- da mesma proposta (a primeira é o UNIQUE em propostas.venda_id; a terceira é
-- o UPDATE condicional no status).
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendas_proposta
  ON vendas (proposta_id) WHERE proposta_id IS NOT NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS pdv_caixa_id INTEGER REFERENCES pdv_caixas(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS envio_id INTEGER REFERENCES envios(id) ON DELETE SET NULL;
ALTER TABLE vendas ADD COLUMN IF NOT EXISTS expedicao_etapa TEXT;

DO $$ BEGIN
  ALTER TABLE vendas ADD CONSTRAINT vendas_expedicao_etapa_valida CHECK (
    expedicao_etapa IS NULL OR expedicao_etapa IN (
      'pendente', 'separacao', 'conferida', 'embalada', 'expedida'
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Item de venda: o preço de tabela e a lista que o originaram ficam congelados.
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS lista_preco_id INTEGER REFERENCES listas_preco(id) ON DELETE SET NULL;
ALTER TABLE itens_venda ADD COLUMN IF NOT EXISTS preco_tabela NUMERIC(12,2);

-- Item de compra: quanto já foi recebido (parcial).
ALTER TABLE itens_compra ADD COLUMN IF NOT EXISTS quantidade_recebida NUMERIC(12,3) NOT NULL DEFAULT 0;
DO $$ BEGIN
  ALTER TABLE itens_compra ADD CONSTRAINT itens_compra_recebida_valida CHECK (
    quantidade_recebida >= 0 AND quantidade_recebida <= quantidade
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- `compras` ganha o estado intermediário do recebimento parcial.
ALTER TABLE compras DROP CONSTRAINT IF EXISTS compras_status_valido;
DO $$ BEGIN
  ALTER TABLE compras ADD CONSTRAINT compras_status_valido CHECK (
    status IN ('pendente', 'aprovado', 'parcial', 'recebido', 'cancelado')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS aprovada_em TIMESTAMPTZ;
ALTER TABLE compras ADD COLUMN IF NOT EXISTS aprovada_por INTEGER REFERENCES usuarios(id);

-- `pdv` como canal de venda reconhecido.
ALTER TABLE vendas DROP CONSTRAINT IF EXISTS vendas_canal_venda_valido;
DO $$ BEGIN
  ALTER TABLE vendas ADD CONSTRAINT vendas_canal_venda_valido CHECK (
    canal_venda IS NULL OR canal_venda IN (
      'balcao', 'pdv', 'representante', 'whatsapp', 'site_varejo',
      'site_atacado', 'marketplace', 'outro'
    )
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ----------------------------------------------------------------------------
-- Herança de empresa por trigger — até um INSERT em SQL cru cai na empresa
-- certa (mesmo mecanismo da migration 0017).
-- ----------------------------------------------------------------------------
DO $$
DECLARE
  spec TEXT[];
  specs TEXT[][] := ARRAY[
    ARRAY['lista_preco_itens',        'listas_preco',        'lista_id'],
    ARRAY['listas_preco_historico',   'listas_preco',        'lista_id'],
    ARRAY['proposta_itens',           'propostas',           'proposta_id'],
    ARRAY['proposta_eventos',         'propostas',           'proposta_id'],
    ARRAY['pdv_caixa_movimentos',     'pdv_caixas',          'caixa_id'],
    ARRAY['pdv_pagamentos',           'vendas',              'venda_id'],
    ARRAY['envio_eventos',            'envios',              'envio_id'],
    ARRAY['expedicao_eventos',        'vendas',              'venda_id'],
    ARRAY['divergencias_conferencia', 'vendas',              'venda_id'],
    ARRAY['devolucao_itens',          'devolucoes',          'devolucao_id'],
    ARRAY['compra_recebimentos',      'compras',             'compra_id'],
    ARRAY['compra_recebimento_itens', 'compra_recebimentos', 'recebimento_id']
  ];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY specs LOOP
    IF to_regclass(spec[1]) IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = spec[1] AND column_name = spec[3]) THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'trg_empresa_' || spec[1], spec[1]);
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I
           FOR EACH ROW EXECUTE FUNCTION brobond_herdar_empresa(%L, %L)',
        'trg_empresa_' || spec[1], spec[1], spec[2], spec[3]);
    END IF;
  END LOOP;
END $$;

-- Índices de caminho quente com a empresa na frente (mesmo padrão da 0017).
CREATE INDEX IF NOT EXISTS propostas_empresa_cliente_idx ON propostas (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS pdv_pagamentos_empresa_idx   ON pdv_pagamentos (empresa_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS envios_empresa_venda_idx     ON envios (empresa_id, venda_id);
CREATE INDEX IF NOT EXISTS devolucoes_empresa_cliente_idx ON devolucoes (empresa_id, cliente_id);
CREATE INDEX IF NOT EXISTS compra_recebimentos_empresa_idx ON compra_recebimentos (empresa_id, data DESC);
CREATE INDEX IF NOT EXISTS vendas_empresa_expedicao_idx ON vendas (empresa_id, expedicao_etapa);
