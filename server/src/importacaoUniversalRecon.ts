import type { ArquivoInventariado } from './importacaoUniversalLeitura';
import type { AnaliseSemantica, CampoCanonico } from './importacaoUniversalSemantica';
import type { ReconhecimentoEntidades } from './importacaoUniversalEntidades';

export type SnapshotProdutoERP = {
  id: number;
  sku: string;
  nome: string;
  codigo_barras?: string | null;
  cor?: string | null;
  tamanho?: string | null;
  custo?: number | null;
  preco_venda?: number | null;
  ativo?: boolean;
  produto_pai_id?:number|null;
  variacao_chave?:string|null;
  variacao_tamanho_id?:number|null;
  cor_id?:number|null;
};
export type SnapshotSaldoERP = {
  produto_id: number;
  sku: string;
  tamanho_id?: number | null;
  tamanho?: string | null;
  local_id?: number | null;
  local?: string | null;
  quantidade: number;
};
export type RegistroReconhecido = {
  aba: string;
  linha: number;
  entidade: string;
  dadosOriginais: Record<string, unknown>;
  mapeado: Partial<Record<CampoCanonico, unknown>>;
};
export type DivergenciaRecon = {
  tipo: 'novo'|'existente_igual'|'atualizacao_proposta'|'duplicado_origem'|'conflito_sku'|'conflito_codigo_barras'|'ambiguidade'|'campo_desconhecido'|'orfao_relacionamento'|'conflito_dimensional'|'produto_sem_sku'|'sku_sem_produto'|'variacao_sem_produto'|'estoque_sem_produto'|'estoque_sem_local'|'preco_sem_produto'|'movimentacao_sem_produto'|'entidade_sem_executor';
  aba: string;
  linhasOrigem: number[];
  chave?: string;
  descricao: string;
  detalhes?: Record<string,unknown>;
  requerAprovacao: true;
};
export type RelacionamentoRecon = {
  origemAba:string;destinoAba:string;tipo:string;campoOrigem:string;campoDestino:string;
  valoresOrigem:number;valoresDestino:number;valoresEmComum:number;orfaosOrigem:number;orfaosDestino:number;
  duplicadosOrigem:number;duplicadosDestino:number;estado:'correspondencia'|'sem_correspondencia'|'ambigua';
};
export type ResultadoRecon = {
  registros: RegistroReconhecido[];
  divergencias: DivergenciaRecon[];
  totais: Record<DivergenciaRecon['tipo'],number>;
  relacionamentos:RelacionamentoRecon[];
  resumoDimensional:{relacionamentosAnalisados:number;correspondencias:number;semCorrespondencia:number;ambiguidade:number;orfaosOrigem:number;orfaosDestino:number;conflitosDimensionais:number};
  dependencias:any[];
  previaConsolidada:{registros:{aba:string;linha:number;entidade:string;status:string;divergencias:string[];mapeado:Record<string,unknown>}[];resumo:{total:number;porEntidade:Record<string,number>;porStatus:Record<string,number>}};
  perdaDadosPrevista: number;
  importacaoLiberada: false;
};

