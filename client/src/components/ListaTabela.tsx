// ============================================================================
// TABELA DA LISTAGEM (modo padrão)
//
// Contrato visual:
//   • a FOTO é sempre a primeira coluna — não é opcional, não é escondida em
//     viewport menor e não depende do controle de colunas;
//   • o cabeçalho é sticky DENTRO da área de rolagem (o usuário percorre a
//     página sem perder o nome das colunas);
//   • quando não cabe tudo, a tabela rola na horizontal — nenhuma coluna
//     importante é removida automaticamente;
//   • valores longos usam ellipsis + tooltip (a coluna não empurra a vizinha);
//   • cabeçalho com ordenação server-side preservada.
// ============================================================================
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { Field } from '../lib/meta';
import {
  alinhamentoDaColuna,
  type Densidade,
  DENSIDADE_INFO,
  larguraDaColuna,
  rotuloDaColuna,
} from '../lib/lista';
import { Thumb } from './ImageField';
import { ValorCampo } from './ListaValores';

export type OrdenacaoLista = { field: string; dir: 'asc' | 'desc' } | null;

function FotoCelula({
  foto,
  quantidade,
  rotulo,
  tamanho,
  onAbrir,
}: {
  foto?: string | null;
  quantidade: number;
  rotulo: string;
  tamanho: number;
  onAbrir?: () => void;
}) {
  return (
    <span className="relative inline-flex">
      <Thumb
        src={foto}
        alt={rotulo}
        size={tamanho}
        onClick={foto ? onAbrir : undefined}
        ariaLabel={`Ampliar foto de ${rotulo}`}
        rounded="rounded-lg"
      />
      {quantidade > 1 && (
        <span
          className="pointer-events-none absolute -bottom-1 -right-1 rounded-full bg-navy-800 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white shadow"
          aria-label={`${quantidade} fotos`}
        >
          +{quantidade - 1}
        </span>
      )}
    </span>
  );
}

export function ListaTabela({
  rows,
  fields,
  recurso,
  densidade,
  sort,
  onSort,
  comFoto,
  onAbrirFoto,
  rotuloLinha,
  renderAcoes,
  onAbrirLinha,
  linhaClasse,
  caption,
}: {
  rows: Record<string, any>[];
  fields: Field[];
  recurso: string;
  densidade: Densidade;
  sort: OrdenacaoLista;
  onSort: (f: Field) => void;
  comFoto: boolean;
  onAbrirFoto?: (row: Record<string, any>) => void;
  rotuloLinha: (row: Record<string, any>) => string;
  renderAcoes?: (row: Record<string, any>) => ReactNode;
  onAbrirLinha?: (row: Record<string, any>) => void;
  linhaClasse?: (row: Record<string, any>) => string;
  caption: string;
}) {
  const info = DENSIDADE_INFO[densidade];
  return (
    // `overflow-auto` nos dois eixos: rolagem vertical (com header sticky) e
    // horizontal controlada quando a viewport é menor que a soma das colunas.
    <div className="relative min-h-[260px] max-h-[calc(100vh-20rem)] overflow-auto" data-testid="lista-tabela-scroll">
      <table className="table w-full">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {comFoto && (
              <th scope="col" className="w-[84px] min-w-[84px]">
                Foto
              </th>
            )}
            {fields.map((f) => {
              const { min } = larguraDaColuna(f, recurso);
              const rotulo = rotuloDaColuna(f, recurso);
              const ordenado = sort?.field === f.name;
              return (
                <th
                  key={f.name}
                  scope="col"
                  className={`${min} ${alinhamentoDaColuna(f)} ${info.cabecalho}`}
                  aria-sort={ordenado ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {f.virtual ? (
                    <span title={f.hint ?? rotulo}>{rotulo}</span>
                  ) : (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/40 hover:text-navy-800"
                      onClick={() => onSort(f)}
                      title={`Ordenar por ${rotulo}`}
                    >
                      {rotulo}
                      {ordenado ? (
                        sort!.dir === 'asc' ? (
                          <ArrowUp className="h-3 w-3" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3 w-3" aria-hidden="true" />
                        )
                      ) : (
                        <ArrowUpDown className="h-3 w-3 opacity-30" aria-hidden="true" />
                      )}
                    </button>
                  )}
                </th>
              );
            })}
            {renderAcoes && (
              <th scope="col" className="w-[170px] min-w-[150px] text-right">
                Ações
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rotulo = rotuloLinha(row);
            return (
              <tr
                key={row.id}
                className={`${onAbrirLinha ? 'cursor-pointer' : ''} ${linhaClasse?.(row) ?? ''}`}
                onDoubleClick={onAbrirLinha ? () => onAbrirLinha(row) : undefined}
              >
                {comFoto && (
                  <td className={`w-[84px] ${info.celula}`}>
                    <FotoCelula
                      foto={row.foto_url}
                      quantidade={Array.isArray(row.fotos) ? row.fotos.length : 0}
                      rotulo={rotulo}
                      tamanho={info.thumb}
                      onAbrir={() => onAbrirFoto?.(row)}
                    />
                  </td>
                )}
                {fields.map((f) => (
                  <td key={f.name} className={`${info.celula} ${alinhamentoDaColuna(f)}`}>
                    <ValorCampo f={f} row={row} recurso={recurso} />
                  </td>
                ))}
                {renderAcoes && (
                  <td className={`${info.celula} text-right`}>
                    <div className="inline-flex items-center gap-1">{renderAcoes(row)}</div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
