import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FileUp, Loader2, ShieldCheck, AlertTriangle, Layers, Database, ScanSearch, Play, RotateCcw, CheckCircle2 } from 'lucide-react';
import { api, ApiError, downloadFile } from '../lib/api';
import { IMPORT_TIPOS } from '../lib/importacao';
import { Alert, PageHeader, useToast } from '../components/ui';
import { PageShell } from '../components/ui-kit-negocios';

type ResultadoAnalise = {
 id:string; status:string;
 analise:{
  arquivo:{nome:string;sha256:string;tipo:string;abas:{nome:string;indice:number;totalLinhas:number;totalColunas:number;linhaCabecalho:number|null;cabecalhos:string[];linhas:{linhaOrigem:number;valores:Record<string,unknown>}[];celulas:{endereco:string;formula?:string;valor:unknown}[];vazia:boolean}[]};
  semantica:{sugestoes:{aba:string;colunaOriginal:string;campoCanonico:string|null;tipoInferido:string;confianca:number;motivo:string;amostras:unknown[];requerConfirmacao:boolean}[];camposDesconhecidos:unknown[];ambiguidades:unknown[]};
  entidades:{entidades:{aba:string;tipo:string;confianca:number;camposRelacionados:string[];linhasComDados:number;motivo:string;requerConfirmacao:boolean}[];relacionamentos:unknown[];dependencias:{aba:string;tipo:string;etapa:number|null;etapaLabel:string;paisAlternativos:string[];abasPaiDisponiveis:{aba:string;tipo:string;relacionada:boolean;confirmada:boolean;campos:string[]}[];estado:'raiz'|'vinculada'|'pendente'|'independente';bloqueios:string[];nota:string;resolvidaNoERP:boolean;skusERPResolvidos:number;skusERPComPendencia:number}[];alertas:string[]};
  resumo:{abas:number;linhas:number;colunas:number;celulasOriginal:number;camposReconhecidos:number;camposDesconhecidos:number;relacionamentosSugeridos:number;perdaDadosPrevista:number;prontoParaImportar:false};
  bloqueios:string[];
 };
};

type RelacionamentoUniversal = {
 origemAba:string;destinoAba:string;tipo:'referencia_produto'|'estoque_produto'|'variacao_produto'|'relacao_codigo';
 campoOrigem:string;campoDestino:string;valoresEmComum:number;confianca:number;requerConfirmacao:true;
};
const TIPOS_RELACIONAMENTO:RelacionamentoUniversal['tipo'][]=['referencia_produto','estoque_produto','variacao_produto','relacao_codigo'];
const rotuloRelacionamento=(tipo:string)=>({referencia_produto:'Referência de produto',estoque_produto:'Estoque → produto',variacao_produto:'Variação → produto',relacao_codigo:'Relação por código'}[tipo]||tipo);

async function sha256Arquivo(file:File):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
 return Array.from(new Uint8Array(digest)).map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
function bytesParaBase64(bytes:Uint8Array):string{
 let binary='';
 const chunk=0x8000;
 for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
 return btoa(binary);
}
const tipoLabel=(tipo:string)=>({produto:'Produto',sku:'SKU/variação',variacao:'Variação',estoque:'Estoque',preco:'Preço/custo',movimentacao:'Movimentação',cliente:'Cliente',fornecedor:'Fornecedor',insumo:'Insumo',tabela_generica:'Tabela genérica'}[tipo]||tipo);

const DESTINOS_UI = [
 { id:'universal', label:'Detecção automática' },
 ...IMPORT_TIPOS.map((t)=>({id:t.tipo,label:t.label})),
];
const normalizarDestinoUI=(valor:string|null)=>DESTINOS_UI.some((d)=>d.id===valor)?(valor as string):'universal';

