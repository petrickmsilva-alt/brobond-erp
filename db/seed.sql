-- ============================================================
-- BROBOND ERP — dados iniciais (opcional)
-- ============================================================

INSERT INTO tamanhos (codigo, descricao) VALUES
  ('PP', 'Extra pequeno'),
  ('P', 'Pequeno'),
  ('M', 'Médio'),
  ('G', 'Grande'),
  ('GG', 'Extra grande')
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO colecoes (nome, temporada, ano) VALUES
  ('Verão 2026', 'Verão', 2026),
  ('Inverno 2026', 'Inverno', 2026)
ON CONFLICT DO NOTHING;

INSERT INTO fornecedores (nome, cnpj, email) VALUES
  ('Tecidos Brasil Ltda', '12.345.678/0001-90', 'contato@tecidosbrasil.com'),
  ('Botões & Cia', '98.765.432/0001-21', 'vendas@botoescia.com')
ON CONFLICT DO NOTHING;

INSERT INTO insumos (nome, unidade, custo_medio, fornecedor_id) VALUES
  ('Tecido algodão', 'm', 18.50, 1),
  ('Botão metálico', 'un', 0.35, 2),
  ('Zíper', 'un', 1.20, 2)
ON CONFLICT DO NOTHING;
