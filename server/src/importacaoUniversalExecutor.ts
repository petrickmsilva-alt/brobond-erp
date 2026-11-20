import type { Request, Response } from 'express';
import { query as queryDb } from './db';
import { currentUser } from './auth';
import { HttpError } from './errors';
import { getResource, type Resource } from './resources';
import { getStore, createRecord, lancarMovimentacaoDentro, escopoDe, type Actor } from './services';
import { validatePayload, parseNumber } from './validate';
import { validarReferenciasDaEmpresa } from './empresa';
import type { Row, Tx } from './store';
import { hashAprovacaoImportacaoUniversal } from './importacaoUniversalHash';

const BLOQUEADORES = new Set(['duplicado_origem','conflito_sku','conflito_codigo_barras','ambiguidade','campo_desconhecido','orfao_relacionamento','conflito_dimensional','produto_sem_sku','sku_sem_produto','variacao_sem_produto','estoque_sem_produto','estoque_sem_local','preco_sem_produto','movimentacao_sem_produto','entidade_sem_executor']);
const normal=(v:unknown)=>String(v??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toUpperCase();
export function normalizarDocumentoImportacao(value:unknown):string{return String(value??'').replace(/\D/g,'');}
export function findByNormalizedDocument(rows:Row[],fieldName:string,documentKey:string,empresaId:number):Row|null{const key=normalizarDocumentoImportacao(documentKey);if(!key)return null;return rows.find(r=>Number(r.empresa_id)===empresaId&&normalizarDocumentoImportacao(r[fieldName])===key)??null;}
const parseNum=(v:unknown)=>{const n=parseNumber(v);if(n===null)throw new HttpError(422,'Valor numérico inválido na importação.');return n;};
const field=(r:Resource,n:string)=>r.fields.find(f=>f.name===n);
type SheetRow={linhaOrigem:number;valores:Record<string,unknown>};
type Mapping={aba:string;colunaOriginal:string;campoCanonico:string|null;ignorado?:boolean};
type Relation={origemAba:string;destinoAba:string;campoOrigem:string;campoDestino:string;tipo:string;confirmado?:boolean};
type Session={id:string;empresa_id:number;usuario_id:number;status:string;versao:number;sha256:string;interpretacao:any;reconciliacao:any;preview:any;inventario_abas:any[];resultado:any};
function mapRow(values:Record<string,unknown>,aba:string,mappings:Mapping[]){const out:Record<string,unknown>={};for(const m of mappings)if(m.aba===aba&&m.campoCanonico&&!m.ignorado&&values[m.colunaOriginal]!==undefined)out[m.campoCanonico]=values[m.colunaOriginal];return out;}
export function buildExtraAttributes(values:Record<string,unknown>,aba:string,mappings:Mapping[]){const used=new Set(mappings.filter(m=>m.aba===aba&&m.campoCanonico&&!m.ignorado).map(m=>m.colunaOriginal));const ignored=new Set(mappings.filter(m=>m.aba===aba&&m.ignorado===true).map(m=>m.colunaOriginal));const extras:Record<string,unknown>={};for(const [k,v] of Object.entries(values))if(!used.has(k)&&!ignored.has(k)&&v!==null&&v!==undefined&&String(v).trim()!=='')extras[k]=v;return extras;}
function findByName(rows:Row[],value:unknown){const key=normal(value);if(!key)return null;return rows.find(r=>normal(r.nome)===key||normal(r.codigo)===key||normal(r.razao_social)===key)??null;}
async function fetchAll(s:any,r:Resource,empresaId:number,tx:Tx):Promise<Row[]>{
 const all:Row[]=[];let page=1;
 while(true){const result=await s.list(r,{page,pageSize:2000,sort:'id',dir:'asc',filter:r.empresa?{empresa_id:empresaId}:undefined},tx);all.push(...result.rows);if(all.length>=result.total||!result.rows.length)break;page++;}
 return all;
}
function payloadProduto(m:Record<string,unknown>,extras:Record<string,unknown>,refs:{categorias:Row[];colecoes:Row[];cores:Row[];fornecedores:Row[]},r:Resource){
 const payload:Record<string,unknown>={sku:String(m.sku??'').trim(),nome:String(m.nome??'').trim(),origem_dados:'importacao'};
 const simpleFields=['codigo_barras','custo','preco_venda','preco_atacado','descricao','composicao','material','modelagem','genero','marca','ncm','cest','tipo','condicao','producao','unidade','tags','codigo_item','codigo_categoria','codigo_industria'];
 for(const k of simpleFields)if(m[k]!==undefined&&m[k]!==null&&String(m[k]).trim()!==''&&field(r,k))payload[k]=m[k];
 const minWholesale=m.qtd_min_atacado??m.atacado_min_qtd;if(minWholesale!==undefined&&minWholesale!==null&&String(minWholesale).trim()!==''&&field(r,'atacado_min_qtd'))payload.atacado_min_qtd=minWholesale;
 if(m.categoria!==undefined&&field(r,'categoria_id')){const c=findByName(refs.categorias,m.categoria);if(c)payload.categoria_id=Number(c.id);}
 if(m.colecao!==undefined&&field(r,'colecao_id')){const c=findByName(refs.colecoes,m.colecao);if(c)payload.colecao_id=Number(c.id);}
 if(m.cor!==undefined&&field(r,'cor_id')){const c=findByName(refs.cores,m.cor);if(c)payload.cor_id=Number(c.id);if(field(r,'cor'))payload.cor=String(m.cor).trim();}
 if(m.fornecedor!==undefined&&field(r,'fornecedor_id')){const c=findByName(refs.fornecedores,m.fornecedor);if(c)payload.fornecedor_id=Number(c.id);}
 if(field(r,'atributos_adicionais'))payload.atributos_adicionais=extras;
 return payload;
}


function rowValue(row:SheetRow,fieldName:string){return row.valores?.[fieldName];}
function mapSheetRow(row:SheetRow,aba:string,mappings:Mapping[]){
 const mapped=mapRow(row.valores,aba,mappings);
 if(mapped.tipo_movimento!==undefined&&mapped.tipo===undefined)mapped.tipo=mapped.tipo_movimento;
 return mapped;
}
function findBySku(products:Row[],value:unknown){const k=normal(value);return k?products.find(p=>normal(p.sku)===k)??null:null;}
export function normalizarTipoMovimentacao(value:unknown):'entrada'|'saida'|'transferencia'|'ajuste'|null{const v=normal(value);if(v==='ENTRADA')return 'entrada';if(v==='SAIDA')return 'saida';if(v==='TRANSFERENCIA')return 'transferencia';if(v==='AJUSTE')return 'ajuste';return null;}
export function validarQuantidadeMovimentacao(tipoRaw:unknown,quantidadeRaw:unknown){const tipo=normalizarTipoMovimentacao(tipoRaw),quantidade=parseNumber(quantidadeRaw);if(!tipo)throw new HttpError(422,'Tipo de movimentação inválido.');if(quantidade===null||!Number.isFinite(quantidade))throw new HttpError(422,'Quantidade de movimentação inválida.');if(tipo!=='ajuste'&&quantidade<=0)throw new HttpError(422,'Entrada, saída e transferência exigem quantidade positiva.');if(tipo==='ajuste'&&quantidade===0)throw new HttpError(422,'Ajuste com quantidade zero é inválido.');return{tipo,quantidade};}
export function calcularDeltaSaldo(quantidadeAtual:number,quantidadeAlvo:number){if(!Number.isFinite(quantidadeAtual)||quantidadeAtual<0)throw new HttpError(422,'Saldo atual inválido.');if(!Number.isFinite(quantidadeAlvo)||quantidadeAlvo<0)throw new HttpError(422,'Saldo alvo inválido.');return quantidadeAlvo-quantidadeAtual;}
function findProductByKey(products:Row[],value:unknown){const k=normal(value);return k?products.find(p=>normal(p.sku)===k||normal(p.codigo_barras)===k)??null:null;}
function findRef(rows:Row[],value:unknown,keys:string[]=['nome','codigo','descricao']){
 const k=normal(value);return k?rows.find(r=>keys.some(key=>normal(r[key])===k))??null:null;
}
function cleanEmpty(obj:Record<string,unknown>){for(const [k,v] of Object.entries(obj))if(v===''||v===undefined||v===null)delete obj[k];return obj;}
function productImportPayload(m:Record<string,unknown>,extras:Record<string,unknown>,r:Resource,refs:{categorias:Row[];colecoes:Row[];cores:Row[];fornecedores:Row[]}){
 const payload=payloadProduto(m,extras,refs,r);
 if(m.formato!==undefined&&m.formato!==null&&String(m.formato).trim()!==''&&field(r,'formato'))payload.formato=m.formato;
 if(m.ativo!==undefined&&m.ativo!==null&&String(m.ativo).trim()!==''&&field(r,'ativo'))payload.ativo=m.ativo;
 if(m.peso_g!==undefined&&m.peso_g!==null&&String(m.peso_g).trim()!==''&&field(r,'peso_g'))payload.peso_g=parseNum(m.peso_g);
 if(m.custo_aquisicao!==undefined&&m.custo_aquisicao!==null&&String(m.custo_aquisicao).trim()!==''&&field(r,'custo'))payload.custo=parseNum(m.custo_aquisicao);
 if(m.preco_promocional!==undefined&&m.preco_promocional!==null&&String(m.preco_promocional).trim()!==''&&field(r,'preco_promocional'))payload.preco_promocional=parseNum(m.preco_promocional);
 if(m.margem!==undefined&&m.margem!==null&&String(m.margem).trim()!==''&&field(r,'margem'))payload.margem=parseNum(m.margem);
 if(m.tipo!==undefined&&m.tipo!==null&&String(m.tipo).trim()!==''&&field(r,'tipo'))payload.tipo=m.tipo;
 if(m.variacao_tamanho_id!==undefined&&field(r,'variacao_tamanho_id'))payload.variacao_tamanho_id=m.variacao_tamanho_id;
 const preservados={...extras};for(const [key,rows] of [['categoria',refs.categorias],['colecao',refs.colecoes],['cor',refs.cores],['fornecedor',refs.fornecedores]] as const)if(m[key]!==undefined&&!findByName(rows,m[key]))preservados[key+'_origem']=m[key];for(const k of ['custo_fabricacao','custo_adicional','imposto','margem'])if(m[k]!==undefined&&!field(r,k))preservados[k+'_origem']=m[k];
 if(field(r,'atributos_adicionais'))payload.atributos_adicionais=preservados;
 return cleanEmpty(payload);
}
async function auditImport(s:any,tx:Tx,actor:Actor,empresaId:number,r:Resource,rowId:number,source:{sessionId:string;sheet:string;line:number;sha:string;operation:string;key?:string}){
 await s.audit({usuario_id:actor.id??null,usuario:actor.name,acao:'importar',recurso:r.key,registro_id:rowId,descricao:'Importação universal: '+source.operation,empresa_id:empresaId,dados:{sessao:source.sessionId,arquivo_sha256:source.sha,aba:source.sheet,linha:source.line,chave:source.key??null,operacao:source.operation}},tx);
}

export async function executarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);if(!user)throw new HttpError(403,'Usuário sem empresa ativa para executar importação.');
 const empresaId=Number(user.empresa_id);if(!Number.isInteger(empresaId)||empresaId<=0)throw new HttpError(403,'Usuário sem empresa ativa para executar importação.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new HttpError(400,'ID de sessão inválido.');
 const s=getStore();if(s.kind!=='postgres')throw new HttpError(503,'Executor universal exige sessão persistida no PostgreSQL.');
 let completed:any=null;
 try{
  completed=await s.transaction(async(tx)=>{
   if(!tx)throw new HttpError(503,'Transação PostgreSQL indisponível.');
   const lock=await tx.query(`SELECT id,empresa_id,usuario_id,status,versao,sha256,interpretacao,reconciliacao,preview,inventario_abas,resultado
    FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 FOR UPDATE`,[id,empresaId,user.id]);
   if(!lock.rows.length)throw new HttpError(404,'Sessão não encontrada.');
   const session=lock.rows[0] as Session;
   if(session.status==='concluido'||session.status==='importado')return{alreadyCompleted:true,result:session.resultado,versao:Number(session.versao)};
   if(session.status!=='aprovado')throw new HttpError(409,'Somente sessões aprovadas podem executar. Status atual: '+session.status);
   const interpret=session.interpretacao||{},confirmed=interpret.mapeamentoConfirmado,recon=session.reconciliacao,approval=session.preview?.aprovacao;
   if(!confirmed||!recon||!approval?.hash||!Array.isArray(recon.divergencias))throw new HttpError(409,'Checkpoint de aprovação incompleto. Reconcile e aprove novamente.');
   const hash=hashAprovacaoImportacaoUniversal(session.id,empresaId,String(session.sha256),Number(approval.versao),confirmed,recon);
   if(hash!==approval.hash)throw new HttpError(409,'Hash da aprovação não corresponde aos dados persistidos. Reconcile e aprove novamente.');
   const blocking=recon.divergencias.filter((d:any)=>BLOQUEADORES.has(String(d.tipo)));
   const pendingDependencies=(recon.dependencias||[]).filter((d:any)=>['sku','variacao','estoque','preco','movimentacao'].includes(String(d.tipo))&&d.estado==='pendente'&&Array.isArray(d.bloqueios)&&d.bloqueios.length>0);
   if(blocking.length||pendingDependencies.length)throw new HttpError(409,'Importação bloqueada por divergências ou dependências pendentes.',{bloqueadores:blocking,dependencias:pendingDependencies});
   const started=await tx.query(`UPDATE importacao_universal_sessoes SET status='importando',importacao_iniciada_em=COALESCE(importacao_iniciada_em,now()),atualizado_em=now() WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 AND status='aprovado' AND versao=$4 RETURNING id`,[id,empresaId,user.id,Number(session.versao)]);if(!started.rows.length)throw new HttpError(409,'A sessão perdeu o gate de execução; nenhuma gravação foi iniciada.');
   const mappings:Mapping[]=confirmed.mapeamentos||[],entities:any[]=confirmed.entidades||[],relations:Relation[]=confirmed.relacionamentos||[];
   const rowsBySheet=new Map<string,SheetRow[]>((session.inventario_abas||[]).map((a:any)=>[String(a.nome),Array.isArray(a.linhas)?a.linhas:[]]));
   const types=['produto','sku','variacao','preco','estoque','movimentacao','cliente','fornecedor','tabela_generica'];
   const report:{total:number;criados:number;atualizados:number;ignorados:number;porEntidade:Record<string,{criados:number;atualizados:number;ignorados:number}>;linhas:any[];iniciadoEm:string;finalizadoEm?:string}={total:0,criados:0,atualizados:0,ignorados:0,porEntidade:{},linhas:[],iniciadoEm:new Date().toISOString()};
   for(const t of types)report.porEntidade[t]={criados:0,atualizados:0,ignorados:0};
   const sessionMeta={id,sha:String(session.sha256)};
   const entityRows=entities.flatMap(e=>types.includes(String(e.tipo))?(rowsBySheet.get(String(e.aba))||[]).map(row=>({aba:String(e.aba),tipo:String(e.tipo),row})):[]);
   report.total=entityRows.length;
   const productosResource=getResource('produtos')!,stockResource=getResource('estoques')!,movementResource=getResource('movimentacoes')!;
   const productRows=entityRows.filter(x=>x.tipo==='produto');
   // SKU-only tabs are dependent identifiers; they materialize as child SKUs, not duplicate parent products.
   const variationRows=entityRows.filter(x=>['sku','variacao'].includes(x.tipo));
   const priceRows=entityRows.filter(x=>x.tipo==='preco');
   const stockRows=entityRows.filter(x=>x.tipo==='estoque');
   const movementRows=entityRows.filter(x=>x.tipo==='movimentacao');
   const customerRows=entityRows.filter(x=>x.tipo==='cliente'),supplierRows=entityRows.filter(x=>x.tipo==='fornecedor');
   const products=await fetchAll(s,productosResource,empresaId,tx);
   const refs={categorias:await fetchAll(s,getResource('categorias')!,empresaId,tx),colecoes:await fetchAll(s,getResource('colecoes')!,empresaId,tx),cores:await fetchAll(s,getResource('cores')!,empresaId,tx),fornecedores:await fetchAll(s,getResource('fornecedores')!,empresaId,tx)};
   const tamanhos=await fetchAll(s,getResource('tamanhos')!,empresaId,tx),locais=await fetchAll(s,getResource('locais')!,empresaId,tx);
   const tamanhosMap=new Map(tamanhos.map(t=>[normal(t.codigo),t])),locaisMap=new Map(locais.filter(l=>l.empresa_id===empresaId&&l.ativo!==false).map(l=>[normal(l.nome),l]));
   const processResult=(tipo:string,aba:string,linha:number,acao:'criados'|'atualizados'|'ignorados',idRegistro?:number,detalhe?:string)=>{
    report[acao]++;report.porEntidade[tipo][acao]++;
    report.linhas.push({entidade:tipo,aba,linha,acao,id:idRegistro??null,detalhe:detalhe??null});
   };

   for(const item of productRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),sku=String(mapped.sku??'').trim();
    if(!sku||!String(mapped.nome??'').trim())throw new HttpError(422,`Produto/SKU incompleto em ${item.aba} linha ${item.row.linhaOrigem}: SKU e nome são obrigatórios.`);
    const fontesCusto=['custo','custo_aquisicao','custo_fabricacao'].filter(k=>mapped[k]!==undefined&&mapped[k]!==null&&String(mapped[k]).trim()!=='');if(fontesCusto.length>1)throw new HttpError(422,`Mais de uma coluna de custo foi mapeada para o mesmo produto (${item.aba} linha ${item.row.linhaOrigem}); resolva a ambiguidade antes de importar.`);
    const payload=productImportPayload(mapped,buildExtraAttributes(item.row.valores,item.aba,mappings),productosResource,refs);
    const existing=findBySku(products,sku);
    if(existing){
     if(payload.atributos_adicionais&&existing.atributos_adicionais&&typeof existing.atributos_adicionais==='object')payload.atributos_adicionais={...existing.atributos_adicionais,...payload.atributos_adicionais};
     const data=validatePayload(productosResource,payload,'update');
     await validarReferenciasDaEmpresa(productosResource,data,{empresaId,consolidado:false,permitidas:[empresaId]},(target,targetId,empresa,t)=>s.findOneWhere(target,{id:targetId,empresa_id:empresa},t),tx);
     const updated=await s.update(productosResource,Number(existing.id),data,tx);
     if(!updated)throw new HttpError(409,`Produto ${sku} deixou de existir durante a importação.`);
     await auditImport(s,tx,user as Actor,empresaId,productosResource,Number(existing.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:'produto atualizado',key:sku});
     Object.assign(existing,updated);processResult(item.tipo,item.aba,item.row.linhaOrigem,'atualizados',Number(existing.id),sku);
    }else{
     const created=await createRecord(productosResource,payload,user as Actor,{escopo:escopoDe(user as any),tx});
     products.push(created);await auditImport(s,tx,user as Actor,empresaId,productosResource,Number(created.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:'produto criado',key:sku});
     processResult(item.tipo,item.aba,item.row.linhaOrigem,'criados',Number(created.id),sku);
    }
   }
   const findParentForSheet=(aba:string,row:SheetRow,preferRelation=false):Row|null=>{
    const direct=mapSheetRow(row,aba,mappings);
    if(!preferRelation&&direct.sku){const bySku=findBySku(products,direct.sku);if(bySku)return bySku;}
    for(const rel of relations.filter(r=>r.confirmado)){
     const forward=rel.origemAba===aba,reverse=rel.destinoAba===aba,productSheetCandidate=forward?rel.destinoAba:rel.origemAba;
     const productIsEntity=entities.some((e:any)=>e.aba===productSheetCandidate&&['produto','sku'].includes(String(e.tipo)));if(!(forward||reverse)||!productIsEntity)continue;
     const sourceVal=rowValue(row,forward?rel.campoOrigem:rel.campoDestino);if(sourceVal===undefined||sourceVal===null||String(sourceVal).trim()==='')continue;
     const productSheet=forward?rel.destinoAba:rel.origemAba,productField=forward?rel.campoDestino:rel.campoOrigem;
     const productSheetRows=rowsBySheet.get(productSheet)||[];
     const match=productSheetRows.find(d=>normal(rowValue(d,productField))===normal(sourceVal));if(!match)continue;
     const destMapped=mapSheetRow(match,productSheet,mappings);
     const found=findProductByKey(products,destMapped.sku??destMapped.codigo_barras??rowValue(match,productField));if(found)return found;
    }
    if(direct.sku)return findBySku(products,direct.sku);
    return null;
   };
   for(const item of variationRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),parent=findParentForSheet(item.aba,item.row,true),sku=String(mapped.sku??'').trim();
    if(!parent||!sku)throw new HttpError(422,`SKU/variação sem SKU ou produto-pai resolvido em ${item.aba} linha ${item.row.linhaOrigem}.`);
    if(normal(sku)===normal(parent.sku)){processResult(item.tipo,item.aba,item.row.linhaOrigem,'ignorados',Number(parent.id),'SKU corresponde ao próprio produto-pai; vínculo de referência, nenhum filho duplicado criado.');continue;}
    const sizeRaw=mapped.tamanho,size=sizeRaw===undefined||String(sizeRaw).trim()===''?null:tamanhosMap.get(normal(sizeRaw));
    if(sizeRaw!==undefined&&String(sizeRaw).trim()!==''&&!size)throw new HttpError(422,`Tamanho "${String(sizeRaw)}" não existe no cadastro ERP (linha ${item.row.linhaOrigem}).`);
    const colorRaw=mapped.cor,color= colorRaw===undefined||String(colorRaw).trim()===''?null:findRef(refs.cores,colorRaw,['nome','codigo']),cor=colorRaw===undefined||String(colorRaw).trim()===''?parent.cor:colorRaw;
    const chave=[normal(cor),normal(sizeRaw)].filter(Boolean).join('|')||sku;
    const existing=findBySku(products,sku);
    const childPayload:Record<string,unknown>={sku,nome:String(mapped.nome??'').trim()||String(parent.nome??sku),formato:'simples',origem_dados:'importacao',cor:cor??null,cor_id:color?.id??parent.cor_id??null,variacao_tamanho_id:size?.id??null};
    for(const inherited of ['categoria_id','colecao_id','custo','preco_venda','preco_atacado','atacado_min_qtd','marca','descricao','composicao','material','modelagem','genero','tipo','grade_id'])if(parent[inherited]!==undefined&&parent[inherited]!==null)childPayload[inherited]=parent[inherited];
    if(field(productosResource,'codigo_barras')&&mapped.codigo_barras)childPayload.codigo_barras=mapped.codigo_barras;
    if(field(productosResource,'atributos_adicionais'))childPayload.atributos_adicionais=buildExtraAttributes(item.row.valores,item.aba,mappings);
    let child:Row;
    if(existing){
     if(Number(existing.produto_pai_id)!==Number(parent.id))throw new HttpError(409,`SKU ${sku} já existe, mas não é filho do produto ${parent.sku}.`);
     const data=validatePayload(productosResource,childPayload,'update'),updated=await s.update(productosResource,Number(existing.id),data,tx);if(!updated)throw new HttpError(409,`Variação ${sku} não pôde ser atualizada.`);const linked=await s.update(productosResource,Number(existing.id),{produto_pai_id:Number(parent.id),variacao_chave:chave,variacao_tamanho_id:size?.id??null},tx);Object.assign(existing,updated,linked||{});child=existing;
     processResult(item.tipo,item.aba,item.row.linhaOrigem,'atualizados',Number(child.id),sku);
    }else{
     child=await createRecord(productosResource,childPayload,user as Actor,{escopo:escopoDe(user as any),tx});
     child=(await s.update(productosResource,Number(child.id),{produto_pai_id:Number(parent.id),variacao_chave:chave,variacao_tamanho_id:size?.id??null},tx))??child;
     products.push(child);processResult(item.tipo,item.aba,item.row.linhaOrigem,'criados',Number(child.id),sku);
    }
    if(String(parent.formato)!=='variacao')await s.update(productosResource,Number(parent.id),{formato:'variacao'},tx);
    await auditImport(s,tx,user as Actor,empresaId,productosResource,Number(child.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:'variação criada/atualizada',key:sku});
   }

   for(const item of priceRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),product=findParentForSheet(item.aba,item.row);
    if(!product)throw new HttpError(422,`Preço sem produto resolvido em ${item.aba} linha ${item.row.linhaOrigem}.`);
    const fontesCusto=['custo','custo_aquisicao','custo_fabricacao'].filter(k=>mapped[k]!==undefined&&mapped[k]!==null&&String(mapped[k]).trim()!=='');if(fontesCusto.length>1)throw new HttpError(422,`Mais de uma coluna de custo foi mapeada para o mesmo produto (${item.aba} linha ${item.row.linhaOrigem}); resolva a ambiguidade.`);
    const priceFields=['custo','custo_aquisicao','preco_venda','preco_atacado','preco_promocional','qtd_min_atacado'];
    const data:Record<string,unknown>={},extras:Record<string,unknown>={};
    for(const f of priceFields)if(mapped[f]!==undefined&&mapped[f]!==null&&String(mapped[f]).trim()!==''){const target=f==='custo_aquisicao'?'custo':f==='qtd_min_atacado'?'atacado_min_qtd':f;if(field(productosResource,target))data[target]=mapped[f];}
    for(const k of ['custo_fabricacao','custo_adicional','imposto','margem'])if(mapped[k]!==undefined&&!field(productosResource,k))extras[k+'_origem']=mapped[k];
    if(Object.keys(extras).length&&field(productosResource,'atributos_adicionais'))data.atributos_adicionais={...(product.atributos_adicionais&&typeof product.atributos_adicionais==='object'?product.atributos_adicionais:{}),...extras};
    const conditionPrices=[
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
     {field:'preco_varejo_cartao_parcelado',canal:'varejo',condicao:'cartao_parcelado',min:1}
    ];
    let conditionRowsUpserted=0;
    for(const cp of conditionPrices){
     const raw=mapped[cp.field];if(raw===undefined||raw===null||String(raw).trim()==='')continue;
     const preco=parseNum(raw);if(preco<0)throw new HttpError(422,`Preço negativo inválido (${cp.field}) em ${item.aba} linha ${item.row.linhaOrigem}.`);
     const marginRaw=cp.marginField?mapped[cp.marginField]:undefined,margem=marginRaw===undefined||marginRaw===null||String(marginRaw).trim()===''?null:parseNum(marginRaw);
     await tx.query(`INSERT INTO produto_precos_condicao (empresa_id,produto_id,canal,condicao,preco,origem,criado_por,quantidade_minima,margem_pct,regra_calculo) VALUES ($1,$2,$3,$4,$5,'importacao_universal',$6,$7,$8,$9::jsonb) ON CONFLICT (empresa_id,produto_id,canal,condicao,quantidade_minima) WHERE vigencia_fim IS NULL DO UPDATE SET preco=EXCLUDED.preco,origem=EXCLUDED.origem,atualizado_em=now(),atualizado_por=EXCLUDED.criado_por,margem_pct=EXCLUDED.margem_pct,regra_calculo=EXCLUDED.regra_calculo`,[empresaId,Number(product.id),cp.canal,cp.condicao,preco,user.id,cp.min,margem,JSON.stringify({origemPlanilha:item.aba,linha:item.row.linhaOrigem,campoPreco:cp.field,condicao:cp.condicao,quantidadeMinima:cp.min,marginSource:cp.marginField??null})]);
     conditionRowsUpserted++;
    }
    if(!Object.keys(data).length&&!conditionRowsUpserted){processResult(item.tipo,item.aba,item.row.linhaOrigem,'ignorados',Number(product.id),'Nenhum campo de preço reconhecido.');continue;}
    if(Object.keys(data).length){
     const validated=validatePayload(productosResource,data,'update');
     await validarReferenciasDaEmpresa(productosResource,validated,{empresaId,consolidado:false,permitidas:[empresaId]},(target,targetId,empresa,t)=>s.findOneWhere(target,{id:targetId,empresa_id:empresa},t),tx);
     const updated=await s.update(productosResource,Number(product.id),validated,tx);if(!updated)throw new HttpError(409,'Produto desapareceu durante a atualização de preços.');
     Object.assign(product,updated);
    }
    await auditImport(s,tx,user as Actor,empresaId,productosResource,Number(product.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:'preço/condições atualizados',key:String(product.sku)});
    processResult(item.tipo,item.aba,item.row.linhaOrigem,'atualizados',Number(product.id),`${String(product.sku)}; ${conditionRowsUpserted} condições comerciais`);
   }
   for(const item of movementRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),product=findParentForSheet(item.aba,item.row);
    if(mapped.data!==undefined&&mapped.data!==null&&String(mapped.data).trim()!==''&&field(movementResource,'data')?.readonly)throw new HttpError(409,`A data de origem da movimentação não pode ser importada: o campo data do ledger ERP é somente leitura e seria substituído pela data de execução (${item.aba} linha ${item.row.linhaOrigem}). Desmarque movimentações históricas ou use migração específica de ledger.`);
    if(!product)throw new HttpError(422,`Movimentação sem produto resolvido em ${item.aba} linha ${item.row.linhaOrigem}.`);
    const local=findRef(locais,String(mapped.local??''),['nome']);
    if(!local||Number(local.empresa_id)!==empresaId||local.ativo===false)throw new HttpError(422,`Local inexistente/inativo na movimentação (${item.aba} linha ${item.row.linhaOrigem}).`);
    const sizeRaw=mapped.tamanho,size=sizeRaw===undefined||String(sizeRaw).trim()===''?null:tamanhosMap.get(normal(sizeRaw));
    if(sizeRaw!==undefined&&String(sizeRaw).trim()!==''&&!size)throw new HttpError(422,`Tamanho inexistente na movimentação (${item.aba} linha ${item.row.linhaOrigem}).`);
    const {tipo,quantidade:qtd}=validarQuantidadeMovimentacao(mapped.tipo,mapped.quantidade);
    const data:Record<string,unknown>={tipo,produto_id:Number(product.id),tamanho_id:size?.id??product.variacao_tamanho_id??null,local:String(local.nome),local_id:Number(local.id),quantidade:qtd,motivo:String(mapped.descricao??mapped.motivo??'Importação universal')};
    if(tipo==='transferencia'){
     const destination=findRef(locais,mapped.local_destino,['nome']);if(!destination||Number(destination.empresa_id)!==empresaId||destination.ativo===false)throw new HttpError(422,`Destino inválido na transferência (${item.aba} linha ${item.row.linhaOrigem}).`);
     data.local_destino=String(destination.nome);data.local_destino_id=Number(destination.id);
    }
    const mov=await lancarMovimentacaoDentro(data,user as Actor,tx,escopoDe(user as any));
    await auditImport(s,tx,user as Actor,empresaId,movementResource,Number(mov.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:'movimentação registrada',key:String(product.sku)});
    processResult(item.tipo,item.aba,item.row.linhaOrigem,'criados',Number(mov.id),`${tipo} ${qtd} — ${String(product.sku)}`);
   }
   for(const item of stockRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),product=findParentForSheet(item.aba,item.row);
    if(!product)throw new HttpError(422,`Saldo sem produto resolvido em ${item.aba} linha ${item.row.linhaOrigem}.`);
    const local=locaisMap.get(normal(mapped.local));
    if(!local||Number(local.empresa_id)!==empresaId||local.ativo===false)throw new HttpError(422,`Local inexistente/inativo no saldo (${item.aba} linha ${item.row.linhaOrigem}).`);
    const sizeRaw=mapped.tamanho,size=sizeRaw===undefined||String(sizeRaw).trim()===''?null:tamanhosMap.get(normal(sizeRaw));
    if(sizeRaw!==undefined&&String(sizeRaw).trim()!==''&&!size)throw new HttpError(422,`Tamanho inexistente no saldo (${item.aba} linha ${item.row.linhaOrigem}).`);
    const sizeId=size?.id??product.variacao_tamanho_id??null,target=parseNumber(mapped.quantidade);
    if(target===null||!Number.isFinite(target))throw new HttpError(422,`Quantidade de saldo inválida (${item.aba} linha ${item.row.linhaOrigem}).`);
    const cell=await s.findOneWhere(stockResource,{empresa_id:empresaId,produto_id:Number(product.id),tamanho_id:sizeId,local_id:Number(local.id)},tx);
    const current=Number(cell?.quantidade??0),delta=calcularDeltaSaldo(current,target);
    if(delta!==0){
     await lancarMovimentacaoDentro({tipo:'ajuste',produto_id:Number(product.id),tamanho_id:sizeId,local:String(local.nome),local_id:Number(local.id),quantidade:delta,motivo:`Importação universal — saldo absoluto ${target}; anterior ${current}`},user as Actor,tx,escopoDe(user as any));
    }
    processResult(item.tipo,item.aba,item.row.linhaOrigem,delta===0?'ignorados':'atualizados',cell?.id===undefined?undefined:Number(cell.id),`Saldo ajustado ${current} → ${target} (delta ${delta})`);
   }

   const genericRows=[...customerRows,...supplierRows];
   const existingGenericRowsByType=new Map<string,Row[]>();
   for(const item of genericRows){
    const mapped=mapSheetRow(item.row,item.aba,mappings),resource=getResource(item.tipo==='cliente'?'clientes':'fornecedores')!;
    const documentKey=item.tipo==='cliente'?normalizarDocumentoImportacao(mapped.cnpj_cpf):normalizarDocumentoImportacao(mapped.cnpj_cpf??mapped.cnpj);
    const documentField=item.tipo==='cliente'?'cnpj_cpf':'cnpj';
    const emailKey=String(mapped.email??'').trim().toLowerCase();
    if(!documentKey&&!emailKey)throw new HttpError(422,'Importacao de '+item.tipo+' exige documento ou e-mail para garantir idempotencia ('+item.aba+' linha '+item.row.linhaOrigem+').');
    let existingRows=existingGenericRowsByType.get(item.tipo);
    if(!existingRows){existingRows=await fetchAll(s,resource,empresaId,tx);existingGenericRowsByType.set(item.tipo,existingRows);}
    const match=documentKey?findByNormalizedDocument(existingRows,documentField,documentKey,empresaId):existingRows.find(r=>Number(r.empresa_id)===empresaId&&String(r.email??'').trim().toLowerCase()===emailKey)??null;
    if(match){processResult(item.tipo,item.aba,item.row.linhaOrigem,'ignorados',Number(match.id),'Registro ja existente; importacao nao sobrescreve dados cadastrais automaticamente.');continue;}
    const payload:Record<string,unknown>={};
    const allowed=new Set(resource.fields.map(f=>f.name));
    for(const [key,value] of Object.entries(mapped)){
     const target=key==='cnpj_cpf'&&item.tipo==='fornecedor'?'cnpj':key;
     if(allowed.has(target)&&value!==undefined&&value!==null&&String(value).trim()!=='')payload[target]=value;
    }
    if(!payload.nome)throw new HttpError(422,`Cadastro ${item.tipo} sem nome (${item.aba} linha ${item.row.linhaOrigem}).`);
    const created=await createRecord(resource,payload,user as Actor,{escopo:escopoDe(user as any),tx});
    existingRows.push(created);
    await auditImport(s,tx,user as Actor,empresaId,resource,Number(created.id),{sessionId:id,sheet:item.aba,line:item.row.linhaOrigem,sha:sessionMeta.sha,operation:item.tipo+' criado',key:documentKey||emailKey});
    processResult(item.tipo,item.aba,item.row.linhaOrigem,'criados',Number(created.id),documentKey||emailKey);
   }
   for(const item of entityRows.filter(x=>x.tipo==='tabela_generica'))processResult(item.tipo,item.aba,item.row.linhaOrigem,'ignorados',undefined,'Tabela genérica: dados mantidos no arquivo original; destino ERP não definido.');
   report.finalizadoEm=new Date().toISOString();
   await s.audit({usuario_id:user.id,usuario:user.name,acao:'importar',recurso:'importacao_universal_sessoes',registro_id:null,descricao:'Importação universal concluída atomically',empresa_id:empresaId,dados:{sessionId:id,fileSha256:sessionMeta.sha,totais:report.porEntidade,summary:{total:report.total,created:report.criados,updated:report.atualizados,skipped:report.ignorados}}},tx);
   const resultPayload={version:1,sessionId:id,fileSha256:sessionMeta.sha,summary:{total:report.total,created:report.criados,updated:report.atualizados,skipped:report.ignorados},entities:report.porEntidade,rows:report.linhas,startedAt:report.iniciadoEm,finishedAt:report.finalizadoEm,atomic:true,idempotent:true};
   const saved=await tx.query(`UPDATE importacao_universal_sessoes SET status='concluido',resultado=$4::jsonb,importacao_iniciada_em=COALESCE(importacao_iniciada_em,now()),importacao_finalizada_em=now(),versao=versao+1,atualizado_em=now(),erro=NULL WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 AND status='importando' AND versao=$5 RETURNING versao`,[id,empresaId,user.id,JSON.stringify(resultPayload),Number(session.versao)]);
   if(!saved.rows.length)throw new HttpError(409,'A sessão não pôde finalizar por alteração concorrente. A transação foi revertida.');
   return{alreadyCompleted:false,result:resultPayload,versao:Number(saved.rows[0].versao)};
  });
  res.json({id,status:completed.alreadyCompleted?'concluido':'concluido',idempotente:completed.alreadyCompleted===true,resultado:completed.result,versao:completed.versao,gravacaoAtomica:true});
 }catch(error:any){
  const message=String(error?.message||error).slice(0,4000);
  await queryDb(`UPDATE importacao_universal_sessoes SET status='falhou',erro=$4,resultado=COALESCE(resultado,'{}'::jsonb)||$5::jsonb,atualizado_em=now() WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 AND status='aprovado'`,[id,empresaId,user.id,message,JSON.stringify({version:1,atomicRollback:true,failedAt:new Date().toISOString(),error:message})]).catch(()=>undefined);
  throw error instanceof HttpError?error:new HttpError(500,'Importação universal falhou. A transação foi revertida.',{detalhe:message});
 }
}

