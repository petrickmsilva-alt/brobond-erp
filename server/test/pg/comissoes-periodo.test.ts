// ============================================================
// P1-13 (auditoria independente, 2026-10-11): o relatório de comissões
// comparava `String(data-do-banco).slice(0, 10)` — em Postgres o valor chega
// como `Date`, vira "Wed Oct 01" e a comparação lexicográfica com `?ate=`
// DESCARTava a linha. O teste cria a venda faturada + o evento de comissão com
// data DENTRO do período pedido e exige que os dois apareçam;
// `comissoes.ts:261` (antes da correção) devolvia 0.
//
// Roda no job `testes-postgres` do CI. Sem DATABASE_URL o arquivo se auto-pula.
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

const temBanco = Boolean(process.env.DATABASE_URL);
const skip = temBanco ? false : 'requer DATABASE_URL (job testes-postgres do CI)';

process.env.NODE_ENV = 'test';

const gerente = { id: 0, name: 'Teste PG', perfil: 'gerente' };

function mockReq(user: any, query: Record<string, string> = {}): any {
  return { user, query, body: {}, params: {} };
}
function mockRes() {
  let _payload: any;
  let _status = 0;
  const res: any = {
    json: (d: any) => {
      _payload = d;
      if (!_status) _status = 200;
      return res;
    },
    status: (s: number) => {
      _status = s;
      return res;
    },
    setHeader: () => res,
  };
  return { res, payload: () => _payload, code: () => _status };
}
async function chamar(handler: (req: any, res: any) => Promise<unknown>, req: any) {
  const r = mockRes();
  await handler(req, r.res);
  return { code: r.code(), payload: r.payload() };
}

test('P1-13: comissões no período incluem a venda faturada e o evento com data vinda do banco (PG)', { skip }, async () => {
  const { migrate, query } = await import('../../src/db');
  await migrate();
  const { resumoComissoes } = await import('../../src/comissoes');

  const s = String(Date.now() % 1e7);
  const linha = async (sql: string, params: unknown[] = []) => (await query(sql, params)).rows;

  const [rep] = await linha(
    `INSERT INTO representantes (nome, comissao_pct, ativo) VALUES ($1, 5, true) RETURNING id`,
    [`Rep P1-13 ${s}`]
  );
  // Venda faturada DENTRO do período pedido (fim de mês, como o defeito exigia).
  const [venda] = await linha(
    `INSERT INTO vendas (status, canal_venda, total, data, faturada_em, representante_id, comissao_valor, empresa_id)
     VALUES ('faturada','representante',1000,'2026-04-28T12:00:00Z','2026-04-28T15:00:00Z',$1,50,1) RETURNING id`,
    [rep.id]
  );
  const [evento] = await linha(
    `INSERT INTO comissoes_eventos (empresa_id, venda_id, representante_id, tipo, base, pct, valor, criado_em)
     VALUES (1,$1,$2,'realizada',1000,5,50,'2026-04-30T18:00:00Z') RETURNING id`,
    [venda.id, rep.id]
  );

  try {
    const dentro = await chamar(
      resumoComissoes,
      mockReq(gerente, { de: '2026-04-01', ate: '2026-04-30' })
    );
    assert.equal(dentro.code, 200);
    const minha = (dentro.payload.linhas as any[]).find((l) => l.representante_id === Number(rep.id));
    assert.ok(minha, 'o representante precisa aparecer no relatório do período');
    assert.equal(minha.apurada, 50, 'venda faturada em 28/04 está dentro do período');
    assert.equal(minha.efetivada, 50, 'evento de comissão de 30/04 está dentro do período');
    assert.equal(minha.vendas, 1);

    // Fora do período: nada da venda/evento aparece (o filtro continua estrito).
    const fora = await chamar(
      resumoComissoes,
      mockReq(gerente, { de: '2026-05-01', ate: '2026-05-31' })
    );
    const foraMinha = (fora.payload.linhas as any[]).find((l) => l.representante_id === Number(rep.id));
    assert.equal(foraMinha, undefined, 'maio não pode trazer a comissão de abril');

    // Sem `ate`: o piso do período continua valendo.
    const soDe = await chamar(resumoComissoes, mockReq(gerente, { de: '2026-05-01' }));
    assert.equal(
      (soDe.payload.linhas as any[]).find((l) => l.representante_id === Number(rep.id)),
      undefined
    );
  } finally {
    await query(`DELETE FROM comissoes_eventos WHERE id = $1`, [evento.id]);
    await query(`DELETE FROM vendas WHERE id = $1`, [venda.id]);
    await query(`DELETE FROM representantes WHERE id = $1`, [rep.id]);
  }
});