export default function ImportacaoUniversalPage(){
 const toast=useToast();
 const [searchParams]=useSearchParams();
 const destinoQuery=searchParams.get('destino');
 const [destino,setDestino]=useState(()=>normalizarDestinoUI(destinoQuery));
 useEffect(()=>{setDestino(normalizarDestinoUI(destinoQuery));},[destinoQuery]);
 const [file,setFile]=useState<File|null>(null);
 const [analisando,setAnalisando]=useState(false);
 const [reconciliando,setReconciliando]=useState(false);
 const [recon,setRecon]=useState<any|null>(null);
 const [previewPage,setPreviewPage]=useState(0);
 const [aprovacao,setAprovacao]=useState<any|null>(null);
 const [aprovando,setAprovando]=useState(false);
 const [resultado,setResultado]=useState<ResultadoAnalise|null>(null);
 const [erro,setErro]=useState('');
 const [mapeamentos,setMapeamentos]=useState<any[]>([]);
 const [entidadesConfirmadas,setEntidadesConfirmadas]=useState<any[]>([]);
 const [relacionamentos,setRelacionamentos]=useState<RelacionamentoUniversal[]>([]);
 const [dependencias,setDependencias]=useState<any[]>([]);
 const [mappingSaved,setMappingSaved]=useState(false);
 const [savingMapping,setSavingMapping]=useState(false);
 const [sessionIdInput,setSessionIdInput]=useState('');
 const [loadingSession,setLoadingSession]=useState(false);
 const [executando,setExecutando]=useState(false);
 const [execucao,setExecucao]=useState<any|null>(null);
 const [erroExecucao,setErroExecucao]=useState('');
 const CAMPOS_CANONICOS=['(ignorar)','sku','sku_pai','nome','razao_social','pessoa','tipo_cliente','contato','insumo','custo_medio','estoque_min','categoria','colecao','cor','tamanho','quantidade','custo','custo_aquisicao','custo_fabricacao','custo_adicional','imposto','margem','preco_venda','preco_atacado','preco_promocional','qtd_min_atacado','codigo_barras','ncm','cest','peso_g','local','local_destino','fornecedor','telefone','email','cnpj_cpf','descricao','composicao','material','modelagem','genero','marca','tipo','condicao','producao','unidade','tags','formato','ativo','codigo_item','codigo_categoria','codigo_industria','variacao_tamanho_id','motivo','tipo_movimento','data','referencia_externa','preco_atacado_vista','preco_atacado_boleto_30','preco_atacado_boleto_30_60','preco_atacado_boleto_30_60_90','preco_atacado_cartao_debito','preco_atacado_cartao_credito_vista','preco_atacado_cartao_credito_30_60','preco_atacado_cartao_credito_30_60_90','preco_varejo_vista','preco_varejo_vista_min_2_un','preco_varejo_cartao_vista','preco_varejo_cartao_parcelado','margem_bruta_atacado_vista','margem_bruta_varejo_vista','margem_bruta_varejo_min_2_un'];
 const TIPOS_ENTIDADE=['produto','sku','variacao','estoque','preco','movimentacao','cliente','fornecedor','insumo','tabela_generica'];
 const previewRows=recon?.reconciliacao?.previaConsolidada?.registros||[];
 const previewPageSize=50,previewPages=Math.max(1,Math.ceil(previewRows.length/previewPageSize));
 const previewVisible=previewRows.slice(previewPage*previewPageSize,(previewPage+1)*previewPageSize);
 const bloqueadoresDivergencia=recon?.reconciliacao?.divergencias?.filter((d:any)=>['duplicado_origem','conflito_sku','conflito_codigo_barras','ambiguidade','campo_desconhecido','orfao_relacionamento','conflito_dimensional','produto_sem_sku','sku_sem_produto','variacao_sem_produto','estoque_sem_produto','estoque_sem_local','preco_sem_produto','movimentacao_sem_produto','entidade_sem_executor','condicao_pagamento_ausente'].includes(d.tipo))||[];
 const bloqueadoresDependencia=(recon?.reconciliacao?.dependencias||[]).filter((d:any)=>['sku','variacao','estoque','preco','movimentacao'].includes(String(d.tipo))&&d.estado==='pendente'&&Array.isArray(d.bloqueios)&&d.bloqueios.length>0).map((d:any)=>({tipo:'dependencia_pendente',aba:d.aba,descricao:d.bloqueios.join(' · ')}));
 const bloqueadoresPrevia=[...bloqueadoresDivergencia,...bloqueadoresDependencia];
 useEffect(()=>{
  if(aprovacao?.status!=='processando'||!resultado?.id)return;
  const timer=window.setInterval(()=>{void api.get<any>('/importacao-universal/sessoes/'+resultado.id+'/status').then((sessao)=>{
   if(sessao.status==='concluido'||sessao.status==='falhou'){
    setExecucao(sessao.resultado||null);setAprovacao({status:sessao.status});
    if(sessao.status==='concluido')toast.success('Execução do adaptador concluída.');
    else toast.error('A execução falhou: '+String(sessao.erro||'consulte o relatório da sessão.'));
   }
  }).catch(()=>undefined);},2500);
  return ()=>window.clearInterval(timer);
 },[aprovacao?.status,resultado?.id]);
 async function aprovarPrevia(){if(!resultado?.id||!recon?.approvalHash)return;setAprovando(true);setErro('');try{const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/aprovar',{hashPreview:recon.approvalHash,versao:recon.approvalVersion});setAprovacao(response);setExecucao(null);setErroExecucao('');toast.success('Prévia aprovada. Nenhuma gravação foi executada.');}catch(e){setErro(e instanceof ApiError?e.message:'Falha ao aprovar prévia.');}finally{setAprovando(false);}}
 async function executar(){if(!resultado?.id||aprovacao?.status!=='aprovado')return;setExecutando(true);setErroExecucao('');try{const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/executar',{});setExecucao(response.resultado||response);setAprovacao({status:response.status==='processando'?'processando':'concluido',aprovadoEm:aprovacao.aprovadoEm});toast.success(response.status==='processando'?'Execução enfileirada no motor universal.':'Importação transacional concluída.');}catch(e){setErroExecucao(e instanceof ApiError?e.message:'A execução falhou e a transação foi revertida.');setAprovacao((prev:any)=>({...prev,status:'falhou'}));}finally{setExecutando(false);}}
 async function retomarExecucao(){if(!resultado?.id||aprovacao?.status!=='falhou')return;setExecutando(true);setErroExecucao('');try{await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/retomar',{});const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/executar',{});setExecucao(response.resultado||response);setAprovacao({status:'concluido'});toast.success('Importação retomada e concluída.');}catch(e){setErroExecucao(e instanceof ApiError?e.message:'Falha ao retomar; o ERP permanece protegido pelo rollback.');}finally{setExecutando(false);}}
 async function carregarSessaoPorId(sid:string):Promise<boolean>{if(!sid)return false;setLoadingSession(true);setErro('');setErroExecucao('');try{const session=await api.get<any>('/importacao-universal/sessoes/'+sid);const analysis=session.analise;if(!analysis)throw new Error('A sessão não retornou a análise original.');setResultado({id:session.id,status:session.status,analise:analysis});const confirmed=session.interpretacao?.mapeamentoConfirmado;setMapeamentos(confirmed?.mapeamentos?.map((m:any)=>({aba:m.aba,colunaOriginal:m.colunaOriginal,campoCanonico:m.campoCanonico||'',tipo:m.tipoInferido||m.tipo||'desconhecido'}))||analysis.semantica.sugestoes.map((s:any)=>({aba:s.aba,colunaOriginal:s.colunaOriginal,campoCanonico:s.campoCanonico||'',tipo:s.tipoInferido||'desconhecido'})));setEntidadesConfirmadas(confirmed?.entidades||analysis.entidades.entidades.map((e:any)=>({aba:e.aba,tipo:e.tipo})));setRelacionamentos(confirmed?.relacionamentos||analysis.entidades.relacionamentos.map((r:any)=>({origemAba:r.origemAba,destinoAba:r.destinoAba,tipo:TIPOS_RELACIONAMENTO.includes(r.tipo)?r.tipo:'referencia_produto',campoOrigem:r.campoOrigem,campoDestino:r.campoDestino,valoresEmComum:r.valoresEmComum||0,confianca:r.confianca||0,requerConfirmacao:true})));setDependencias(confirmed?.dependencias||analysis.entidades.dependencias||[]);setMappingSaved(!!confirmed);setRecon(session.reconciliacao&&Array.isArray(session.reconciliacao.divergencias)?{id:session.id,reconciliacao:session.reconciliacao,approvalHash:session.preview?.approvalHash||session.preview?.aprovacao?.hash,approvalVersion:session.preview?.approvalVersion||session.preview?.aprovacao?.versao,erpSnapshot:session.preview?.erpSnapshot||{}}:null);setAprovacao(session.status==='aprovado'?{status:'aprovado',aprovadoEm:session.aprovado_em||session.preview?.aprovacao?.aprovadoEm}:session.status==='concluido'?{status:'concluido'}:session.status==='falhou'?{status:'falhou'}:['importando','processando'].includes(session.status)?{status:'processando'}:null);setExecucao(session.status==='concluido'?session.resultado:null);setErroExecucao(session.status==='falhou'?String(session.erro||'A última tentativa falhou; nenhuma gravação foi persistida.'):'');setPreviewPage(0);setFile(null);toast.success('Sessão carregada e reconstruída a partir do arquivo original preservado.');return true;}catch(e){setErro(e instanceof ApiError?e.message:e instanceof Error?e.message:'Falha ao carregar sessão.');return false;}finally{setLoadingSession(false);}}
async function carregarSessao(){const sid=sessionIdInput.trim();if(!sid)return;await carregarSessaoPorId(sid);}
function atualizarMapeamento(index:number,field:string,value:any){setMapeamentos(prev=>prev.map((m,i)=>i===index?{...m,[field]:value}:m));setMappingSaved(false);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');}
 function atualizarEntidade(aba:string,tipo:string){setEntidadesConfirmadas(prev=>prev.map(e=>e.aba===aba?{...e,tipo}:e));setMappingSaved(false);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');}
 function atualizarRelacionamento(index:number,field:keyof RelacionamentoUniversal,value:any){setRelacionamentos(prev=>prev.map((r,i)=>i===index?{...r,[field]:value}:r));setMappingSaved(false);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');}
 function adicionarRelacionamento(){
  const abas=resultado?.analise.arquivo.abas||[],comCampos=abas.filter(a=>a.cabecalhos.length>0);if(comCampos.length<2)return;
  const origem=comCampos[0],destino=comCampos.find(a=>a.nome!==origem.nome)!;
  setRelacionamentos(prev=>[...prev,{origemAba:origem.nome,destinoAba:destino.nome,tipo:'referencia_produto',campoOrigem:origem.cabecalhos[0]||'',campoDestino:destino.cabecalhos[0]||'',valoresEmComum:0,confianca:0,requerConfirmacao:true}]);setMappingSaved(false);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');
 }
 function removerRelacionamento(index:number){setRelacionamentos(prev=>prev.filter((_,i)=>i!==index));setMappingSaved(false);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');}
 async function salvarMapeamento(){if(!resultado?.id)return;setSavingMapping(true);setErro('');
  try{const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/mapeamento',{mapeamentos:mapeamentos.map(m=>({...m,campoCanonico:m.campoCanonico||null})),entidades:entidadesConfirmadas,relacionamentos});if(Array.isArray(response.relacionamentos))setRelacionamentos(response.relacionamentos);if(Array.isArray(response.dependencias))setDependencias(response.dependencias);setAprovacao(null);setExecucao(null);setErroExecucao('');setRecon(null);setMappingSaved(true);toast.success('Mapeamento, entidades e relacionamentos confirmados e persistidos.');}
  catch(e){setErro(e instanceof ApiError?e.message:'Falha ao salvar mapeamento.');}finally{setSavingMapping(false);}
 }
 async function reconciliar(){
  if(!resultado?.id)return;
  setReconciliando(true);setErro('');
  try{
   const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/reconciliar',{});
   setRecon(response);setPreviewPage(0);setAprovacao(null);setExecucao(null);setErroExecucao('');toast.success('Reconciliação concluída. Nenhuma gravação foi executada.');
  }catch(e){setErro(e instanceof ApiError?e.message:'Falha ao reconciliar com o ERP.');}
  finally{setReconciliando(false);}
 }
 async function analisar(){
  if(!file)return;
  setAnalisando(true);setErro('');setResultado(null);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');
  try{
   const bytes=new Uint8Array(await file.arrayBuffer());
   const sha256=await sha256Arquivo(file);
   const recovery=await api.post<any>('/importacao-universal/sessoes/recuperar',{sha256});
   if(recovery?.found===true&&typeof recovery.id==='string'&&recovery.id){
    setSessionIdInput(recovery.id);
    const loaded=await carregarSessaoPorId(recovery.id);
    if(!loaded)return;
    toast.success('Sessão anterior localizada pelo SHA-256 e recuperada. O arquivo não foi reenviado.');
    return;
   }
   const base64=bytesParaBase64(bytes);
   const response=await api.post<ResultadoAnalise>('/importacao-universal/analisar',{nomeArquivo:file.name,mimeType:file.type||'application/octet-stream',arquivoBase64:base64,destino});
   setResultado(response);
   setRecon(null);setMappingSaved(false);
   setMapeamentos(response.analise.semantica.sugestoes.map((s:any)=>({aba:s.aba,colunaOriginal:s.colunaOriginal,campoCanonico:s.campoCanonico||'',tipo:s.tipoInferido||'desconhecido'})));
   setEntidadesConfirmadas(response.analise.entidades.entidades.map((e:any)=>({aba:e.aba,tipo:e.tipo})));
   setRelacionamentos((response.analise.entidades.relacionamentos||[]).map((r:any)=>({origemAba:r.origemAba,destinoAba:r.destinoAba,tipo:TIPOS_RELACIONAMENTO.includes(r.tipo)?r.tipo:'referencia_produto',campoOrigem:r.campoOrigem,campoDestino:r.campoDestino,valoresEmComum:r.valoresEmComum||0,confianca:r.confianca||0,requerConfirmacao:true})));
   setDependencias(response.analise.entidades.dependencias||[]);
   toast.success('Análise concluída. Nenhum cadastro ou estoque foi alterado.');
  }catch(e){setErro(e instanceof ApiError?e.message:e instanceof Error?e.message:'Falha ao analisar arquivo.');}
  finally{setAnalisando(false);}
 }
 return <PageShell className="pb-24 md:pb-6">
  <PageHeader title="Importação Universal" description="Analisa todas as abas, preserva os dados originais, identifica campos e relações. Nenhum registro ERP é gravado nesta etapa."/>
  <div className="space-y-5">
   <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3"><h2 className="font-semibold">Retomar sessão anterior</h2><p className="text-sm text-slate-500">Carregue uma sessão pelo identificador para recuperar o arquivo original, mapeamentos, reconciliação, aprovação ou resultado após interrupção.</p><div className="flex flex-wrap gap-2"><input className="border rounded px-3 py-2 text-sm flex-1 min-w-64" placeholder="UUID da sessão de importação" value={sessionIdInput} onChange={e=>setSessionIdInput(e.target.value)}/><button type="button" className="btn btn-secondary" disabled={!sessionIdInput.trim()||loadingSession} onClick={carregarSessao}>{loadingSession?<Loader2 className="h-4 w-4 animate-spin"/>:'Carregar sessão'}</button></div></section>
   <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
    <h2 className="font-semibold flex items-center gap-2"><Layers className="h-5 w-5"/>Destino da importação</h2>
    <p className="text-sm text-slate-500">Escolha o contexto: o motor universal continua sendo o único responsável pela leitura, validação, prévia e gravação.</p>
    <div className="flex flex-wrap items-center gap-2">
     <select aria-label="Destino da importação" className="border rounded px-3 py-2 text-sm" value={destino} onChange={(e)=>setDestino(e.target.value)}>
      {DESTINOS_UI.map((opcao)=><option key={opcao.id} value={opcao.id}>{opcao.label}</option>)}
     </select>
     <button type="button" className="btn btn-secondary text-sm" onClick={()=>void downloadFile('/importacao-universal/modelo?destino='+encodeURIComponent(destino),`modelo-${destino}.csv`).catch((e)=>toast.error(e instanceof Error?e.message:'Falha ao baixar modelo.'))}>Baixar modelo de colunas</button>
    </div>
   </section>
   <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
    <div className="flex items-center gap-2 font-semibold"><FileUp className="h-5 w-5"/>Arquivo de origem</div>
    <input type="file" accept=".xlsx,.xlsm,.csv" onChange={e=>{setFile(e.target.files?.[0]||null);setResultado(null);setRecon(null);setAprovacao(null);setExecucao(null);setErroExecucao('');setErro('');}} className="block w-full text-sm"/>
    <p className="text-xs text-slate-500">XLSX, XLSM ou CSV. Limite de 2,5 MB. O arquivo original é armazenado no registro da sessão, com SHA-256.</p>
    <button className="btn btn-primary flex items-center gap-2" disabled={!file||analisando} onClick={analisar}>
     {analisando?<Loader2 className="h-4 w-4 animate-spin"/>:<ScanSearch className="h-4 w-4"/>}
     {analisando?'Analisando todas as abas…':'Analisar planilha'}
    </button>
    {erro&&<Alert tone="red">{erro}</Alert>}
   </section>
   {resultado&&<div className="space-y-5">
    <Alert tone={aprovacao?.status==='concluido'?'green':aprovacao?.status==='falhou'?'red':'amber'}><ShieldCheck className="inline h-4 w-4 mr-1"/>Sessão {resultado.id} ativa. Status: {aprovacao?.status||resultado.status}. Arquivo original preservado.</Alert>
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
     {[
      ['Abas',resultado.analise.resumo.abas],
      ['Linhas',resultado.analise.resumo.linhas],
      ['Campos reconhecidos',resultado.analise.resumo.camposReconhecidos],
      ['Campos desconhecidos',resultado.analise.resumo.camposDesconhecidos]
     ].map(([label,value])=><div key={label} className="rounded-lg border border-slate-200 dark:border-slate-700 p-3"><div className="text-xs text-slate-500">{label}</div><div className="text-2xl font-bold">{value}</div></div>)}
    </div>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold flex items-center gap-2"><AlertTriangle className="h-5 w-5"/>Bloqueios e revisão</h2>
     {resultado.analise.bloqueios.length?<ul className="list-disc pl-5 text-sm space-y-1">{resultado.analise.bloqueios.map((x,i)=><li key={i}>{x}</li>)}</ul>:<p className="text-sm">Nenhum bloqueio de interpretação detectado. A importação continua bloqueada até o fluxo de reconciliação e aprovação.</p>}
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold flex items-center gap-2"><Layers className="h-5 w-5"/>Abas detectadas ({resultado.analise.arquivo.abas.length})</h2>
     {resultado.analise.arquivo.abas.map(aba=><details key={aba.nome} className="border rounded-lg p-3" open>
      <summary className="cursor-pointer font-medium">{aba.nome} <span className="text-xs text-slate-500">— {aba.totalLinhas} linhas / {aba.totalColunas} colunas {aba.vazia?'(vazia)':''}</span></summary>
      <div className="mt-3 overflow-auto">
       <div className="text-xs text-slate-500 mb-2">Cabeçalho detectado na linha {aba.linhaCabecalho??'não identificado'}: {aba.cabecalhos.join(' • ')||'nenhum'}</div>
       {aba.linhas.length>0&&<table className="min-w-full text-xs border-collapse"><thead><tr>{aba.cabecalhos.map(c=><th key={c} className="border px-2 py-1 text-left bg-slate-50 dark:bg-slate-800">{c}</th>)}</tr></thead><tbody>{aba.linhas.slice(0,10).map(row=><tr key={row.linhaOrigem}><td className="border px-2 py-1 text-slate-400">{row.linhaOrigem}</td>{aba.cabecalhos.map(c=><td key={c} className="border px-2 py-1">{String(row.valores[c]??'')}</td>)}</tr>)}</tbody></table>}
       <p className="text-xs text-slate-500 mt-1">Exibindo até 10 linhas. O conjunto completo permanece no registro de análise.</p>
      </div>
     </details>)}
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold flex items-center gap-2"><Database className="h-5 w-5"/>Interpretação semântica</h2>
     <div className="overflow-auto"><table className="min-w-full text-xs border-collapse"><thead><tr>{['Aba','Campo origem','Sugestão ERP','Tipo','Confiança','Revisão'].map(c=><th key={c} className="border px-2 py-2 text-left">{c}</th>)}</tr></thead><tbody>{resultado.analise.semantica.sugestoes.map((s,i)=><tr key={i}><td className="border px-2 py-1">{s.aba}</td><td className="border px-2 py-1">{s.colunaOriginal}</td><td className="border px-2 py-1">{s.campoCanonico||'—'}</td><td className="border px-2 py-1">{s.tipoInferido}</td><td className="border px-2 py-1">{Math.round(s.confianca*100)}%</td><td className="border px-2 py-1">{s.requerConfirmacao?'Confirmar':'Alta confiança'}</td></tr>)}</tbody></table></div>
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold">Mapeamento editável e confirmação</h2>
     <p className="text-sm text-slate-500">Revise os campos antes da reconciliação. Campos ignorados permanecem no arquivo RAW original. Cada campo canônico pode ser usado uma única vez por aba.</p>
     <div className="overflow-auto"><table className="min-w-full text-xs border-collapse"><thead><tr>{['Aba','Campo de origem','Campo ERP confirmado','Tipo'].map(c=><th key={c} className="border px-2 py-2 text-left">{c}</th>)}</tr></thead><tbody>{mapeamentos.map((m,i)=><tr key={m.aba+'::'+m.colunaOriginal}><td className="border px-2 py-1">{m.aba}</td><td className="border px-2 py-1">{m.colunaOriginal}</td><td className="border px-2 py-1"><select className="border rounded p-1 min-w-40" value={m.campoCanonico} onChange={e=>atualizarMapeamento(i,'campoCanonico',e.target.value)}>{CAMPOS_CANONICOS.map(c=><option key={c} value={c==='(ignorar)'?'':c}>{c==='(ignorar)'?'Ignorar campo':c}</option>)}</select></td><td className="border px-2 py-1"><select className="border rounded p-1" value={m.tipo} onChange={e=>atualizarMapeamento(i,'tipo',e.target.value)}>{['texto','numero','percentual','data','booleano','codigo','desconhecido'].map(t=><option key={t}>{t}</option>)}</select></td></tr>)}</tbody></table></div>
     <div className="space-y-2"><h3 className="font-medium text-sm">Entidade por aba</h3>{entidadesConfirmadas.map(e=><div key={e.aba} className="flex items-center justify-between gap-3 border rounded p-2"><span className="text-sm">{e.aba}</span><select className="border rounded p-1 text-sm" value={e.tipo} onChange={ev=>atualizarEntidade(e.aba,ev.target.value)}>{TIPOS_ENTIDADE.map(t=><option key={t}>{t}</option>)}</select></div>)}</div>
     <div className="flex flex-wrap items-center gap-3"><button className="btn btn-primary" disabled={savingMapping||mapeamentos.length===0} onClick={salvarMapeamento}>{savingMapping?'Salvando confirmação…':'Salvar e confirmar mapeamento'}</button>{mappingSaved&&<Alert tone="green">Mapeamento, entidades e relacionamentos confirmados e persistidos, prontos para reconciliação.</Alert>}</div>
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold flex items-center gap-2"><Layers className="h-5 w-5"/>Editor de relacionamentos entre abas</h2>
     <p className="text-sm text-slate-500">Confirme relações sugeridas ou crie relações explícitas entre abas. Cada vínculo define aba/campo de origem, aba/campo destino e tipo de relação. Nenhuma relação autoriza gravação no ERP.</p>
     {relacionamentos.length===0&&<p className="text-sm text-slate-500">Nenhum vínculo sugerido. Você pode criar um relacionamento manualmente.</p>}
     <div className="space-y-3">
      {relacionamentos.map((r,i)=>{
       const abas=resultado.analise.arquivo.abas;
       const abaOrigem=abas.find(a=>a.nome===r.origemAba),abaDestino=abas.find(a=>a.nome===r.destinoAba);
       const origemCols=abaOrigem?.cabecalhos||[],destinoCols=abaDestino?.cabecalhos||[];
       return <div key={`${r.origemAba}-${r.campoOrigem}-${r.destinoAba}-${r.campoDestino}-${i}`} className="border rounded-lg p-3 space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
         <label className="text-xs space-y-1"><span className="font-medium">Aba de origem</span><select className="border rounded p-2 w-full text-sm" value={r.origemAba} onChange={e=>{const nome=e.target.value,aba=abas.find(a=>a.nome===nome),dest=abas.find(a=>a.nome!==nome&&a.cabecalhos.length>0);atualizarRelacionamento(i,'origemAba',nome);atualizarRelacionamento(i,'campoOrigem',aba?.cabecalhos[0]||'');if(r.destinoAba===nome&&dest){atualizarRelacionamento(i,'destinoAba',dest.nome);atualizarRelacionamento(i,'campoDestino',dest.cabecalhos[0]||'');}}}>{abas.filter(a=>a.nome!==r.destinoAba&&a.cabecalhos.length>0).map(a=><option key={a.nome} value={a.nome}>{a.nome}</option>)}</select></label>
         <label className="text-xs space-y-1"><span className="font-medium">Campo de origem</span><select className="border rounded p-2 w-full text-sm" value={r.campoOrigem} onChange={e=>atualizarRelacionamento(i,'campoOrigem',e.target.value)}>{origemCols.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
         <label className="text-xs space-y-1"><span className="font-medium">Tipo de relação</span><select className="border rounded p-2 w-full text-sm" value={r.tipo} onChange={e=>atualizarRelacionamento(i,'tipo',e.target.value as RelacionamentoUniversal['tipo'])}>{TIPOS_RELACIONAMENTO.map(t=><option key={t} value={t}>{rotuloRelacionamento(t)}</option>)}</select></label>
         <label className="text-xs space-y-1"><span className="font-medium">Aba de destino</span><select className="border rounded p-2 w-full text-sm" value={r.destinoAba} onChange={e=>{const nome=e.target.value,aba=abas.find(a=>a.nome===nome),orig=abas.find(a=>a.nome!==nome&&a.cabecalhos.length>0);atualizarRelacionamento(i,'destinoAba',nome);atualizarRelacionamento(i,'campoDestino',aba?.cabecalhos[0]||'');if(r.origemAba===nome&&orig){atualizarRelacionamento(i,'origemAba',orig.nome);atualizarRelacionamento(i,'campoOrigem',orig.cabecalhos[0]||'');}}}>{abas.filter(a=>a.nome!==r.origemAba&&a.cabecalhos.length>0).map(a=><option key={a.nome} value={a.nome}>{a.nome}</option>)}</select></label>
         <label className="text-xs space-y-1"><span className="font-medium">Campo de destino</span><select className="border rounded p-2 w-full text-sm" value={r.campoDestino} onChange={e=>atualizarRelacionamento(i,'campoDestino',e.target.value)}>{destinoCols.map(c=><option key={c} value={c}>{c}</option>)}</select></label>
         <div className="text-xs text-slate-500 flex items-center">{mappingSaved?`Valores coincidentes: ${r.valoresEmComum} · Confiança: ${Math.round(r.confianca*100)}%`:'Métricas de coincidência serão recalculadas e validadas ao salvar.'}</div>
         <div className="flex items-end"><button type="button" className="btn btn-secondary text-sm" onClick={()=>removerRelacionamento(i)}>Remover vínculo</button></div>
        </div>
       </div>;
      })}
     </div>
     <div className="flex flex-wrap gap-2"><button type="button" className="btn btn-secondary" disabled={resultado.analise.arquivo.abas.filter(a=>a.cabecalhos.length>0).length<2} onClick={adicionarRelacionamento}>Adicionar relacionamento manual</button><span className="text-xs text-slate-500 self-center">Limite de 200 vínculos por sessão.</span></div>
    </section>
     <h2 className="font-semibold">Entidades reconhecidas</h2>
     {resultado.analise.entidades.entidades.map(e=><div key={e.aba} className="border rounded-lg p-3 flex flex-wrap justify-between gap-2"><div><strong>{e.aba}</strong><div className="text-xs text-slate-500">{tipoLabel(e.tipo)} · {e.linhasComDados} registros · {e.camposRelacionados.join(', ')||'sem campos reconhecidos'}</div></div><div className="text-xs">{Math.round(e.confianca*100)}% confiança {e.requerConfirmacao?'· revisar':''}</div></div>)}
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold">Modelo de dependências do ERP</h2>
     <p className="text-sm text-slate-500">A ordem canônica é Produto → SKU → Variação → Estoque. Preços e movimentações são componentes dependentes, nunca entidades isoladas para criação. As relações sugeridas não são consideradas confirmadas até serem salvas.</p>
     <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{['Produto','SKU','Variação','Estoque'].map((etapa,i)=><div key={etapa} className="rounded border p-3 text-center"><div className="text-xs text-slate-500">Etapa {i+1}</div><div className="font-semibold">{etapa}</div>{i<3&&<div className="text-xs text-slate-400 mt-1">↓ depende da etapa anterior</div>}</div>)}</div>
     {dependencias.map((d:any)=><div key={d.aba} className="border rounded-lg p-3 space-y-1"><div className="flex flex-wrap items-center justify-between gap-2"><strong>{d.aba}</strong><span className={`text-xs font-semibold px-2 py-1 rounded ${d.estado==='raiz'?'bg-green-100 text-green-800':d.estado==='vinculada'?'bg-blue-100 text-blue-800':d.estado==='pendente'?'bg-amber-100 text-amber-800':'bg-slate-100 text-slate-700'}`}>{d.etapaLabel} · {d.estado==='raiz'?'Raiz':d.estado==='vinculada'?'Vínculo confirmado':d.estado==='pendente'?'Pendente':'Independente'}</span></div><div className="text-xs text-slate-500">{d.paisAlternativos?.length?`Depende de: ${d.paisAlternativos.join(' ou ')}`:'Sem dependência hierárquica'}</div>{d.abasPaiDisponiveis?.length>0&&<div className="text-xs">Abas candidatas: {d.abasPaiDisponiveis.map((p:any)=>`${p.aba} (${p.tipo}${p.confirmada?' · confirmada':p.relacionada?' · sugerida':' · sem vínculo'})`).join(' | ')}</div>}{d.resolvidaNoERP&&<div className="text-xs text-emerald-700">Vínculo resolvido pelo ERP: {d.skusERPResolvidos} SKU(s) existente(s) com correspondência única; não exige aba de produto redundante.</div>}{d.bloqueios?.map((b:string,i:number)=><div key={i} className="text-xs text-amber-700">⚠ {b}</div>)}<div className="text-xs text-slate-500">{d.nota}</div></div>)}
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold">Reconciliação com o ERP</h2>
     <p className="text-sm text-slate-500">Consulta os dados da empresa ativa, compara com a origem e gera divergências. Etapa somente leitura.</p>
     <button className="btn btn-primary flex items-center gap-2" disabled={!mappingSaved||reconciliando} onClick={reconciliar}>{reconciliando?<Loader2 className="h-4 w-4 animate-spin"/>:<Database className="h-4 w-4"/>}{reconciliando?'Reconciliando…':'Reconciliar com ERP'}</button>
     {recon&&<div className="space-y-3">
      <Alert tone="amber">Snapshot: {recon.erpSnapshot?.produtos??0} produtos e {recon.erpSnapshot?.saldos??0} saldos. Importação continua bloqueada.</Alert>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{Object.entries(recon.reconciliacao?.totais||{}).map(([k,v])=><div key={k} className="border rounded p-2"><div className="text-xs text-slate-500">{k.replaceAll('_',' ')}</div><div className="font-bold text-lg">{String(v)}</div></div>)}</div>
      <h3 className="font-semibold text-sm">Resumo multidimensional</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{[['Relacionamentos analisados',recon.reconciliacao?.resumoDimensional?.relacionamentosAnalisados],['Correspondências',recon.reconciliacao?.resumoDimensional?.correspondencias],['Sem correspondência',recon.reconciliacao?.resumoDimensional?.semCorrespondencia],['Ambiguidades',recon.reconciliacao?.resumoDimensional?.ambiguidade],['Órfãos origem',recon.reconciliacao?.resumoDimensional?.orfaosOrigem],['Órfãos destino',recon.reconciliacao?.resumoDimensional?.orfaosDestino],['Conflitos dimensionais',recon.reconciliacao?.resumoDimensional?.conflitosDimensionais]].map(([label,value])=><div key={String(label)} className="border rounded p-2"><div className="text-xs text-slate-500">{label}</div><div className="font-bold text-lg">{String(value??0)}</div></div>)}</div>
      <section className="border rounded-lg p-3 space-y-2"><div className="flex flex-wrap justify-between items-center gap-2"><h3 className="font-semibold text-sm">Prévia consolidada dos registros</h3><span className="text-xs text-slate-500">{previewRows.length} linhas reconhecidas · página {previewPage+1}/{previewPages}</span></div><p className="text-xs text-slate-500">Visualização somente leitura: valores normalizados, origem, entidade e classificação. A prévia não grava nada no ERP.</p><div className="overflow-auto max-h-96"><table className="min-w-full text-xs border-collapse"><thead><tr>{['Aba','Linha','Entidade','SKU','Nome','Barcode','Cor','Tamanho','Qtd.','Local','Status','Campos mapeados'].map(h=><th key={h} className="border px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{previewVisible.map((r:any,i:number)=><tr key={`${r.aba}-${r.linha}-${i}`}><td className="border px-2 py-1">{r.aba}</td><td className="border px-2 py-1">{r.linha}</td><td className="border px-2 py-1">{r.entidade}</td><td className="border px-2 py-1">{String(r.mapeado.sku??'')}</td><td className="border px-2 py-1">{String(r.mapeado.nome??'')}</td><td className="border px-2 py-1">{String(r.mapeado.codigo_barras??'')}</td><td className="border px-2 py-1">{String(r.mapeado.cor??'')}</td><td className="border px-2 py-1">{String(r.mapeado.tamanho??'')}</td><td className="border px-2 py-1">{String(r.mapeado.quantidade??'')}</td><td className="border px-2 py-1">{String(r.mapeado.local??'')}</td><td className="border px-2 py-1">{r.status}{r.divergencias.length?` (${r.divergencias.join(', ')})`:''}</td><td className="border px-2 py-1">{Object.entries(r.mapeado).map(([k,v])=>`${k}: ${String(v)}`).join(' · ')}</td></tr>)}</tbody></table></div><div className="flex justify-between gap-2"><button className="btn btn-secondary text-sm" disabled={previewPage<=0} onClick={()=>setPreviewPage(p=>Math.max(0,p-1))}>Página anterior</button><button className="btn btn-secondary text-sm" disabled={previewPage+1>=previewPages} onClick={()=>setPreviewPage(p=>Math.min(previewPages-1,p+1))}>Próxima página</button></div></section>
      {aprovacao&&<Alert tone={aprovacao.status==='concluido'?'green':aprovacao.status==='falhou'?'red':'amber'}><ShieldCheck className="inline h-4 w-4 mr-1"/>{aprovacao.status==='concluido'?'Importação concluída em transação atômica.':aprovacao.status==='falhou'?'Última execução falhou; a transação foi revertida.':'Aprovação registrada. Gravação só ocorre ao executar.'}</Alert>}
      {aprovacao?.status==='aprovado'&&<section className="border rounded-lg p-3 space-y-2"><h3 className="font-semibold">Executor transacional</h3><p className="text-sm text-slate-500">Esta ação grava no ERP. Cadastros, movimentações, ajustes de saldo e auditoria são executados em uma única transação; qualquer erro cancela tudo.</p><button className="btn btn-primary flex items-center gap-2" disabled={executando} onClick={executar}>{executando?<Loader2 className="h-4 w-4 animate-spin"/>:<Play className="h-4 w-4"/>}{executando?'Executando importação…':'Executar importação aprovada'}</button></section>}
      {aprovacao?.status==='processando'&&<section className="border border-amber-300 rounded-lg p-3 space-y-2"><h3 className="font-semibold text-sm">Execução em andamento</h3><p className="text-sm text-slate-500">A operação foi aprovada e enfileirada no motor universal. Esta página acompanha o resultado; nenhuma confirmação adicional é necessária.</p></section>}
      {aprovacao?.status==='falhou'&&<section className="border border-red-300 rounded-lg p-3 space-y-2"><h3 className="font-semibold text-sm">Falha / retomada</h3>{erroExecucao&&<Alert tone="red">{erroExecucao}</Alert>}<p className="text-sm text-slate-500">A sessão preserva o arquivo, a aprovação e o diagnóstico. Retomar revalida o hash e reexecuta; a tentativa anterior foi integralmente revertida.</p><button className="btn btn-secondary flex items-center gap-2" disabled={executando} onClick={retomarExecucao}>{executando?<Loader2 className="h-4 w-4 animate-spin"/>:<RotateCcw className="h-4 w-4"/>}{executando?'Retomando…':'Retomar execução'}</button></section>}
      {execucao&&<section className="border border-green-300 rounded-lg p-3 space-y-3"><h3 className="font-semibold flex items-center gap-2"><CheckCircle2 className="h-4 w-4"/>Relatório da importação</h3><div className="grid grid-cols-2 md:grid-cols-4 gap-2">{[['Total',execucao.summary?.total],['Criados',execucao.summary?.created],['Atualizados',execucao.summary?.updated],['Ignorados',execucao.summary?.skipped]].map(([label,value])=><div key={String(label)} className="border rounded p-2"><div className="text-xs text-slate-500">{label}</div><div className="text-lg font-bold">{String(value??0)}</div></div>)}</div><div className="overflow-auto max-h-72"><table className="min-w-full text-xs border-collapse"><thead><tr>{['Entidade','Aba','Linha','Ação','ID','Detalhe'].map(h=><th key={h} className="border px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{(execucao.rows||[]).map((r:any,i:number)=><tr key={i}><td className="border px-2 py-1">{r.entidade}</td><td className="border px-2 py-1">{r.aba}</td><td className="border px-2 py-1">{r.linha}</td><td className="border px-2 py-1">{r.acao}</td><td className="border px-2 py-1">{r.id??'—'}</td><td className="border px-2 py-1">{r.detalhe??'—'}</td></tr>)}</tbody></table></div><div className="text-xs text-slate-500">SHA-256: {execucao.fileSha256||'—'} · Início: {execucao.startedAt||'—'} · Fim: {execucao.finishedAt||'—'}</div></section>}
      {!aprovacao&&<section className="border rounded-lg p-3 space-y-2"><h3 className="font-semibold text-sm">Gate de aprovação</h3>{bloqueadoresPrevia.length>0?<Alert tone="red">A aprovação está bloqueada por {bloqueadoresPrevia.length} divergência(s) impeditiva(s). Resolva os vínculos, conflitos e campos não mapeados e reconcilie novamente.</Alert>:<p className="text-sm text-slate-500">Nenhum bloqueador impeditivo encontrado. A prévia está apta a receber aprovação explícita, que ainda não grava nada no ERP.</p>}<button className="btn btn-primary" disabled={aprovando||bloqueadoresPrevia.length>0||!recon.approvalHash} onClick={aprovarPrevia}>{aprovando?'Registrando aprovação…':'Aprovar prévia consolidada'}</button></section>}
      {(recon.reconciliacao?.relacionamentos||[]).length>0&&<div className="overflow-auto"><h3 className="font-semibold text-sm mb-2">Correspondências entre abas</h3><table className="min-w-full text-xs border-collapse"><thead><tr>{['Origem','Campo','Destino','Campo','Valores comuns','Órfãos (O/D)','Duplicados (O/D)','Estado'].map(h=><th key={h} className="border px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{recon.reconciliacao.relacionamentos.map((r:any,i:number)=><tr key={i}><td className="border px-2 py-1">{r.origemAba}</td><td className="border px-2 py-1">{r.campoOrigem}</td><td className="border px-2 py-1">{r.destinoAba}</td><td className="border px-2 py-1">{r.campoDestino}</td><td className="border px-2 py-1">{r.valoresEmComum}</td><td className="border px-2 py-1">{r.orfaosOrigem}/{r.orfaosDestino}</td><td className="border px-2 py-1">{r.duplicadosOrigem}/{r.duplicadosDestino}</td><td className="border px-2 py-1">{r.estado}</td></tr>)}</tbody></table></div>}
      <div className="overflow-auto max-h-96"><h3 className="font-semibold text-sm mb-2">Divergências e bloqueios</h3><table className="min-w-full text-xs border-collapse"><thead><tr>{['Tipo','Aba','Linha(s)','Chave','Diagnóstico'].map(h=><th key={h} className="border px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{(recon.reconciliacao?.divergencias||[]).map((d:any,i:number)=><tr key={i}><td className="border px-2 py-1">{d.tipo}</td><td className="border px-2 py-1">{d.aba}</td><td className="border px-2 py-1">{d.linhasOrigem?.join(', ')||'—'}</td><td className="border px-2 py-1">{d.chave||'—'}</td><td className="border px-2 py-1">{d.descricao}</td></tr>)}</tbody></table></div>
     </div>}
    </section>
   </div>}
  </div>
 </PageShell>;
}
