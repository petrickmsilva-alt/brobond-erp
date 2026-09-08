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

-- Categorias de produto
INSERT INTO categorias (nome, descricao)
SELECT v.nome, v.descricao
FROM (VALUES
  ('Camisa',   'Camisas sociais e casuais'),
  ('Camiseta', 'Malha, gola careca e polo'),
  ('Calça',    'Jeans, sarja e alfaiataria'),
  ('Bermuda',  'Bermudas e shorts'),
  ('Jaqueta',  'Jaquetas, blusões e casacos')
) AS v(nome, descricao)
WHERE NOT EXISTS (SELECT 1 FROM categorias c WHERE LOWER(c.nome) = LOWER(v.nome));

-- Cores padronizadas (nome + amostra hexadecimal)
INSERT INTO cores (nome, hex)
SELECT v.nome, v.hex
FROM (VALUES
  ('Preto',         '#111111'),
  ('Branco',        '#FFFFFF'),
  ('Off-white',     '#F3EFE6'),
  ('Azul marinho',  '#1F3A5F'),
  ('Azul claro',    '#8FB8DE'),
  ('Cinza mescla',  '#9CA3AF'),
  ('Chumbo',        '#4B5563'),
  ('Verde militar', '#4B5320'),
  ('Bege',          '#D6C6A8'),
  ('Vinho',         '#6B1E2B')
) AS v(nome, hex)
WHERE NOT EXISTS (SELECT 1 FROM cores c WHERE LOWER(c.nome) = LOWER(v.nome));
-- Preenche a amostra de cores que foram migradas do texto livre sem hex
UPDATE cores c SET hex = v.hex
FROM (VALUES ('preto','#111111'),('branco','#FFFFFF'),('azul marinho','#1F3A5F'),('cinza mescla','#9CA3AF'),('verde militar','#4B5320')) AS v(nome, hex)
WHERE c.hex IS NULL AND LOWER(c.nome) = v.nome;

-- ------------------------------------------------------------
-- Grades de tamanhos (conjuntos nomeados) — evita misturar
-- tamanhos de camiseta (PP-GG) com calça/bermuda (36-48) etc.
-- ------------------------------------------------------------

-- Tamanhos numéricos (calças/bermudas) e tamanho único (acessórios)
INSERT INTO tamanhos (codigo, descricao, ordem) VALUES
  ('36', '36', 10),
  ('38', '38', 11),
  ('40', '40', 12),
  ('42', '42', 13),
  ('44', '44', 14),
  ('46', '46', 15),
  ('48', '48', 16),
  ('Único', 'Tamanho único', 20)
ON CONFLICT (codigo) DO UPDATE SET ordem = EXCLUDED.ordem;

INSERT INTO grades (nome, descricao) VALUES
  ('Camiseta PP-GG', 'Malha e camisaria básica'),
  ('Calça 36-48',    'Jeans e sarja'),
  ('Bermuda 36-46',  'Bermudas e shorts')
ON CONFLICT (nome) DO NOTHING;

INSERT INTO grade_tamanhos (grade_id, tamanho_id, ordem)
SELECT g.id, t.id, v.ordem
FROM (VALUES
  ('Camiseta PP-GG', 'PP', 1), ('Camiseta PP-GG', 'P', 2), ('Camiseta PP-GG', 'M', 3),
  ('Camiseta PP-GG', 'G', 4),  ('Camiseta PP-GG', 'GG', 5),
  ('Calça 36-48', '36', 1), ('Calça 36-48', '38', 2), ('Calça 36-48', '40', 3),
  ('Calça 36-48', '42', 4), ('Calça 36-48', '44', 5), ('Calça 36-48', '46', 6), ('Calça 36-48', '48', 7),
  ('Bermuda 36-46', '36', 1), ('Bermuda 36-46', '38', 2), ('Bermuda 36-46', '40', 3),
  ('Bermuda 36-46', '42', 4), ('Bermuda 36-46', '44', 5), ('Bermuda 36-46', '46', 6)
) AS v(grade_nome, tamanho_codigo, ordem)
JOIN grades g ON g.nome = v.grade_nome
JOIN tamanhos t ON t.codigo = v.tamanho_codigo
ON CONFLICT (grade_id, tamanho_id) DO NOTHING;

-- Grade padrão por categoria (o produto pode sobrescrever)
UPDATE categorias SET grade_id = g.id FROM grades g
WHERE g.nome = 'Camiseta PP-GG' AND categorias.nome IN ('Camiseta', 'Camisa');
UPDATE categorias SET grade_id = g.id FROM grades g
WHERE g.nome = 'Calça 36-48' AND categorias.nome = 'Calça';
UPDATE categorias SET grade_id = g.id FROM grades g
WHERE g.nome = 'Bermuda 36-46' AND categorias.nome = 'Bermuda';