export async function retryImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);if(!user)throw new HttpError(403,'Usuário sem empresa ativa para retomar importação.');const empresaId=Number(user.empresa_id);if(!Number.isInteger(empresaId)||empresaId<=0)throw new HttpError(403,'Usuário sem empresa ativa para retomar importação.');
 const id=String(req.params?.id||'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))throw new HttpError(400,'ID de sessão inválido.');
 const result=await queryDb(`SELECT id,status,versao,sha256,interpretacao,reconciliacao,preview FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,empresaId,user.id]);
 if(!result.rows.length)throw new HttpError(404,'Sessão não encontrada.');
 const row=result.rows[0];if(row.status!=='falhou')throw new HttpError(409,'Somente uma importação com falha pode ser retomada.');
 const approval=row.preview?.aprovacao,confirmed=row.interpretacao?.mapeamentoConfirmado,recon=row.reconciliacao;
 if(!approval?.hash||!confirmed||!recon)throw new HttpError(409,'Checkpoint de aprovação ausente; faça uma nova reconciliação e aprovação.');
 const hash=hashAprovacaoImportacaoUniversal(row.id,empresaId,String(row.sha256),Number(approval.versao),confirmed,recon);
 if(hash!==approval.hash)throw new HttpError(409,'A aprovação não corresponde mais aos dados. Reconcile e aprove novamente.');
 const saved=await queryDb(`UPDATE importacao_universal_sessoes SET status='aprovado',erro=NULL,versao=versao+1,atualizado_em=now() WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 AND status='falhou' AND versao=$4 RETURNING versao`,[id,empresaId,user.id,Number(row.versao)]);
 if(!saved.rows.length)throw new HttpError(409,'Sessão alterada em paralelo; atualize e tente novamente.');
 res.json({id,status:'aprovado',versao:Number(saved.rows[0].versao),approvalHash:approval.hash,retomada:true,gravacaoExecutada:false});
}