function mapRow(analise:AnaliseSemantica,aba:string,row:Record<string,unknown>):Partial<Record<CampoCanonico,unknown>> {
  const mapping=analise.sugestoes.filter(s=>s.aba===aba&&s.campoCanonico&&!s.requerConfirmacao&&!((s as any).ignorado));
  const out:Partial<Record<CampoCanonico,unknown>>={};
  for(const s of mapping) if(row[s.colunaOriginal]!==undefined) out[s.campoCanonico as CampoCanonico]=row[s.colunaOriginal];
  return out;
}
function normalKey(v:unknown):string{return Array.from(String(v??'').normalize('NFD')).filter(ch=>ch.charCodeAt(0)<768||ch.charCodeAt(0)>879).join('').trim().toUpperCase();}
function numberValue(v:unknown):number|null {
  if(v===null||v===undefined||v==='') return null;
  if(typeof v==='number') return Number.isFinite(v)?v:null;
  const s=String(v).replace(/R\$|\s/g,'').replace(/\.(?=\d{3}(?:,|$))/g,'').replace(',','.');
  const n=Number(s); return Number.isFinite(n)?n:null;
}
export function reconciliarImportacaoUniversal(
 arquivo:ArquivoInventariado, analise:AnaliseSemantica, entidades:ReconhecimentoEntidades,
 produtosERP:SnapshotProdutoERP[], saldosERP:SnapshotSaldoERP[]
):ResultadoRecon {
 const registros:RegistroReconhecido[]=[];
 const divergencias:DivergenciaRecon[]=[];
 const totals:ResultadoRecon['totais']={novo:0,existente_igual:0,atualizacao_proposta:0,duplicado_origem:0,conflito_sku:0,conflito_codigo_barras:0,ambiguidade:0,campo_desconhecido:0,orfao_relacionamento:0,conflito_dimensional:0,produto_sem_sku:0,estoque_sem_produto:0,preco_sem_produto:0,movimentacao_sem_produto:0,entidade_sem_executor:0,sku_sem_produto:0,variacao_sem_produto:0,estoque_sem_local:0};
 const produtosPorSku=new Map<string,SnapshotProdutoERP[]>();
 for(const p of produtosERP){const k=normalKey(p.sku);const arr=produtosPorSku.get(k)||[];arr.push(p);produtosPorSku.set(k,arr);}
 const produtosPorBarcode=new Map<string,SnapshotProdutoERP[]>();
 for(const p of produtosERP){const k=normalKey(p.codigo_barras);if(!k)continue;const arr=produtosPorBarcode.get(k)||[];arr.push(p);produtosPorBarcode.set(k,arr);}
 const origemPorBarcode=new Map<string,{aba:string;linhas:number[];sku:string}[]>();
 const saldos=new Map<string,SnapshotSaldoERP[]>();
 for(const s of saldosERP){const k=[normalKey(s.sku),normalKey(s.tamanho),normalKey(s.local)].join('|');const arr=saldos.get(k)||[];arr.push(s);saldos.set(k,arr);}
 for(const aba of arquivo.abas){
  const entidade=entidades.entidades.find(e=>e.aba===aba.nome)?.tipo||'tabela_generica';
  const rowsBySku=new Map<string,number[]>();
  for(const row of aba.linhas){
   const m=mapRow(analise,aba.nome,row.valores);
   const reg:RegistroReconhecido={aba:aba.nome,linha:row.linhaOrigem,entidade,dadosOriginais:{...row.valores},mapeado:m};registros.push(reg);
   const sku=normalKey(m.sku);
   if(entidade==='tabela_generica')divergencias.push({tipo:'entidade_sem_executor',aba:aba.nome,linhasOrigem:[row.linhaOrigem],descricao:'Esta aba foi classificada como tabela genérica e não possui destino de gravação implementado. Importação bloqueada para impedir descarte silencioso dos registros.',detalhes:{cabecalhos:aba.cabecalhos},requerAprovacao:true});
   const barcode=normalKey(m.codigo_barras);
   if(barcode){const origin=origemPorBarcode.get(barcode)||[];origin.push({aba:aba.nome,linhas:[row.linhaOrigem],sku});origemPorBarcode.set(barcode,origin);const erpMatches=produtosPorBarcode.get(barcode)||[];if(erpMatches.length>0&&sku&&erpMatches.some(p=>normalKey(p.sku)!==sku))divergencias.push({tipo:'conflito_codigo_barras',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:barcode,descricao:'Código de barras já pertence a outro SKU no ERP; conflito bloqueia importação.',detalhes:{skusERP:erpMatches.map(p=>p.sku),skuOrigem:sku},requerAprovacao:true});}
   if(sku){const identity=entidade==='estoque'?[sku,normalKey(m.tamanho),normalKey(m.local)].join('|'):sku;const r=rowsBySku.get(identity)||[];r.push(row.linhaOrigem);rowsBySku.set(identity,r);}
   if(analise.sugestoes.some(s=>s.aba===aba.nome&&!s.campoCanonico&&!(s as any).ignorado)){
    divergencias.push({tipo:'campo_desconhecido',aba:aba.nome,linhasOrigem:[row.linhaOrigem],descricao:'Registro possui campos não mapeados; dados originais preservados.',detalhes:{campos:analise.sugestoes.filter(s=>s.aba===aba.nome&&!s.campoCanonico).map(s=>s.colunaOriginal)},requerAprovacao:true});
   }
   if(analise.sugestoes.some(s=>s.aba===aba.nome&&s.requerConfirmacao)){
    divergencias.push({tipo:'ambiguidade',aba:aba.nome,linhasOrigem:[row.linhaOrigem],descricao:'Há campos que exigem confirmação de mapeamento; não foram usados no mapeamento seguro.',requerAprovacao:true});
   }
   if(entidade==='estoque'&&m.sku&&m.quantidade!==undefined){
    const key=[normalKey(m.sku),normalKey(m.tamanho),normalKey(m.local)].join('|');
    const exists=saldos.get(key)||[];
    const qty=numberValue(m.quantidade);
    if(exists.length===1&&qty!==null&&exists[0].quantidade!==qty) divergencias.push({tipo:'atualizacao_proposta',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:key,descricao:'Saldo existente difere do saldo da planilha; ajuste inicial requer aprovação.',detalhes:{erp:exists[0].quantidade,origem:qty},requerAprovacao:true});
    else if(exists.length===1) divergencias.push({tipo:'existente_igual',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:key,descricao:'Saldo identificado com mesma chave canônica; verificar quantidade.',requerAprovacao:true});
    else if(exists.length>1) divergencias.push({tipo:'ambiguidade',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:key,descricao:'Mais de um saldo ERP para a chave composta; importação bloqueada.',requerAprovacao:true});
    else divergencias.push({tipo:'novo',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:key,descricao:'Novo saldo potencial; referências precisam ser resolvidas.',requerAprovacao:true});
   } else if(entidade==='produto'&&sku){
    const existing=produtosPorSku.get(sku)||[];

    if(existing.length===0) divergencias.push({tipo:'novo',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:sku,descricao:'SKU não localizado no snapshot ERP; novo produto potencial.',requerAprovacao:true});
    else if(existing.length>1) divergencias.push({tipo:'conflito_sku',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:sku,descricao:'SKU duplicado no snapshot ERP; conflito bloqueia a importação.',requerAprovacao:true});
    else {
      const p=existing[0], changes:Record<string,{erp:unknown;origem:unknown}>={};
      for(const field of ['nome','codigo_barras','cor','tamanho','custo','preco_venda'] as const){
       const val=m[field], old=(p as any)[field];
       if(val!==undefined&&val!==null&&String(val)!==String(old??'')) changes[field]={erp:old,origem:val};
      }
      if(Object.keys(changes).length) divergencias.push({tipo:'atualizacao_proposta',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:sku,descricao:'Produto existente com diferenças; nenhuma alteração aplicada.',detalhes:changes,requerAprovacao:true});
      else divergencias.push({tipo:'existente_igual',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:sku,descricao:'Produto existente sem diferenças nos campos mapeados.',requerAprovacao:true});
    }
   }
  }
  for(const [identity,rows] of rowsBySku) if(rows.length>1) divergencias.push({tipo:'duplicado_origem',aba:aba.nome,linhasOrigem:rows,chave:identity,descricao:entidade==='estoque'?'Saldo repetido para a mesma combinação SKU × tamanho × local; resolução manual obrigatória.':'SKU aparece múltiplas vezes na mesma aba; resolução manual obrigatória.',requerAprovacao:true});

 }
 const relacionamentosRecon:RelacionamentoRecon[]=[];
 const relacoesConfirmadas=((entidades as any).relacionamentos||[]).filter((r:any)=>r?.confirmado===true);
 let orfaosOrigemTotal=0,orfaosDestinoTotal=0,conflitosDimensionais=0,correspondencias=0,semCorrespondencia=0,ambiguidadesRelacionamento=0;
 const indexarValores=(sheet:string,field:string)=>{
  const aba=arquivo.abas.find(a=>a.nome===sheet),index=new Map<string,number[]>();if(!aba)return index;
  for(const row of aba.linhas){const value=normalKey(row.valores?.[field]);if(!value)continue;const lines=index.get(value)||[];lines.push(row.linhaOrigem);index.set(value,lines);}
  return index;
 };
 for(const rel of relacoesConfirmadas){
  const origem=indexarValores(String(rel.origemAba),String(rel.campoOrigem)),destino=indexarValores(String(rel.destinoAba),String(rel.campoDestino));
  const comuns=[...origem.keys()].filter(k=>destino.has(k));const orfaosOrigem=[...origem.keys()].filter(k=>!destino.has(k)),orfaosDestino=[...destino.keys()].filter(k=>!origem.has(k));
  const duplicadosOrigem=[...origem.values()].filter(lines=>lines.length>1).length,duplicadosDestino=[...destino.values()].filter(lines=>lines.length>1).length;
  const ambiguoPorDuplicidade=duplicadosOrigem>0||(String(rel.tipo)==='relacao_codigo'&&duplicadosDestino>0);
  const estado:RelacionamentoRecon['estado']=ambiguoPorDuplicidade?'ambigua':comuns.length?'correspondencia':'sem_correspondencia';
  if(estado==='correspondencia')correspondencias++;else if(estado==='sem_correspondencia')semCorrespondencia++;else ambiguidadesRelacionamento++;
  const item:RelacionamentoRecon={origemAba:String(rel.origemAba),destinoAba:String(rel.destinoAba),tipo:String(rel.tipo),campoOrigem:String(rel.campoOrigem),campoDestino:String(rel.campoDestino),valoresOrigem:origem.size,valoresDestino:destino.size,valoresEmComum:comuns.length,orfaosOrigem:orfaosOrigem.length,orfaosDestino:orfaosDestino.length,duplicadosOrigem,duplicadosDestino,estado};relacionamentosRecon.push(item);
  orfaosOrigemTotal+=orfaosOrigem.length;orfaosDestinoTotal+=orfaosDestino.length;
  if(!comuns.length)divergencias.push({tipo:'orfao_relacionamento',aba:String(rel.origemAba)+' → '+String(rel.destinoAba),linhasOrigem:[...origem.values(),...destino.values()].flat(),chave:String(rel.campoOrigem)+' ↔ '+String(rel.campoDestino),descricao:'Relacionamento confirmado não encontrou valores em comum; vínculo não pode ser considerado resolvido.',detalhes:{origemValores:origem.size,destinoValores:destino.size,orfaosOrigem,orfaosDestino},requerAprovacao:true});
  else if(orfaosOrigem.length||orfaosDestino.length)divergencias.push({tipo:'orfao_relacionamento',aba:String(rel.origemAba)+' → '+String(rel.destinoAba),linhasOrigem:[...orfaosOrigem.map(k=>origem.get(k)||[]),...orfaosDestino.map(k=>destino.get(k)||[])].flat(),chave:String(rel.campoOrigem)+' ↔ '+String(rel.campoDestino),descricao:'Relacionamento apresenta chaves sem correspondência entre abas; revisar órfãos antes da aprovação.',detalhes:{orfaosOrigem,orfaosDestino},requerAprovacao:true});
  if(ambiguoPorDuplicidade)divergencias.push({tipo:'ambiguidade',aba:String(rel.origemAba)+' → '+String(rel.destinoAba),linhasOrigem:[...origem.values(),...(String(rel.tipo)==='relacao_codigo'?destino.values():[])].filter(lines=>lines.length>1).flat(),chave:String(rel.campoOrigem)+' ↔ '+String(rel.campoDestino),descricao:'Relacionamento contém chaves duplicadas na origem ou em relação por código; associação requer revisão. Duplicação no destino é permitida em relações um-para-muitos.',detalhes:{duplicadosOrigem,duplicadosDestino},requerAprovacao:true});
 }
 const origemPorSku=new Map<string,RegistroReconhecido[]>();
 for(const reg of registros){const sku=normalKey(reg.mapeado.sku);if(!sku)continue;const arr=origemPorSku.get(sku)||[];arr.push(reg);origemPorSku.set(sku,arr);}
 const skuProdutoOrigem=new Set(registros.filter(r=>['produto','sku','variacao'].includes(r.entidade)).map(r=>normalKey(r.mapeado.sku)).filter(Boolean));
 const skuProdutoERP=new Set(produtosERP.map(p=>normalKey(p.sku)).filter(Boolean));
 const produtoEncontrado=(sku:string)=>skuProdutoOrigem.has(sku)||skuProdutoERP.has(sku);
 for(const reg of registros){
  const sku=normalKey(reg.mapeado.sku);
  if(reg.entidade==='produto'&&!sku)divergencias.push({tipo:'produto_sem_sku',aba:reg.aba,linhasOrigem:[reg.linha],descricao:'Registro de produto sem SKU; não pode ser ligado com segurança ao catálogo.',requerAprovacao:true});
  if(reg.entidade==='sku'&&(!sku||!produtoEncontrado(sku)))divergencias.push({tipo:'sku_sem_produto',aba:reg.aba,linhasOrigem:[reg.linha],chave:sku||undefined,descricao:'SKU de referência não encontra produto-pai na origem nem no ERP.',requerAprovacao:true});
  if(reg.entidade==='estoque'&&!normalKey(reg.mapeado.local))divergencias.push({tipo:'estoque_sem_local',aba:reg.aba,linhasOrigem:[reg.linha],chave:sku||undefined,descricao:'Saldo de estoque sem local canônico; não é permitido aplicar ajuste de saldo.',requerAprovacao:true});
  if(reg.entidade==='variacao'&&!((entidades as any).dependencias||[]).some((d:any)=>d.aba===reg.aba&&d.estado==='vinculada'))divergencias.push({tipo:'variacao_sem_produto',aba:reg.aba,linhasOrigem:[reg.linha],chave:sku||undefined,descricao:'Variação não possui relacionamento confirmado com aba de SKU/produto-pai.',requerAprovacao:true});
  if(['estoque','preco','movimentacao'].includes(reg.entidade)&&(!sku||!produtoEncontrado(sku))){
   const tipo=reg.entidade==='estoque'?'estoque_sem_produto':reg.entidade==='preco'?'preco_sem_produto':'movimentacao_sem_produto';
   divergencias.push({tipo,aba:reg.aba,linhasOrigem:[reg.linha],chave:sku||undefined,descricao:!sku?'Registro dependente sem SKU/chave de produto.':'Registro dependente não encontra produto correspondente na origem ou no snapshot ERP.',detalhes:{sku},requerAprovacao:true});
  }
 }
 const dimensoes=['codigo_barras','cor','tamanho','categoria','colecao'] as const;
 for(const [sku,regs] of origemPorSku){
  const porAba=new Map<string,RegistroReconhecido[]>();for(const reg of regs){const arr=porAba.get(reg.aba)||[];arr.push(reg);porAba.set(reg.aba,arr);}
  if(porAba.size<2)continue;
  for(const campo of dimensoes){
   const valoresPorAba=[...porAba.entries()].map(([aba,lista])=>({aba,valores:[...new Set(lista.map(r=>normalKey(r.mapeado[campo])).filter(Boolean))],linhas:lista.map(r=>r.linha)})).filter(x=>x.valores.length);
   const valoresUnicos=[...new Set(valoresPorAba.flatMap(x=>x.valores))];
   if(valoresUnicos.length>1){conflitosDimensionais++;divergencias.push({tipo:'conflito_dimensional',aba:valoresPorAba.map(x=>x.aba).join(', '),linhasOrigem:valoresPorAba.flatMap(x=>x.linhas),chave:sku,descricao:'O mesmo SKU aparece em múltiplas abas com valores divergentes no campo '+campo+'.',detalhes:{campo,valoresPorAba},requerAprovacao:true});}
  }
 }
 for(const [barcode,origens] of origemPorBarcode){
  const unicas=new Map<string,{aba:string;linha:number;sku:string}>();
  for(const origem of origens)for(const linha of origem.linhas)unicas.set(origem.aba+'|'+linha,{aba:origem.aba,linha,sku:origem.sku});
  const skus=new Set([...unicas.values()].map(o=>normalKey(o.sku)).filter(Boolean));
  const porAba=new Map<string,number>();for(const o of unicas.values())porAba.set(o.aba,(porAba.get(o.aba)||0)+1);
  const repetidoNaAba=[...porAba.values()].some(n=>n>1);
  if(skus.size>1||repetidoNaAba||(!skus.size&&unicas.size>1))divergencias.push({tipo:'conflito_codigo_barras',aba:[...new Set([...unicas.values()].map(o=>o.aba))].join(', '),linhasOrigem:[...unicas.values()].map(o=>o.linha),chave:barcode,descricao:'Código de barras associado a SKUs diferentes ou repetido de forma ambígua; associação bloqueia importação até revisão.',detalhes:{origens:[...unicas.values()],skus:[...skus],repetidoNaAba},requerAprovacao:true});
 }
 for(const d of divergencias) totals[d.tipo]++;
 const porEntidade:Record<string,number>={},porStatus:Record<string,number>={};
 const previaRegistros=registros.map(reg=>{
  const issues=divergencias.filter(d=>(d.aba===reg.aba||d.aba.split(',').map(x=>x.trim()).includes(reg.aba))&&d.linhasOrigem.includes(reg.linha));
  const tipos=[...new Set(issues.map(d=>d.tipo))];
  const bloqueadores=['duplicado_origem','conflito_sku','conflito_codigo_barras','ambiguidade','campo_desconhecido','orfao_relacionamento','conflito_dimensional','produto_sem_sku','sku_sem_produto','variacao_sem_produto','estoque_sem_produto','estoque_sem_local','preco_sem_produto','movimentacao_sem_produto'];
  const status=tipos.some(t=>bloqueadores.includes(t))?'Revisão/bloqueio':tipos.includes('atualizacao_proposta')||tipos.includes('novo')?'Proposta':tipos.includes('existente_igual')?'Identificado no ERP':'Sem divergência individual';
  porEntidade[reg.entidade]=(porEntidade[reg.entidade]||0)+1;porStatus[status]=(porStatus[status]||0)+1;
  return{aba:reg.aba,linha:reg.linha,entidade:reg.entidade,status,divergencias:tipos,mapeado:reg.mapeado as Record<string,unknown>};
 });
 return {registros,divergencias,totais:totals,relacionamentos:relacionamentosRecon,resumoDimensional:{relacionamentosAnalisados:relacionamentosRecon.length,correspondencias,semCorrespondencia,ambiguidade:ambiguidadesRelacionamento,orfaosOrigem:orfaosOrigemTotal,orfaosDestino:orfaosDestinoTotal,conflitosDimensionais},dependencias:(entidades as any).dependencias||[],previaConsolidada:{registros:previaRegistros,resumo:{total:previaRegistros.length,porEntidade,porStatus}},perdaDadosPrevista:0,importacaoLiberada:false};
}
