import type { ArquivoInventariado } from './importacaoUniversalLeitura';
import type { AnaliseSemantica, CampoCanonico, SugestaoCampo } from './importacaoUniversalSemantica';

export type EntidadeDetectada = {
  aba: string;
  tipo: 'produto' | 'sku' | 'variacao' | 'estoque' | 'preco' | 'movimentacao' | 'cliente' | 'fornecedor' | 'tabela_generica';
  confianca: number;
  camposRelacionados: CampoCanonico[];
  linhasComDados: number;
  motivo: string;
  requerConfirmacao: boolean;
};

export type RelacionamentoSugerido = {
  origemAba: string;
  destinoAba: string;
  tipo: 'referencia_produto' | 'estoque_produto' | 'variacao_produto' | 'relacao_codigo';
  campoOrigem: string;
  campoDestino: string;
  valoresEmComum: number;
  confianca: number;
  requerConfirmacao: true;
};

export type DependenciaAba = {
  aba:string;
  tipo:EntidadeDetectada['tipo'];
  etapa:number|null;
  etapaLabel:string;
  paisAlternativos:EntidadeDetectada['tipo'][];
  abasPaiDisponiveis:{aba:string;tipo:EntidadeDetectada['tipo'];relacionada:boolean;confirmada:boolean;campos:string[]}[];
  estado:'raiz'|'vinculada'|'pendente'|'independente';
  bloqueios:string[];
  nota:string;
};
export type ReconhecimentoEntidades = {
  entidades: EntidadeDetectada[];
  relacionamentos: RelacionamentoSugerido[];
  dependencias:DependenciaAba[];
  alertas: string[];
};

function camposDaAba(aba: string, analise: AnaliseSemantica): CampoCanonico[] {
  return [...new Set(analise.sugestoes.filter(s => s.aba === aba && s.campoCanonico).map(s => s.campoCanonico as CampoCanonico))];
}
function sugestoesDaAba(aba: string, analise: AnaliseSemantica): SugestaoCampo[] {
  return analise.sugestoes.filter(s => s.aba === aba);
}
function score(c: CampoCanonico[], ...sets: CampoCanonico[][]): number {
  const hits = sets.map(set => set.filter(f => c.includes(f)).length);
  const needed = sets.map(set => set.length);
  const total = needed.reduce((a,b)=>a+b,0);
  return total ? hits.reduce((a,b)=>a+b,0)/total : 0;
}
function classificar(c: CampoCanonico[]): EntidadeDetectada['tipo'] {
  if (c.includes('tipo_movimento') && c.includes('quantidade')) return 'movimentacao';
  if (c.includes('quantidade') && (c.includes('sku') || c.includes('nome')) && (c.includes('tamanho') || c.includes('local'))) return 'estoque';
  if (c.includes('sku') && (c.includes('cor') || c.includes('tamanho'))) return 'variacao';
  if (c.includes('sku') && c.includes('nome')) return 'produto';
  if ((c.includes('preco_venda') || c.includes('preco_atacado') || c.includes('preco_promocional') || c.includes('custo')) && !c.includes('nome')) return 'preco';
  if (c.includes('sku')) return 'sku';
  if (c.includes('fornecedor')) return 'fornecedor';
  if (c.includes('email') && c.includes('telefone')) return 'cliente';
  if (c.includes('cor') || c.includes('tamanho')) return 'sku';
  return 'tabela_generica';
}
function rowsWith(arquivo: ArquivoInventariado, sheet: string, key: string): Set<string> {
  const aba = arquivo.abas.find(a=>a.nome===sheet);
  if (!aba) return new Set();
  const col = aba.cabecalhos.find(h=>h===key);
  if (!col) return new Set();
  return new Set(aba.linhas.map(r=>String(r.valores[col]??'').trim().toUpperCase()).filter(v=>v.length>0));
}

