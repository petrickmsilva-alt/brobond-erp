import { createHash, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { query as queryDb } from './db';
import { currentUser } from './auth';
import { analisarArquivoUniversal } from './importacaoUniversalAnalise';
import { construirModeloDependencias } from './importacaoUniversalEntidades';
import { HttpError } from './errors';
import { hashAprovacaoImportacaoUniversal } from './importacaoUniversalHash';


export const CAMPOS_CANONICOS_IMPORTACAO = new Set(['sku','nome','categoria','colecao','cor','tamanho','quantidade','custo','custo_aquisicao','custo_fabricacao','custo_adicional','imposto','margem','preco_venda','preco_atacado','preco_promocional','qtd_min_atacado','codigo_barras','ncm','cest','peso_g','local','local_destino','fornecedor','telefone','email','cnpj_cpf','descricao','composicao','material','modelagem','genero','marca','tipo','condicao','producao','unidade','tags','formato','ativo','codigo_item','codigo_categoria','codigo_industria','variacao_tamanho_id','motivo','tipo_movimento','data','referencia_externa','preco_atacado_vista','preco_atacado_boleto_30','preco_atacado_boleto_30_60','preco_atacado_boleto_30_60_90','preco_atacado_cartao_debito','preco_atacado_cartao_credito_vista','preco_atacado_cartao_credito_30_60','preco_atacado_cartao_credito_30_60_90','preco_varejo_vista','preco_varejo_vista_min_2_un','preco_varejo_cartao_vista','preco_varejo_cartao_parcelado','margem_bruta_atacado_vista','margem_bruta_varejo_vista','margem_bruta_varejo_min_2_un']);
const TIPOS_CAMPO_IMPORTACAO = new Set(['texto','numero','percentual','data','booleano','codigo','desconhecido']);
const TIPOS_ENTIDADE_IMPORTACAO = new Set(['produto','sku','variacao','estoque','preco','movimentacao','cliente','fornecedor','tabela_generica']);
const TIPOS_BLOQUEADORES_APROVACAO = new Set(['duplicado_origem','conflito_sku','conflito_codigo_barras','ambiguidade','campo_desconhecido','orfao_relacionamento','conflito_dimensional','produto_sem_sku','sku_sem_produto','variacao_sem_produto','estoque_sem_produto','estoque_sem_local','preco_sem_produto','movimentacao_sem_produto','entidade_sem_executor']);
function normalizarSkuDependenciaERP(v:unknown):string{return Array.from(String(v??'').normalize('NFD')).filter(ch=>ch.charCodeAt(0)<768||ch.charCodeAt(0)>879).join('').trim().toUpperCase();}
export async function salvarMapeamentoImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa para mapeamento.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'ID de sessão inválido.');
 const session=await queryDb(`SELECT id,status,inventario_abas,interpretacao FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,user.empresa_id,user.id]);
 if(!session.rows.length) throw new HttpError(404,'Sessão de importação não encontrada.');
 const row=session.rows[0];
 if(!['aguardando_mapeamento','aguardando_aprovacao'].includes(String(row.status))) throw new HttpError(409,'Sessão não permite editar mapeamento neste estado.');
 const mappings=req.body?.mapeamentos, entities=req.body?.entidades, relationships=req.body?.relacionamentos??[];
 if(!Array.isArray(mappings)||!Array.isArray(entities)||!Array.isArray(relationships)) throw new HttpError(400,'Envie mapeamentos, entidades e relacionamentos em formato de lista.');
 const abas=Array.isArray(row.inventario_abas)?row.inventario_abas:[];
 const interpretacaoOriginal=(row.interpretacao&&typeof row.interpretacao==='object')?row.interpretacao:{};
 const validPairs=new Set(abas.flatMap((a:any)=>Array.isArray(a.cabecalhos)?a.cabecalhos.map((h:string)=>String(a.nome)+'::'+h):[]));
 const seen=new Set<string>(), normalized:any[]=[];
 for(const m of mappings){
  if(!m||typeof m.aba!=='string'||typeof m.colunaOriginal!=='string'||!validPairs.has(m.aba+'::'+m.colunaOriginal)) throw new HttpError(400,'Mapeamento referencia aba/coluna inexistente.');
  const key=m.aba+'::'+m.colunaOriginal;if(seen.has(key)) throw new HttpError(400,'Coluna duplicada no payload de mapeamento.');seen.add(key);
  const field=m.campoCanonico===null||m.campoCanonico===''?null:String(m.campoCanonico),tipo=String(m.tipo||'desconhecido');
  if(field!==null&&!CAMPOS_CANONICOS_IMPORTACAO.has(field)) throw new HttpError(400,'Campo canônico inválido: '+field);
  if(!TIPOS_CAMPO_IMPORTACAO.has(tipo)) throw new HttpError(400,'Tipo de campo inválido.');
  normalized.push({aba:m.aba,colunaOriginal:m.colunaOriginal,campoCanonico:field,tipoInferido:tipo,ignorado:field===null,confirmado:true});
 }
 if(normalized.length!==validPairs.size) throw new HttpError(400,'Mapeie todas as colunas da origem, inclusive as que serão ignoradas.');
 const entidades:any[]=[], entitySeen=new Set<string>();
 for(const e of entities){
  if(!e||typeof e.aba!=='string'||!abas.some((a:any)=>a.nome===e.aba)||!TIPOS_ENTIDADE_IMPORTACAO.has(String(e.tipo))) throw new HttpError(400,'Entidade/aba inválida.');
  if(entitySeen.has(e.aba)) throw new HttpError(400,'Tipo de entidade duplicado para aba.');
  entitySeen.add(e.aba);entidades.push({aba:e.aba,tipo:e.tipo,confirmado:true});
 }
 for(const a of abas) if(!entitySeen.has(String(a.nome))) throw new HttpError(400,'Confirme a entidade de todas as abas.');
 const tiposRelacionamento=new Set(['referencia_produto','estoque_produto','variacao_produto','relacao_codigo']);
 if(relationships.length>200) throw new HttpError(400,'Limite de 200 relacionamentos por sessão.');
 const relacionamentoSeen=new Set<string>(), relacionamentosNormalizados:any[]=[];
 for(const rel of relationships){
  if(!rel||typeof rel.origemAba!=='string'||typeof rel.destinoAba!=='string'||rel.origemAba===rel.destinoAba||!abas.some((a:any)=>a.nome===rel.origemAba)||!abas.some((a:any)=>a.nome===rel.destinoAba)) throw new HttpError(400,'Relacionamento referencia abas inválidas ou iguais.');
  const origem=abas.find((a:any)=>a.nome===rel.origemAba), destino=abas.find((a:any)=>a.nome===rel.destinoAba);
  if(typeof rel.campoOrigem!=='string'||!origem.cabecalhos.includes(rel.campoOrigem)||typeof rel.campoDestino!=='string'||!destino.cabecalhos.includes(rel.campoDestino)) throw new HttpError(400,'Relacionamento referencia coluna inexistente.');
  if(!tiposRelacionamento.has(String(rel.tipo))) throw new HttpError(400,'Tipo de relacionamento inválido.');
  const key=[rel.origemAba,rel.campoOrigem,rel.destinoAba,rel.campoDestino].join('::');if(relacionamentoSeen.has(key)) throw new HttpError(400,'Relacionamento duplicado.');relacionamentoSeen.add(key);
  const valoresOrigem=new Set((origem.linhas||[]).map((r:any)=>String(r?.valores?.[rel.campoOrigem]??'').trim().toUpperCase()).filter((v:string)=>v.length>0));
  const valoresDestino=new Set((destino.linhas||[]).map((r:any)=>String(r?.valores?.[rel.campoDestino]??'').trim().toUpperCase()).filter((v:string)=>v.length>0));
  const emComum=[...valoresOrigem].filter(v=>valoresDestino.has(v)).length;
  const base=Math.min(valoresOrigem.size,valoresDestino.size);
  relacionamentosNormalizados.push({origemAba:rel.origemAba,destinoAba:rel.destinoAba,tipo:String(rel.tipo),campoOrigem:rel.campoOrigem,campoDestino:rel.campoDestino,valoresEmComum:emComum,confianca:base?Math.min(0.95,emComum/base):0,requerConfirmacao:true,confirmado:true});
 }
 const camposPorAba=new Map<string,Set<string>>();
 for(const m of normalized)if(m.campoCanonico){const set=camposPorAba.get(m.aba)||new Set<string>();if(set.has(m.campoCanonico))throw new HttpError(400,'Campo canônico duplicado na aba '+m.aba+': '+m.campoCanonico);set.add(m.campoCanonico);camposPorAba.set(m.aba,set);}
 const entidadesModelo=(interpretacaoOriginal as any).entidades?.entidades?.map((e:any)=>{const confirmado=entidades.find((x:any)=>x.aba===e.aba);return confirmado?{...e,tipo:confirmado.tipo}:e;})||[];
 const dependencias=construirModeloDependencias(entidadesModelo,relacionamentosNormalizados as any);
 const novo={...interpretacaoOriginal,mapeamentoConfirmado:{versao:1,confirmadoPor:user.id,confirmadoEm:new Date().toISOString(),mapeamentos:normalized,entidades,relacionamentos:relacionamentosNormalizados,dependencias}};
 await queryDb(`UPDATE importacao_universal_sessoes SET interpretacao=$2::jsonb,status='aguardando_mapeamento',versao=versao+1,atualizado_em=now() WHERE id=$1 AND empresa_id=$3 AND usuario_id=$4`,[id,JSON.stringify(novo),user.empresa_id,user.id]);
 res.json({id,status:'aguardando_mapeamento',mapeamentoSalvo:true,versao:1,totalMapeamentos:normalized.length,totalEntidades:entidades.length,totalRelacionamentos:relacionamentosNormalizados.length,relacionamentos:relacionamentosNormalizados,dependencias});
}
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
 const session=await queryDb(`SELECT id,status,versao,nome_arquivo,mime_type,tamanho_bytes,sha256,inventario_abas,interpretacao,preview FROM importacao_universal_sessoes
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
 const [products,stocks,sizes,locations,colors]=await Promise.all([fetchAll(RESOURCES.produtos,true),fetchAll(RESOURCES.estoques,true),fetchAll(RESOURCES.tamanhos),fetchAll(RESOURCES.locais,true),fetchAll(RESOURCES.cores)]);
 const produtoById=new Map(products.map((p:any)=>[Number(p.id),p]));
 const tamanhoById=new Map(sizes.map((t:any)=>[Number(t.id),t]));
 const localById=new Map(locations.map((l:any)=>[Number(l.id),l]));
 const corById=new Map(colors.map((c:any)=>[Number(c.id),c]));
 const produtosERP=products.map((p:any)=>({id:Number(p.id),sku:String(p.sku||''),nome:String(p.nome||''),codigo_barras:p.codigo_barras??null,cor:p.cor??(p.cor_id==null?null:(corById.get(Number(p.cor_id)) as any)?.nome??null),tamanho:p.variacao_tamanho_id==null?null:(tamanhoById.get(Number(p.variacao_tamanho_id)) as any)?.codigo??null,custo:p.custo==null?null:Number(p.custo),preco_venda:p.preco_venda==null?null:Number(p.preco_venda),ativo:p.ativo!==false,produto_pai_id:p.produto_pai_id==null?null:Number(p.produto_pai_id),variacao_chave:p.variacao_chave??null,variacao_tamanho_id:p.variacao_tamanho_id==null?null:Number(p.variacao_tamanho_id),cor_id:p.cor_id==null?null:Number(p.cor_id)}));
 const saldosERP=stocks.map((s:any)=>{const p=produtoById.get(Number(s.produto_id)) as any;const t=s.tamanho_id==null?null:tamanhoById.get(Number(s.tamanho_id)) as any;const l=s.local_id==null?null:localById.get(Number(s.local_id)) as any;return{produto_id:Number(s.produto_id),sku:String(p?.sku||''),tamanho_id:s.tamanho_id==null?null:Number(s.tamanho_id),tamanho:t?.codigo??null,local_id:s.local_id==null?null:Number(s.local_id),local:l?.nome??s.local??null,quantidade:Number(s.quantidade||0)};});
 const tipoArquivo: 'csv'|'xlsx'=String(row.nome_arquivo).toLowerCase().endsWith('.csv')?'csv':'xlsx';
 const arquivo={nome:String(row.nome_arquivo),sha256:String(row.sha256),tamanhoBytes:Number(row.tamanho_bytes),tipo:tipoArquivo,abas:row.inventario_abas as any};
 const interpretacao=row.interpretacao as any;
 const confirmado=interpretacao.mapeamentoConfirmado;
 if(!confirmado||confirmado.versao!==1||!Array.isArray(confirmado.mapeamentos)||!Array.isArray(confirmado.entidades)) throw new HttpError(409,'Confirme e salve o mapeamento antes de reconciliar.');
 const semanticaConfirmada={...interpretacao.semantica,sugestoes:interpretacao.semantica.sugestoes.map((s:any)=>{const m=confirmado.mapeamentos.find((x:any)=>x.aba===s.aba&&x.colunaOriginal===s.colunaOriginal);return m?{...s,campoCanonico:m.campoCanonico,tipoInferido:m.tipoInferido,requerConfirmacao:false,ignorado:m.ignorado===true}:s;})};
 const entidadesConfirmadas={...interpretacao.entidades,entidades:interpretacao.entidades.entidades.map((e:any)=>{const m=confirmado.entidades.find((x:any)=>x.aba===e.aba);return m?{...e,tipo:m.tipo,requerConfirmacao:false}:e;}),relacionamentos:Array.isArray(confirmado.relacionamentos)?confirmado.relacionamentos:interpretacao.entidades.relacionamentos};
 const produtosPorSku=new Map<string,number>();
 for(const produto of produtosERP){const sku=normalizarSkuDependenciaERP(produto.sku);if(!sku)continue;produtosPorSku.set(sku,(produtosPorSku.get(sku)||0)+1);}
 const skusPorAba=new Map<string,Set<string>>();
 for(const aba of arquivo.abas){const m=confirmado.mapeamentos.find((x:any)=>x.aba===aba.nome&&x.campoCanonico==='sku'&&x.ignorado!==true);if(!m)continue;const skuValues=(aba.linhas||[]).map((r:any)=>normalizarSkuDependenciaERP(r?.valores?.[m.colunaOriginal]));const skus=new Set<string>(skuValues.filter((sku:string)=>sku.length>0));skusPorAba.set(aba.nome,skus);}
 entidadesConfirmadas.dependencias=construirModeloDependencias(entidadesConfirmadas.entidades,entidadesConfirmadas.relacionamentos as any,{produtosPorSku,skusPorAba});
 const result=reconciliarImportacaoUniversal(arquivo,semanticaConfirmada,entidadesConfirmadas,produtosERP,saldosERP);
 const versaoAprovacao=Number(row.versao||1)+1;
 const approvalHash=hashAprovacaoImportacaoUniversal(id,user.empresa_id,String(row.sha256),versaoAprovacao,confirmado,result);
 const previewAtual=(row.preview&&typeof row.preview==='object')?row.preview:{};
 const previewAtualizado={...previewAtual,previaConsolidada:result.previaConsolidada,resumoDimensional:result.resumoDimensional,erpSnapshot:{produtos:produtosERP.length,saldos:saldosERP.length},approvalHash,approvalVersion:versaoAprovacao};
 const saved=await queryDb(`UPDATE importacao_universal_sessoes SET reconciliacao=$2::jsonb,preview=$3::jsonb,status='aguardando_aprovacao',versao=versao+1,atualizado_em=now()
  WHERE id=$1 AND empresa_id=$4 AND usuario_id=$5 AND versao=$6 AND status IN ('aguardando_mapeamento','aguardando_aprovacao') RETURNING versao`,[id,JSON.stringify(result),JSON.stringify(previewAtualizado),user.empresa_id,user.id,Number(row.versao||1)]);
 if(!saved.rows.length)throw new HttpError(409,'Sessão mudou durante a reconciliação. Atualize a sessão e reconcilie novamente.');
 res.json({id,status:'aguardando_aprovacao',reconciliacao:result,approvalHash,approvalVersion:versaoAprovacao,erpSnapshot:{produtos:produtosERP.length,saldos:saldosERP.length}});
}

