import type { Tx } from './store';

export type UniversalConditionPriceDefinition = { field:string; canal:'atacado'|'varejo'; condicao:string; min:number; marginField?:string };
export const UNIVERSAL_CONDITION_PRICE_FIELDS:UniversalConditionPriceDefinition[]=[
 {field:'preco_atacado_vista',canal:'atacado',condicao:'atacado_vista',min:1,marginField:'margem_bruta_atacado_vista'},
 {field:'preco_atacado_boleto_30',canal:'atacado',condicao:'boleto_30',min:1},
 {field:'preco_atacado_boleto_30_60',canal:'atacado',condicao:'boleto_30_60',min:1},
 {field:'preco_atacado_boleto_30_60_90',canal:'atacado',condicao:'boleto_30_60_90',min:1},
 {field:'preco_atacado_cartao_debito',canal:'atacado',condicao:'cartao_debito',min:1},
 {field:'preco_atacado_cartao_credito_vista',canal:'atacado',condicao:'cartao_credito_vista',min:1},
 {field:'preco_atacado_cartao_credito_30_60',canal:'atacado',condicao:'cartao_credito_30_60',min:1},
 {field:'preco_atacado_cartao_credito_30_60_90',canal:'atacado',condicao:'cartao_credito_30_60_90',min:1},
 {field:'preco_varejo_vista',canal:'varejo',condicao:'varejo_vista',min:1,marginField:'margem_bruta_varejo_vista'},
 {field:'preco_varejo_vista_min_2_un',canal:'varejo',condicao:'varejo_vista',min:2,marginField:'margem_bruta_varejo_min_2_un'},
 {field:'preco_varejo_cartao_vista',canal:'varejo',condicao:'cartao_vista',min:1},
 {field:'preco_varejo_cartao_parcelado',canal:'varejo',condicao:'cartao_parcelado',min:1},
];
const BASE_PRICE_FIELDS=['preco_venda','preco_atacado'] as const;
const hasValue=(v:unknown)=>v!==null&&v!==undefined&&String(v).trim()!=='';
export function preserveNonzeroBasePrices(existing:Record<string,unknown>,patch:Record<string,unknown>):Record<string,unknown>{
 const guarded={...patch};
 for(const field of BASE_PRICE_FIELDS){if(!Object.prototype.hasOwnProperty.call(guarded,field)||!hasValue(existing[field]))continue;const current=Number(existing[field]);if(Number.isFinite(current)&&current!==0)delete guarded[field];}
 return guarded;
}
export function requiredConditionCodesFromMappedRows(rows:Record<string,unknown>[]):string[]{
 const codes=new Set<string>();for(const row of rows)for(const definition of UNIVERSAL_CONDITION_PRICE_FIELDS)if(hasValue(row[definition.field]))codes.add(definition.condicao);return [...codes].sort();
}
export function missingConditionCodes(required:string[],available:Iterable<string>):string[]{const set=new Set([...available].map(v=>String(v).trim().toLowerCase()));return required.filter(code=>!set.has(String(code).trim().toLowerCase())).sort();}
export type PriceConditionAction='created'|'unchanged'|'versioned';
export function determinePriceConditionAction(currentPrice:unknown,nextPrice:number):PriceConditionAction{if(currentPrice===null||currentPrice===undefined||currentPrice==='')return'created';const current=Number(currentPrice);if(!Number.isFinite(current))return'created';const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;return round2(current)===round2(nextPrice)?'unchanged':'versioned';}
export type PersistUniversalConditionPriceArgs={empresaId:number;produtoId:number;canal:'atacado'|'varejo';condicao:string;preco:number;quantidadeMinima:number;margemPct:number|null;criadoPor:number;regraCalculo:Record<string,unknown>};
export async function persistUniversalConditionPrice(tx:Tx,args:PersistUniversalConditionPriceArgs):Promise<PriceConditionAction>{
 if(!tx)throw new Error('Preco por condicao exige transacao PostgreSQL.');
 const {empresaId,produtoId,canal,condicao,preco,quantidadeMinima,margemPct,criadoPor,regraCalculo}=args;const ruleJson=JSON.stringify(regraCalculo);const lockKey=String(produtoId)+':'+canal+':'+condicao+':'+quantidadeMinima;
 await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',[String(empresaId),lockKey]);
 const currentResult=await tx.query('SELECT id, preco, margem_pct, ajuste_pct, regra_calculo, origem FROM produto_precos_condicao WHERE empresa_id=$1 AND produto_id=$2 AND canal=$3 AND condicao=$4 AND quantidade_minima=$5 AND vigencia_fim IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE',[empresaId,produtoId,canal,condicao,quantidadeMinima]);
 const current=currentResult.rows[0] as {id:number;preco:number|string}|undefined;const action=determinePriceConditionAction(current?.preco,preco);
 const insertCurrent=async()=>{await tx.query('INSERT INTO produto_precos_condicao (empresa_id,produto_id,canal,condicao,preco,origem,criado_por,atualizado_por,quantidade_minima,margem_pct,ajuste_pct,regra_calculo,vigencia_inicio,vigencia_fim) VALUES ($1,$2,$3,$4,$5,$$importacao_universal$$,$6,$6,$7,$8,0,$9::jsonb,CURRENT_DATE,NULL)',[empresaId,produtoId,canal,condicao,preco,criadoPor,quantidadeMinima,margemPct,ruleJson]);};
 const insertHistory=async(previous:number|null)=>{await tx.query('INSERT INTO produto_precos_condicao_historico (empresa_id,produto_id,canal,condicao,preco_anterior,preco_novo,quantidade_minima,margem_pct,ajuste_pct,regra_calculo,vigencia_inicio,vigencia_fim,origem,usuario_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,$9::jsonb,CURRENT_DATE,NULL,$$importacao_universal$$,$10)',[empresaId,produtoId,canal,condicao,previous,preco,quantidadeMinima,margemPct,ruleJson,criadoPor]);};
 if(action==='created'){await insertCurrent();await insertHistory(null);return action;}
 if(action==='unchanged'){const updated=await tx.query('UPDATE produto_precos_condicao SET margem_pct=$1, ajuste_pct=0, regra_calculo=$2::jsonb, origem=$$importacao_universal$$, atualizado_em=now(), atualizado_por=$3 WHERE id=$4 AND vigencia_fim IS NULL RETURNING id',[margemPct,ruleJson,criadoPor,Number(current!.id)]);if(!updated.rows.length)throw new Error('Preco vigente mudou durante a atualizacao idempotente.');return action;}
 const closed=await tx.query('UPDATE produto_precos_condicao SET vigencia_fim=CURRENT_DATE, atualizado_em=now(), atualizado_por=$1 WHERE id=$2 AND vigencia_fim IS NULL RETURNING id',[criadoPor,Number(current!.id)]);if(!closed.rows.length)throw new Error('Preco vigente mudou durante a versionacao.');await insertCurrent();await insertHistory(Number(current!.preco));return action;
}
