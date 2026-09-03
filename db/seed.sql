-- ============================================================
-- BROBOND ERP — dados iniciais (opcional)
-- Execute DEPOIS do schema.sql:  psql "$DATABASE_URL" -f db/seed.sql
--
-- Observação: o usuário administrador NÃO é criado aqui. A API cria/atualiza
-- o admin automaticamente ao iniciar, a partir das variáveis de ambiente
-- ADMIN_EMAIL / ADMIN_PASSWORD (a senha é gravada com hash bcrypt).
-- ============================================================

INSERT INTO tamanhos (codigo, descricao, ordem) VALUES
  ('PP', 'Extra pequeno', 1),
  ('P',  'Pequeno',       2),
  ('M',  'Médio',         3),
  ('G',  'Grande',        4),
  ('GG', 'Extra grande',  5)
ON CONFLICT (codigo) DO UPDATE SET ordem = EXCLUDED.ordem;

INSERT INTO colecoes (nome, temporada, ano)
SELECT v.nome, v.temporada, v.ano
FROM (VALUES
  ('Verão 2026',   'Verão',   2026),
  ('Inverno 2026', 'Inverno', 2026)
) AS v(nome, temporada, ano)
WHERE NOT EXISTS (SELECT 1 FROM colecoes c WHERE c.nome = v.nome);

INSERT INTO fornecedores (nome, cnpj, email)
SELECT v.nome, v.cnpj, v.email
FROM (VALUES
  ('Tecidos Brasil Ltda', '12.345.678/0001-90', 'contato@tecidosbrasil.com'),
  ('Botões & Cia',        '98.765.432/0001-21', 'vendas@botoescia.com')
) AS v(nome, cnpj, email)
WHERE NOT EXISTS (SELECT 1 FROM fornecedores f WHERE f.nome = v.nome);

INSERT INTO insumos (nome, unidade, custo_medio, fornecedor_id)
SELECT v.nome, v.unidade, v.custo, f.id
FROM (VALUES
  ('Tecido algodão', 'm',  18.50, 'Tecidos Brasil Ltda'),
  ('Botão metálico', 'un',  0.35, 'Botões & Cia'),
  ('Zíper',          'un',  1.20, 'Botões & Cia')
) AS v(nome, unidade, custo, fornecedor)
LEFT JOIN fornecedores f ON f.nome = v.fornecedor
WHERE NOT EXISTS (SELECT 1 FROM insumos i WHERE i.nome = v.nome);