export function construirModeloDependencias(entidades:EntidadeDetectada[],relacionamentos:RelacionamentoSugerido[]):DependenciaAba[]{
 const regras:Record<string,{etapa:number|null;label:string;pais:EntidadeDetectada['tipo'][];nota:string}>={
  produto:{etapa:1,label:'Produto base',pais:[],nota:'Entidade raiz: atributos comerciais e de catálogo formam o produto-pai.'},
  sku:{etapa:2,label:'SKU / identificador',pais:['produto'],nota:'O SKU deve identificar e apontar para o produto-pai, sem duplicar o cadastro do produto.'},
  variacao:{etapa:3,label:'Variação',pais:['sku','produto'],nota:'Cor e tamanho identificam a variação; a variação materializa-se como produto filho do produto-pai no ERP.'},
  estoque:{etapa:4,label:'Estoque físico',pais:['variacao','sku','produto'],nota:'Saldo referencia produto e, quando aplicável, tamanho/variação e local. Não cria estoque sem chave resolvida.'},
  preco:{etapa:5,label:'Preço (componente)',pais:['produto','variacao'],nota:'Preço depende de produto ou variação; não deve criar produto isoladamente.'},
  movimentacao:{etapa:6,label:'Movimentação',pais:['estoque','variacao','produto'],nota:'Movimentação depende de produto/variação e saldo/local; nunca gera cadastro independente.'},
 };
 return entidades.map(e=>{
  const regra=regras[e.tipo];if(!regra)return{aba:e.aba,tipo:e.tipo,etapa:null,etapaLabel:'Entidade independente',paisAlternativos:[],abasPaiDisponiveis:[],estado:'independente',bloqueios:[],nota:'Entidade fora da cadeia Produto → SKU → Variação → Estoque; preservada como entidade separada.'};
  if(!regra.pais.length)return{aba:e.aba,tipo:e.tipo,etapa:regra.etapa,etapaLabel:regra.label,paisAlternativos:[],abasPaiDisponiveis:[],estado:'raiz',bloqueios:[],nota:regra.nota};
  const candidatos=entidades.filter(p=>p.aba!==e.aba&&regra.pais.includes(p.tipo));
  const abasPaiDisponiveis=candidatos.map(p=>{
   const links=relacionamentos.filter(r=>(r.origemAba===p.aba&&r.destinoAba===e.aba)||(r.origemAba===e.aba&&r.destinoAba===p.aba));
   return{aba:p.aba,tipo:p.tipo,relacionada:links.length>0,confirmada:links.some((r:any)=>r.confirmado===true),campos:links.map(r=>r.campoOrigem+' ↔ '+r.campoDestino)};
  });
  const bloqueios:string[]=[];
  if(!candidatos.length)bloqueios.push('Não existe aba candidata de pai ('+regra.pais.join(' ou ')+').');
  else if(!abasPaiDisponiveis.some(p=>p.confirmada))bloqueios.push('Vínculo com aba pai precisa ser confirmado explicitamente.');
  if(abasPaiDisponiveis.some(p=>p.confirmada&&relacionamentos.some((r:any)=>((r.origemAba===p.aba&&r.destinoAba===e.aba)||(r.origemAba===e.aba&&r.destinoAba===p.aba))&&Number(r.valoresEmComum||0)===0)))bloqueios.push('Há vínculo confirmado sem valores coincidentes; revisar a chave antes de avançar.');
  const estado:DependenciaAba['estado']=abasPaiDisponiveis.some(p=>p.confirmada)?'vinculada':'pendente';
  return{aba:e.aba,tipo:e.tipo,etapa:regra.etapa,etapaLabel:regra.label,paisAlternativos:regra.pais,abasPaiDisponiveis,estado,bloqueios,nota:regra.nota};
 });
}

export function reconhecerEntidadesUniversal(arquivo: ArquivoInventariado, analise: AnaliseSemantica): ReconhecimentoEntidades {
  const entidades: EntidadeDetectada[] = arquivo.abas.map(aba => {
    const fields=camposDaAba(aba.nome,analise);
    const type=classificar(fields);
    const s=sugestoesDaAba(aba.nome,analise);
    const unknown=s.some(x=>x.campoCanonico===null);
    const confidence= type==='produto' ? score(fields,['sku','nome']) :
      type==='estoque' ? score(fields,['quantidade','sku','tamanho']) :
      type==='variacao' ? score(fields,['sku','cor','tamanho']) :
      type==='movimentacao' ? score(fields,['tipo_movimento','quantidade']) :
      type==='preco' ? score(fields,['preco_venda','preco_atacado','custo']) : 0.45;
    const reason=type==='tabela_generica' ? 'Estrutura não corresponde com segurança a uma entidade do ERP; preservada como tabela genérica.' :
      'Classificação baseada somente nos campos reconhecidos; não autoriza importação automaticamente.';
    return {aba:aba.nome,tipo:type,confianca:confidence,camposRelacionados:fields,linhasComDados:aba.linhas.length,motivo:reason,requerConfirmacao:unknown||confidence<0.9};
  });
  const relacionamentos: RelacionamentoSugerido[]=[];
  for(const a of arquivo.abas) for(const b of arquivo.abas) {
    if(a.nome===b.nome) continue;
    const keys: [CampoCanonico,CampoCanonico][]=[['sku','sku'],['referencia_externa','referencia_externa'],['codigo_barras','codigo_barras']];
    for(const [fa,fb] of keys) {
      const colA=a.cabecalhos.find(col=>analise.sugestoes.some(s=>s.aba===a.nome&&s.colunaOriginal===col&&s.campoCanonico===fa));
      const colB=b.cabecalhos.find(col=>analise.sugestoes.some(s=>s.aba===b.nome&&s.colunaOriginal===col&&s.campoCanonico===fb));
      if(!colA||!colB) continue;
      const va=rowsWith(arquivo,a.nome,colA), vb=rowsWith(arquivo,b.nome,colB);
      const overlap=[...va].filter(v=>vb.has(v)).length;
      if(overlap>0) relacionamentos.push({origemAba:a.nome,destinoAba:b.nome,tipo:fa==='sku'?'referencia_produto':fa==='codigo_barras'?'relacao_codigo':'referencia_produto',campoOrigem:colA,campoDestino:colB,valoresEmComum:overlap,confianca:Math.min(0.95,overlap/Math.max(va.size,1)),requerConfirmacao:true});
    }
  }
  const alertas:string[]=[];
  if(entidades.some(e=>e.tipo==='tabela_generica')) alertas.push('Uma ou mais abas não puderam ser classificadas com segurança; nenhum campo desconhecido será descartado.');
  if(relacionamentos.length) alertas.push('Relacionamentos entre abas foram sugeridos por valores em comum; confirme antes de vincular registros.');
  if(analise.camposDesconhecidos.length) alertas.push('Campos desconhecidos encontrados: devem ser mantidos e revisados manualmente.');
  return {entidades,relacionamentos,dependencias:construirModeloDependencias(entidades,relacionamentos),alertas};
}
