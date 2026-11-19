import { useState } from 'react';
import { FileUp, Loader2, ShieldCheck, AlertTriangle, Layers, Database, ScanSearch } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Alert, PageHeader, useToast } from '../components/ui';
import { PageShell } from '../components/ui-kit-negocios';

type ResultadoAnalise = {
 id:string; status:string;
 analise:{
  arquivo:{nome:string;sha256:string;tipo:string;abas:{nome:string;indice:number;totalLinhas:number;totalColunas:number;linhaCabecalho:number|null;cabecalhos:string[];linhas:{linhaOrigem:number;valores:Record<string,unknown>}[];celulas:{endereco:string;formula?:string;valor:unknown}[];vazia:boolean}[]};
  semantica:{sugestoes:{aba:string;colunaOriginal:string;campoCanonico:string|null;tipoInferido:string;confianca:number;motivo:string;amostras:unknown[];requerConfirmacao:boolean}[];camposDesconhecidos:unknown[];ambiguidades:unknown[]};
  entidades:{entidades:{aba:string;tipo:string;confianca:number;camposRelacionados:string[];linhasComDados:number;motivo:string;requerConfirmacao:boolean}[];relacionamentos:unknown[];alertas:string[]};
  resumo:{abas:number;linhas:number;colunas:number;celulasOriginal:number;camposReconhecidos:number;camposDesconhecidos:number;relacionamentosSugeridos:number;perdaDadosPrevista:number;prontoParaImportar:false};
  bloqueios:string[];
 };
};

function bytesParaBase64(bytes:Uint8Array):string{
 let binary='';
 const chunk=0x8000;
 for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode(...bytes.subarray(i,Math.min(i+chunk,bytes.length)));
 return btoa(binary);
}
const tipoLabel=(tipo:string)=>({produto:'Produto',sku:'SKU/variação',variacao:'Variação',estoque:'Estoque',preco:'Preço/custo',movimentacao:'Movimentação',cliente:'Cliente',fornecedor:'Fornecedor',tabela_generica:'Tabela genérica'}[tipo]||tipo);

export default function ImportacaoUniversalPage(){
 const toast=useToast();
 const [file,setFile]=useState<File|null>(null);
 const [analisando,setAnalisando]=useState(false);
 const [reconciliando,setReconciliando]=useState(false);
 const [recon,setRecon]=useState<any|null>(null);
 const [resultado,setResultado]=useState<ResultadoAnalise|null>(null);
 const [erro,setErro]=useState('');
 async function reconciliar(){
  if(!resultado?.id)return;
  setReconciliando(true);setErro('');
  try{
   const response=await api.post<any>('/importacao-universal/sessoes/'+resultado.id+'/reconciliar',{});
   setRecon(response);toast.success('Reconciliação concluída. Nenhuma gravação foi executada.');
  }catch(e){setErro(e instanceof ApiError?e.message:'Falha ao reconciliar com o ERP.');}
  finally{setReconciliando(false);}
 }
 async function analisar(){
  if(!file)return;
  setAnalisando(true);setErro('');setResultado(null);
  try{
   const bytes=new Uint8Array(await file.arrayBuffer());
   const base64=bytesParaBase64(bytes);
   const response=await api.post<ResultadoAnalise>('/importacao-universal/analisar',{nomeArquivo:file.name,mimeType:file.type||'application/octet-stream',arquivoBase64:base64});
   setResultado(response);
   toast.success('Análise concluída. Nenhum cadastro ou estoque foi alterado.');
  }catch(e){setErro(e instanceof ApiError?e.message:'Falha ao analisar arquivo.');}
  finally{setAnalisando(false);}
 }
 return <PageShell className="pb-24 md:pb-6">
  <PageHeader title="Importação Universal" description="Analisa todas as abas, preserva os dados originais, identifica campos e relações. Nenhum registro ERP é gravado nesta etapa."/>
  <div className="space-y-5">
   <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
    <div className="flex items-center gap-2 font-semibold"><FileUp className="h-5 w-5"/>Arquivo de origem</div>
    <input type="file" accept=".xlsx,.xlsm,.csv" onChange={e=>{setFile(e.target.files?.[0]||null);setResultado(null);setErro('');}} className="block w-full text-sm"/>
    <p className="text-xs text-slate-500">XLSX, XLSM ou CSV. Limite de 2,5 MB. O arquivo original é armazenado no registro da sessão, com SHA-256.</p>
    <button className="btn btn-primary flex items-center gap-2" disabled={!file||analisando} onClick={analisar}>
     {analisando?<Loader2 className="h-4 w-4 animate-spin"/>:<ScanSearch className="h-4 w-4"/>}
     {analisando?'Analisando todas as abas…':'Analisar planilha'}
    </button>
    {erro&&<Alert tone="red">{erro}</Alert>}
   </section>
   {resultado&&<div className="space-y-5">
    <Alert tone="green"><ShieldCheck className="inline h-4 w-4 mr-1"/>Sessão {resultado.id} criada. Status: {resultado.status}. Arquivo preservado; importação ainda bloqueada.</Alert>
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
     <h2 className="font-semibold">Entidades reconhecidas</h2>
     {resultado.analise.entidades.entidades.map(e=><div key={e.aba} className="border rounded-lg p-3 flex flex-wrap justify-between gap-2"><div><strong>{e.aba}</strong><div className="text-xs text-slate-500">{tipoLabel(e.tipo)} · {e.linhasComDados} registros · {e.camposRelacionados.join(', ')||'sem campos reconhecidos'}</div></div><div className="text-xs">{Math.round(e.confianca*100)}% confiança {e.requerConfirmacao?'· revisar':''}</div></div>)}
    </section>
    <section className="rounded-xl border border-slate-200 dark:border-slate-700 p-4 space-y-3">
     <h2 className="font-semibold">Reconciliação com o ERP</h2>
     <p className="text-sm text-slate-500">Consulta os dados da empresa ativa, compara com a origem e gera divergências. Etapa somente leitura.</p>
     <button className="btn btn-primary flex items-center gap-2" disabled={reconciliando} onClick={reconciliar}>{reconciliando?<Loader2 className="h-4 w-4 animate-spin"/>:<Database className="h-4 w-4"/>}{reconciliando?'Reconciliando…':'Reconciliar com ERP'}</button>
     {recon&&<div className="space-y-3">
      <Alert tone="amber">Snapshot: {recon.erpSnapshot?.produtos??0} produtos e {recon.erpSnapshot?.saldos??0} saldos. Importação continua bloqueada.</Alert>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">{Object.entries(recon.reconciliacao?.totais||{}).map(([k,v])=><div key={k} className="border rounded p-2"><div className="text-xs text-slate-500">{k.replaceAll('_',' ')}</div><div className="font-bold text-lg">{String(v)}</div></div>)}</div>
      <div className="overflow-auto max-h-96"><table className="min-w-full text-xs border-collapse"><thead><tr>{['Tipo','Aba','Linha(s)','Chave','Diagnóstico'].map(h=><th key={h} className="border px-2 py-1 text-left">{h}</th>)}</tr></thead><tbody>{(recon.reconciliacao?.divergencias||[]).map((d:any,i:number)=><tr key={i}><td className="border px-2 py-1">{d.tipo}</td><td className="border px-2 py-1">{d.aba}</td><td className="border px-2 py-1">{d.linhasOrigem?.join(', ')||'—'}</td><td className="border px-2 py-1">{d.chave||'—'}</td><td className="border px-2 py-1">{d.descricao}</td></tr>)}</tbody></table></div>
     </div>}
    </section>
   </div>}
  </div>
 </PageShell>;
}