export async function aprovarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa para aprovação.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'ID de sessão inválido.');
 const session=await queryDb(`SELECT id,status,versao,sha256,interpretacao,reconciliacao,preview FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,user.empresa_id,user.id]);
 if(!session.rows.length)throw new HttpError(404,'Sessão de importação não encontrada.');
 const row=session.rows[0];
 if(row.status!=='aguardando_aprovacao')throw new HttpError(409,'A sessão precisa estar aguardando aprovação após reconciliação.');
 const confirmado=(row.interpretacao as any)?.mapeamentoConfirmado;
 const resultado=row.reconciliacao as any;
 if(!confirmado||confirmado.versao!==1||!resultado||!Array.isArray(resultado.divergencias))throw new HttpError(409,'Prévia consolidada ou mapeamento confirmado ausente. Reconcile antes de aprovar.');
 const approvalHash=hashAprovacaoImportacaoUniversal(id,user.empresa_id,String(row.sha256),Number(row.versao),confirmado,resultado);
 if(String(req.body?.hashPreview||'')!==approvalHash||Number(req.body?.versao)!==Number(row.versao))throw new HttpError(409,'A prévia mudou ou o hash de aprovação está desatualizado. Reconcilie novamente.');
 const bloqueadores=resultado.divergencias.filter((d:any)=>TIPOS_BLOQUEADORES_APROVACAO.has(String(d.tipo)));
 const bloqueadoresDependencias=(resultado.dependencias||[]).filter((d:any)=>['sku','variacao','estoque','preco','movimentacao'].includes(String(d.tipo))&&d.estado==='pendente'&&Array.isArray(d.bloqueios)&&d.bloqueios.length>0);
 if(bloqueadores.length||bloqueadoresDependencias.length)throw new HttpError(409,'Aprovação bloqueada: resolva conflitos, ambiguidades, órfãos, campos não mapeados e dependências pendentes antes de aprovar.',{bloqueadores:bloqueadores.map((d:any)=>({tipo:d.tipo,aba:d.aba,linhasOrigem:d.linhasOrigem,descricao:d.descricao})),dependencias:bloqueadoresDependencias.map((d:any)=>({aba:d.aba,tipo:d.tipo,bloqueios:d.bloqueios}))});
 const aprovadoEm=new Date().toISOString();
 const previewAtual=(row.preview&&typeof row.preview==='object')?row.preview:{};
 const previewAtualizado={...previewAtual,aprovacao:{hash:approvalHash,versao:Number(row.versao),aprovadoPor:user.id,aprovadoEm}};
 const saved=await queryDb(`UPDATE importacao_universal_sessoes SET status='aprovado',aprovacao_usuario_id=$4,aprovado_em=now(),preview=$5::jsonb,versao=versao+1,atualizado_em=now() WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 AND status='aguardando_aprovacao' AND versao=$6 RETURNING versao,aprovado_em`,[id,user.empresa_id,user.id,user.id,JSON.stringify(previewAtualizado),Number(row.versao)]);
 if(!saved.rows.length)throw new HttpError(409,'A sessão foi alterada em paralelo; recarregue e aprove a prévia atual.');
 res.json({id,status:'aprovado',versao:Number(saved.rows[0].versao),aprovadoEm:saved.rows[0].aprovado_em,approvalHash,approvalVersion:Number(row.versao),bloqueadores:0,gravacaoExecutada:false});
}

export async function consultarImportacaoUniversalHandler(req:Request,res:Response):Promise<void>{
 const user=currentUser(req);
 if(!user||!user.empresa_id||user.empresa_id<=0) throw new HttpError(403,'Usuário sem empresa ativa.');
 const id=String(req.params?.id||'');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new HttpError(400,'ID de sessão inválido.');
 const result=await queryDb(`SELECT id,nome_arquivo,mime_type,tamanho_bytes,sha256,status,versao,inventario_abas,interpretacao,reconciliacao,preview,aprovacao_usuario_id,aprovado_em,importacao_iniciada_em,importacao_finalizada_em,resultado,erro,criado_em,atualizado_em,arquivo_original
 FROM importacao_universal_sessoes WHERE id=$1 AND empresa_id=$2 AND usuario_id=$3 LIMIT 1`,[id,user.empresa_id,user.id]);
 if(!result.rows.length) throw new HttpError(404,'Sessão de importação não encontrada.');
 const row=result.rows[0];const bytes=row.arquivo_original instanceof Buffer?row.arquivo_original:Buffer.from(row.arquivo_original||[]);
 const hashAtual=createHash('sha256').update(bytes).digest('hex');if(hashAtual!==String(row.sha256).trim())throw new HttpError(409,'O arquivo original não corresponde ao SHA-256 registrado. A sessão não pode ser retomada.');
 const analise=await analisarArquivoUniversal({nomeArquivo:String(row.nome_arquivo),bytes,maxBytes:MAX_BYTES});
 const safe={...row};delete safe.arquivo_original;res.json({...safe,analise});
}
