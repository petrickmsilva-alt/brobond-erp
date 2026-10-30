import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test'; delete process.env.DATABASE_URL;
const { parseLinhasExtrato, parseOFX } = await import('../src/financeiro');
const rejects = (f: () => unknown) => assert.throws(f, (e: any) => e.status === 400);

test('CSV conserva centavos em vírgula decimal e exige data, valor e direção inequívocos', () => {
  assert.deepEqual(parseLinhasExtrato({ texto: '2035-05-10;-12,34;Despesa' }), [{ data: '2035-05-10', valor: 12.34, direcao: 'saida', descricao: 'Despesa' }]);
  assert.equal(parseLinhasExtrato({ texto: '2035-05-10,12.34,Receita' })[0].valor, 12.34);
  for (const texto of ['12;Sem data', '2035-02-30;10;Inválida', '2035-01-01;12x34;Inválida', '2035-01-01;1.234;Milésimo', '2035-01-01;0;Zero', '2035-01-01,12,34,Ambígua', '"2035-01-01";2;CSV'])
    rejects(() => parseLinhasExtrato({ texto }));
  rejects(() => parseLinhasExtrato({ linhas: [{ data: '2035-01-01', valor: -1, direcao: 'entrada' }] }));
  rejects(() => parseLinhasExtrato({ linhas: [{ data: '2035-01-01', valor: 1, direcao: 'inexistente' }] }));
});

test('OFX inválido, incompleto ou de outra moeda é recusado integralmente', () => {
  const t = (data: string, valor: string) => `<OFX><STMTTRN><DTPOSTED>${data}<TRNAMT>${valor}<FITID>x</STMTTRN></OFX>`;
  assert.equal(parseOFX(t('20350510120000[-3:BRT]', '-12.34'))[0].valor, 12.34);
  for (const content of [t('20350230', '2.00'), t('', '2.00'), t('20350510', '12.34abc'), t('20350510', '0'), '<OFX><CURDEF>USD</OFX>']) rejects(() => parseOFX(content));
});
