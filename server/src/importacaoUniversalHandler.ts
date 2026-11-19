import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { query as queryDb } from './db';
import { currentUser } from './auth';
import { analisarArquivoUniversal } from './importacaoUniversalAnalise';
import { HttpError } from './errors';

const MAX_BYTES=2.5*1024*1024;
const ALLOWED_EXT=new Set(['xlsx','xlsm','csv']);

export async function analisarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa para importação.');
 const nome=String(req.body?.nomeArquivo||'').trim();
 const mime=String(req.body?.mimeType||'application/octet-stream').trim().slice(0,180);
 const base64=String(req.body?.arquivoBase64||'').trim();
 if(!nome||nome.length>255) throw new HttpError(400,'Nome do arquivo obrigatório (máximo 255 caracteres).');
 const ext=nome.toLowerCase().split('.').pop()||'';
 if(!ALLOWED_EXT.has(ext)) throw new HttpError(400,'Formato não suportado. Envie XLSX, XLSM ou CSV.');
 if(!base64||base64.length>Math.ceil(MAX_BYTES*4/3)+8||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new HttpError(400,'Conteúdo base64 inválido ou acima do limite.');
 const bytes=Buffer.from(base64,'base64');
 if(!bytes.length||bytes.length>MAX_BYTES) throw new HttpError(400,'Arquivo vazio ou acima de 2,5 MB.');
 const canonical=bytes.toString('base64');
 if(canonical.replace(/=+$/,'')!==base64.replace(/=+$/,'')) throw new HttpError(400,'Base64 inválido.');
 const id=randomUUID();
 const sha=await (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
 try{
  await queryDb(`INSERT INTO importacao_universal_sessoes
   (id,empresa_id,usuario_id,nome_arquivo,mime_type,tamanho_bytes,sha256,arquivo_original,status)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,'analisando')`,
   [id,user.empresa_id,user.id,nome,mime,bytes.length,sha,bytes]);
 }catch(err:any){
  if(String(err?.code)==='23505') throw new HttpError(409,'Este arquivo já foi enviado para esta empresa e usuário. Reutilize a sessão anterior.');
  throw err;
 }
 try{
  const analise=await analisarArquivoUniversal({nomeArquivo:nome,bytes,maxBytes:MAX_BYTES});
  await queryDb(`UPDATE importacao_universal_sessoes SET status='aguardando_mapeamento',
   inventario_abas=$2::jsonb,interpretacao=$3::jsonb,preview=$4::jsonb,atualizado_em=now()
   WHERE id=$1 AND empresa_id=$5 AND usuario_id=$6`,
   [id,JSON.stringify(analise.arquivo.abas.map(a=>({nome:a.nome,indice:a.indice,totalLinhas:a.totalLinhas,totalColunas:a.totalColunas,linhaCabecalho:a.linhaCabecalho,cabecalhos:a.cabecalhos,vazia:a.vazia,linhas:a.linhas}))),
    JSON.stringify({semantica:analise.semantica,entidades:analise.entidades}),JSON.stringify({resumo:analise.resumo,bloqueios:analise.bloqueios}),user.empresa_id,user.id]);
  res.status(201).json({id,status:'aguardando_mapeamento',analise});
 }catch(err){
  await queryDb(`UPDATE importacao_universal_sessoes SET status='falhou',erro=$2,atualizado_em=now()
   WHERE id=$1 AND empresa_id=$3 AND usuario_id=$4`,[id,String((err as Error)?.message||err).slice(0,4000),user.empresa_id,user.id]).catch(()=>undefined);
  throw err;
 }
}

export async function reconciliarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa para reconciliação.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'ID de sessão inválido.');
 const session=await queryDb(`SELECT id,status,nome_arquivo,mime_type,tamanho_bytes,sha256,inventario_abas,interpretacao FROM importacao_universal_sessoes
  WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,user.empresa_id,user.id]);
 if(!session.rows.length) throw new HttpError(404,'Sessão de importação não encontrada.');
 const row=session.rows[0];
 if(!row.inventario_abas||!row.interpretacao) throw new HttpError(409,'Sessão não possui inventário e interpretação completos.');
 if(row.status!=='aguardando_mapeamento'&&row.status!=='aguardando_aprovacao') throw new HttpError(409,'A sessão não está em um estado permitido para reconciliação.');
 const {getStore}=await import('./services');
 const {RESOURCES}=await import('./resources');
 const {reconciliarImportacaoUniversal}=await import('./importacaoUniversalRecon');
 const store=getStore();
 const fetchAll=async(resource:any,empresaScoped=false)=>{
  const all:any[]=[];let page=1;const pageSize=500;
  while(true){const result=await store.list(resource,{page,pageSize,sort:'id',dir:'asc',filter:empresaScoped?{empresa_id:user.empresa_id}:undefined},undefined);
   all.push(...result.rows);if(all.length>=result.total||result.rows.length===0)break;page++;
  }return all;
 };
 const [products,stocks,sizes,locations]=await Promise.all([fetchAll(RESOURCES.produtos,true),fetchAll(RESOURCES.estoques,true),fetchAll(RESOURCES.tamanhos),fetchAll(RESOURCES.locais,true)]);
 const produtoById=new Map(products.map((p:any)=>[Number(p.id),p]));
 const tamanhoById=new Map(sizes.map((t:any)=>[Number(t.id),t]));
 const localById=new Map(locations.map((l:any)=>[Number(l.id),l]));
 const produtosERP=products.map((p:any)=>({id:Number(p.id),sku:String(p.sku||''),nome:String(p.nome||''),codigo_barras:p.codigo_barras??null,cor:p.cor??null,tamanho:null,custo:p.custo==null?null:Number(p.custo),preco_venda:p.preco_venda==null?null:Number(p.preco_venda),ativo:p.ativo!==false}));
 const saldosERP=stocks.map((s:any)=>{const p=produtoById.get(Number(s.produto_id)) as any;const t=s.tamanho_id==null?null:tamanhoById.get(Number(s.tamanho_id)) as any;const l=s.local_id==null?null:localById.get(Number(s.local_id)) as any;return{produto_id:Number(s.produto_id),sku:String(p?.sku||''),tamanho_id:s.tamanho_id==null?null:Number(s.tamanho_id),tamanho:t?.codigo??null,local_id:s.local_id==null?null:Number(s.local_id),local:l?.nome??s.local??null,quantidade:Number(s.quantidade||0)};});
 const tipoArquivo: 'csv'|'xlsx'=String(row.nome_arquivo).toLowerCase().endsWith('.csv')?'csv':'xlsx';
 const arquivo={nome:String(row.nome_arquivo),sha256:String(row.sha256),tamanhoBytes:Number(row.tamanho_bytes),tipo:tipoArquivo,abas:row.inventario_abas as any};
 const interpretacao=row.interpretacao as any;
 const result=reconciliarImportacaoUniversal(arquivo,interpretacao.semantica,interpretacao.entidades,produtosERP,saldosERP);
 await queryDb(`UPDATE importacao_universal_sessoes SET reconciliacao=$2::jsonb,status='aguardando_aprovacao',atualizado_em=now()
  WHERE id=$1 AND empresa_id=$3 AND usuario_id=$4`,[JSON.stringify(result),user.empresa_id,user.id]);
 res.json({id,status:'aguardando_aprovacao',reconciliacao:result,erpSnapshot:{produtos:produtosERP.length,saldos:saldosERP.length}});
}

export async function consultarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'ID de sessão inválido.');
 const result=await queryDb(`SELECT id,nome_arquivo,mime_type,tamanho_bytes,sha256,status,versao,inventario_abas,interpretacao,reconciliacao,preview,aprovacao_usuario_id,aprovado_em,importacao_iniciada_em,importacao_finalizada_em,resultado,erro,criado_em,atualizado_em
 FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,user.empresa_id,user.id]);
 if(!result.rows.length) throw new HttpError(404,'Sessão de importação não encontrada.');
 res.json(result.rows[0]);
}
