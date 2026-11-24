import { inventariarArquivoUniversal, type ArquivoInventariado, type OpcoesLeituraUniversal } from './importacaoUniversalLeitura';
import { interpretarCamposUniversal, type AnaliseSemantica } from './importacaoUniversalSemantica';
import { reconhecerEntidadesUniversal, tiposPorAbaDaAnalise, type ReconhecimentoEntidades } from './importacaoUniversalEntidades';
import { planoHierarquiaDeAnalise, type PlanoHierarquiaUniversal } from './importacaoUniversalHierarquia';

export type AnaliseUniversalCompleta = {
  arquivo: ArquivoInventariado;
  semantica: AnaliseSemantica;
  entidades: ReconhecimentoEntidades;
  hierarquia: PlanoHierarquiaUniversal;
  resumo: {
    abas: number;
    linhas: number;
    colunas: number;
    celulasOriginal: number;
    camposReconhecidos: number;
    camposDesconhecidos: number;
    relacionamentosSugeridos: number;
    perdaDadosPrevista: 0;
    prontoParaImportar: false;
  };
  bloqueios: string[];
};

export async function analisarArquivoUniversal(opts: OpcoesLeituraUniversal): Promise<AnaliseUniversalCompleta> {
  const arquivo=await inventariarArquivoUniversal(opts);
  const semantica=interpretarCamposUniversal(arquivo);
  // O resolvedor de hierarquia é parte do núcleo e opera sobre o MESMO
  // inventário/mapeamento, inclusive quando há uma única aba (CSV). A
  // classificação canônica da aba impede que estoque/movimentação sejam
  // tratados como catálogo de pais e variantes.
  const tiposPorAba=tiposPorAbaDaAnalise(arquivo,semantica);
  const hierarquia=planoHierarquiaDeAnalise(arquivo,semantica,{tiposPorAba});
  const entidades=reconhecerEntidadesUniversal(arquivo,semantica,hierarquia.porAba);
  const linhas=arquivo.abas.reduce((n,a)=>n+a.linhas.length,0);
  const colunas=arquivo.abas.reduce((n,a)=>n+a.cabecalhos.length,0);
  const celulasOriginal=arquivo.abas.reduce((n,a)=>n+a.celulas.length,0);
  const bloqueios:string[]=[];
  if(semantica.ambiguidades.length) bloqueios.push('Mapeamentos ambíguos precisam ser resolvidos manualmente.');
  if(semantica.camposDesconhecidos.length) bloqueios.push('Existem campos desconhecidos; nenhum será descartado.');
  if(entidades.entidades.some(e=>e.tipo==='tabela_generica')) bloqueios.push('Uma ou mais abas não possuem classificação segura.');
  if(entidades.relacionamentos.length) bloqueios.push('Relacionamentos inter-aba são sugestões e exigem confirmação.');
  return {
    arquivo,semantica,entidades,hierarquia,
    resumo:{abas:arquivo.abas.length,linhas,colunas,celulasOriginal,camposReconhecidos:semantica.sugestoes.filter(s=>s.campoCanonico&&!s.requerConfirmacao).length,
      camposDesconhecidos:semantica.camposDesconhecidos.length,relacionamentosSugeridos:entidades.relacionamentos.length,
      perdaDadosPrevista:0,prontoParaImportar:false},
    bloqueios,
  };
}
