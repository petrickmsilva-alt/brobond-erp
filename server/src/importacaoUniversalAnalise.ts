import { inventariarArquivoUniversal, type ArquivoInventariado, type OpcoesLeituraUniversal } from './importacaoUniversalLeitura';
import { interpretarCamposUniversal, type AnaliseSemantica } from './importacaoUniversalSemantica';
import { reconhecerEntidadesUniversal, type ReconhecimentoEntidades } from './importacaoUniversalEntidades';

export type AnaliseUniversalCompleta = {
  arquivo: ArquivoInventariado;
  semantica: AnaliseSemantica;
  entidades: ReconhecimentoEntidades;
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
  const entidades=reconhecerEntidadesUniversal(arquivo,semantica);
  const linhas=arquivo.abas.reduce((n,a)=>n+a.linhas.length,0);
  const colunas=arquivo.abas.reduce((n,a)=>n+a.cabecalhos.length,0);
  const celulasOriginal=arquivo.abas.reduce((n,a)=>n+a.celulas.length,0);
  const bloqueios:string[]=[];
  if(semantica.ambiguidades.length) bloqueios.push('Mapeamentos ambíguos precisam ser resolvidos manualmente.');
  if(semantica.camposDesconhecidos.length) bloqueios.push('Existem campos desconhecidos; nenhum será descartado.');
  if(entidades.entidades.some(e=>e.tipo==='tabela_generica')) bloqueios.push('Uma ou mais abas não possuem classificação segura.');
  if(entidades.relacionamentos.length) bloqueios.push('Relacionamentos inter-aba são sugestões e exigem confirmação.');
  return {
    arquivo,semantica,entidades,
    resumo:{abas:arquivo.abas.length,linhas,colunas,celulasOriginal,camposReconhecidos:semantica.sugestoes.filter(s=>s.campoCanonico&&!s.requerConfirmacao).length,
      camposDesconhecidos:semantica.camposDesconhecidos.length,relacionamentosSugeridos:entidades.relacionamentos.length,
      perdaDadosPrevista:0,prontoParaImportar:false},
    bloqueios,
  };
}
