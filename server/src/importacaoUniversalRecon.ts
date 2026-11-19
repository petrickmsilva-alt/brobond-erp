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
  tipo: 'novo'|'existente_igual'|'atualizacao_proposta'|'duplicado_origem'|'conflito_sku'|'conflito_codigo_barras'|'ambiguidade'|'campo_desconhecido';
  aba: string;
  linhasOrigem: number[];
  chave?: string;
  descricao: string;
  detalhes?: Record<string,unknown>;
  requerAprovacao: true;
};
export type ResultadoRecon = {
  registros: RegistroReconhecido[];
  divergencias: DivergenciaRecon[];
  totais: Record<DivergenciaRecon['tipo'],number>;
  perdaDadosPrevista: number;
  importacaoLiberada: false;
};

function mapRow(analise:AnaliseSemantica,aba:string,row:Record<string,unknown>):Partial<Record<CampoCanonico,unknown>> {
  const mapping=analise.sugestoes.filter(s=>s.aba===aba&&s.campoCanonico&&!s.requerConfirmacao);
  const out:Partial<Record<CampoCanonico,unknown>>={};
  for(const s of mapping) if(row[s.colunaOriginal]!==undefined) out[s.campoCanonico as CampoCanonico]=row[s.colunaOriginal];
  return out;
}
function normalKey(v:unknown):string{return String(v??'').trim().toUpperCase();}
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
 const totals:ResultadoRecon['totais']={novo:0,existente_igual:0,atualizacao_proposta:0,duplicado_origem:0,conflito_sku:0,conflito_codigo_barras:0,ambiguidade:0,campo_desconhecido:0};
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
  const rowsByBarcode=new Map<string,number[]>();
  for(const row of aba.linhas){
   const m=mapRow(analise,aba.nome,row.valores);
   const reg:RegistroReconhecido={aba:aba.nome,linha:row.linhaOrigem,entidade,dadosOriginais:{...row.valores},mapeado:m};registros.push(reg);
   const sku=normalKey(m.sku);
   const barcode=normalKey(m.codigo_barras);
   if(barcode){const origin=origemPorBarcode.get(barcode)||[];origin.push({aba:aba.nome,linhas:[row.linhaOrigem],sku});origemPorBarcode.set(barcode,origin);const br=rowsByBarcode.get(barcode)||[];br.push(row.linhaOrigem);rowsByBarcode.set(barcode,br);const erpMatches=produtosPorBarcode.get(barcode)||[];if(erpMatches.length>0&&(!sku||erpMatches.some(p=>normalKey(p.sku)!==sku)))divergencias.push({tipo:'conflito_codigo_barras',aba:aba.nome,linhasOrigem:[row.linhaOrigem],chave:barcode,descricao:'Código de barras já pertence a outro SKU no ERP; conflito bloqueia importação.',detalhes:{skusERP:erpMatches.map(p=>p.sku),skuOrigem:sku},requerAprovacao:true});}
   if(sku){const r=rowsBySku.get(sku)||[];r.push(row.linhaOrigem);rowsBySku.set(sku,r);}
   if(analise.sugestoes.some(s=>s.aba===aba.nome&&!s.campoCanonico)){
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
    if(rowsBySku.get(sku)!.length>1) continue;
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
  for(const [sku,rows] of rowsBySku) if(rows.length>1) divergencias.push({tipo:'duplicado_origem',aba:aba.nome,linhasOrigem:rows,chave:sku,descricao:'SKU aparece múltiplas vezes na mesma aba; resolução manual obrigatória.',requerAprovacao:true});
  for(const [barcode,rows] of rowsByBarcode) if(rows.length>1) divergencias.push({tipo:'conflito_codigo_barras',aba:aba.nome,linhasOrigem:rows,chave:barcode,descricao:'Código de barras duplicado na planilha de origem; associação ambígua bloqueia importação.',detalhes:{linhas:rows},requerAprovacao:true});
 }
 for(const d of divergencias) totals[d.tipo]++;
 return {registros,divergencias,totais:totals,perdaDadosPrevista:0,importacaoLiberada:false};
}
