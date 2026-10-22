import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Loader2, Search, X } from 'lucide-react';
import { formatNumber } from '../lib/format';
import {
  productLabel,
  searchProducts,
  type ProductSearchFilters,
  type SearchProduct,
} from '../lib/productSearch';

type SelectionResult = void | boolean;

export type ProductSelectorProps = ProductSearchFilters & {
  id?: string;
  name?: string;
  value?: string | number | null;
  onChange?: (id: string, product?: SearchProduct) => void;
  onSelect?: (product: SearchProduct) => SelectionResult | Promise<SelectionResult>;
  /** Enter sem lista aberta: caminho rápido de leitor/SKU exato do PDV. */
  onSubmit?: (query: string) => SelectionResult | Promise<SelectionResult>;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  clearOnSelect?: boolean;
  selectParentsWithVariants?: boolean;
  className?: string;
  debounceMs?: number;
  'aria-label'?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível pesquisar produtos.';
}

function StockSizes({ product }: { product: SearchProduct }) {
  if (!product.tamanhos.length) {
    return <span className="text-[11px] text-slate-500">Sem saldo</span>;
  }
  return (
    <span className="flex flex-wrap gap-1" aria-label={`Saldo total ${formatNumber(product.estoque_disponivel)}`}>
      {product.tamanhos.map((size) => (
        <span
          key={`${size.tamanho_id ?? 'sem'}-${size.tamanho}`}
          className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${size.quantidade > 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
        >
          {size.tamanho}: {formatNumber(size.quantidade)}
        </span>
      ))}
    </span>
  );
}

/**
 * Seletor global de produtos. Toda a busca acontece no backend central; esta
 * tela só mantém a página já exibida (20 itens por vez), nunca o catálogo todo.
 */
export const ProductSelector = forwardRef<HTMLInputElement, ProductSelectorProps>(function ProductSelector({
  id,
  name,
  value,
  onChange,
  onSelect,
  onSubmit,
  placeholder = 'Buscar por nome, SKU, barcode, cor, categoria, marca…',
  disabled = false,
  required = false,
  autoFocus = false,
  clearOnSelect = false,
  selectParentsWithVariants = true,
  className = '',
  debounceMs = 200,
  onlyInStock = false,
  inStockFirst = false,
  includeInactive = false,
  localId = null,
  'aria-label': ariaLabel = 'Buscar produto',
}, ref) {
  const reactId = useId();
  const listboxId = `${reactId}-product-results`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const editSeq = useRef(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SearchProduct | null>(null);
  const [rows, setRows] = useState<SearchProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [reload, setReload] = useState(0);

  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement, []);

  const load = useCallback(async (term: string, requestedPage: number, append: boolean) => {
    const sequence = ++requestSeq.current;
    setLoading(true);
    setError('');
    try {
      const response = await searchProducts(term, {
        page: requestedPage,
        pageSize: 20,
        onlyInStock,
        inStockFirst,
        includeInactive,
        localId,
      });
      if (sequence !== requestSeq.current) return;
      setRows((current) => append ? [...current, ...response.rows] : response.rows);
      setPage(response.page);
      setTotal(response.total);
      setHasMore(response.hasMore);
      setActiveIndex((current) => append ? current : 0);
      setOpen(true);
    } catch (cause) {
      if (sequence !== requestSeq.current) return;
      setError(errorMessage(cause));
      if (!append) setRows([]);
      setOpen(true);
    } finally {
      if (sequence === requestSeq.current) setLoading(false);
    }
  }, [onlyInStock, inStockFirst, includeInactive, localId]);

  // Debounce e sequência de requisição impedem que uma resposta antiga
  // sobrescreva o termo mais recente. Uma tecla não dispara uma requisição.
  useEffect(() => {
    if (selected || disabled) return;
    const term = query.trim();
    if (!term) {
      requestSeq.current += 1;
      setRows([]);
      setTotal(0);
      setHasMore(false);
      setLoading(false);
      setError('');
      return;
    }
    const timer = window.setTimeout(() => void load(term, 1, false), Math.max(0, debounceMs));
    return () => window.clearTimeout(timer);
  }, [query, selected, disabled, debounceMs, load, reload]);

  // Formulários de edição recebem somente o ID. Recupera esse único registro
  // pela mesma API, sem depender de uma lista de opções pré-carregada.
  useEffect(() => {
    if (value === undefined) return;
    const numericId = Number(value);
    if (!value || !Number.isInteger(numericId) || numericId < 1) {
      // Num formulário controlado, a primeira tecla ao editar uma seleção
      // também emite onChange(''). Não interpretar esse eco como reset e
      // apagar o termo que acabou de ser digitado. Um reset externo ainda
      // limpa o texto quando havia uma seleção efetivamente exibida.
      if (selected) setQuery('');
      setSelected(null);
      return;
    }
    // Alguns fluxos persistem o pai (venda/estoque/produção), embora a
    // apresentação e o preço sejam da variação. Ambos representam a seleção
    // atual; buscar o pai nesse caso apagaria indevidamente a variante da tela.
    if (selected && (selected.id === numericId || selected.produto_pai_id === numericId)) return;
    let alive = true;
    const editSequence = editSeq.current;
    void searchProducts('', { id: numericId, pageSize: 1, includeInactive: true })
      .then((response) => {
        if (!alive || editSequence !== editSeq.current || !response.rows[0]) return;
        setSelected(response.rows[0]);
        setOpen(false);
      })
      .catch(() => {
        // O ID continua no formulário; o usuário pode limpar e pesquisar outro.
      });
    return () => { alive = false; };
  }, [value, selected]);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsideClick);
    return () => document.removeEventListener('pointerdown', closeOnOutsideClick);
  }, []);

  const options = useMemo(() => rows.flatMap((product) => {
    const variants = product.variacoes ?? [];
    const parent = selectParentsWithVariants || !variants.length ? [product] : [];
    return [...parent, ...variants];
  }), [rows, selectParentsWithVariants]);
  const optionIndexes = useMemo(() => new Map(options.map((product, index) => [product.id, index])), [options]);

  const choose = async (product: SearchProduct) => {
    if (selecting) return;
    requestSeq.current += 1;
    setLoading(false);
    setSelecting(true);
    setError('');
    let succeeded = true;
    try {
      const result = await onSelect?.(product);
      succeeded = result !== false;
    } catch (cause) {
      succeeded = false;
      setError(errorMessage(cause));
    }
    if (succeeded) {
      onChange?.(String(product.id), product);
      setOpen(false);
      if (clearOnSelect) {
        requestSeq.current += 1;
        setSelected(null);
        setQuery('');
        setRows([]);
      } else {
        setSelected(product);
        setQuery('');
      }
    }
    setSelecting(false);
    inputRef.current?.focus();
  };

  const updateQuery = (next: string) => {
    editSeq.current += 1;
    if (selected) {
      setSelected(null);
      onChange?.('');
    }
    setQuery(next);
    setOpen(Boolean(next.trim()));
    setActiveIndex(0);
  };

  const clear = () => {
    requestSeq.current += 1;
    editSeq.current += 1;
    setSelected(null);
    setQuery('');
    setRows([]);
    setOpen(false);
    setError('');
    onChange?.('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        if (query.trim() && !rows.length) setReload((current) => current + 1);
        return;
      }
      if (!options.length) return;
      if (event.key === 'ArrowDown' && activeIndex === options.length - 1 && hasMore && !loading) {
        void load(query.trim(), page + 1, true);
        return;
      }
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + delta + options.length) % options.length);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (open && options.length) {
      void choose(options[Math.min(activeIndex, options.length - 1)]);
      return;
    }
    if (onSubmit && query.trim()) {
      const term = query.trim();
      requestSeq.current += 1;
      setLoading(false);
      void Promise.resolve(onSubmit(term)).then((result) => {
        if (result !== false && clearOnSelect) {
          setQuery('');
          setRows([]);
          setOpen(false);
        }
        inputRef.current?.focus();
      }).catch((cause) => setError(errorMessage(cause)));
    }
  };

  const renderOption = (product: SearchProduct, variant = false) => {
    const index = optionIndexes.get(product.id);
    if (index === undefined) {
      // Pai usado apenas como cabeçalho quando a operação exige uma variação.
      return (
        <div className="border-b border-slate-100 px-3 py-2">
          <div className="text-sm font-medium text-slate-700">{product.sku} — {product.nome}</div>
          <div className="mt-1 text-[11px] text-slate-500">Escolha uma variação/tamanho abaixo</div>
        </div>
      );
    }
    return (
      <button
        type="button"
        id={`${listboxId}-${product.id}`}
        role="option"
        aria-selected={activeIndex === index}
        disabled={selecting || (!product.ativo && !includeInactive)}
        className={`block w-full border-b border-slate-100 px-3 py-2 text-left last:border-0 ${variant ? 'pl-7' : ''} ${activeIndex === index ? 'bg-brand-50 text-brand-900' : 'hover:bg-slate-50'} disabled:cursor-not-allowed disabled:opacity-50`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void choose(product)}
        onMouseEnter={() => setActiveIndex(index)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {variant ? '↳ ' : ''}<span className="font-mono text-xs">{product.sku}</span> — {product.nome}
            </div>
            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
              {product.codigo_barras && <span>EAN {product.codigo_barras}</span>}
              {product.cor && <span>{product.cor}</span>}
              {product.categoria && <span>{product.categoria}</span>}
              {product.marca && <span>{product.marca}</span>}
              {!product.ativo && <span className="font-semibold text-red-600">Inativo</span>}
            </div>
          </div>
          <span className={`shrink-0 text-xs font-semibold ${product.estoque_disponivel > 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
            {formatNumber(product.estoque_disponivel)} un.
          </span>
        </div>
        <div className="mt-1.5"><StockSizes product={product} /></div>
      </button>
    );
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && options[activeIndex] ? `${listboxId}-${options[activeIndex].id}` : undefined}
          autoComplete="off"
          className="input w-full pl-9 pr-9"
          placeholder={placeholder}
          value={selected ? productLabel(selected) : query}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => { if (query.trim() && rows.length) setOpen(true); }}
          onKeyDown={handleKeyDown}
        />
        {(loading || selecting) ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-label="Pesquisando" />
        ) : (query || selected) ? (
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={clear} aria-label="Limpar produto">
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open && !disabled && (
        <div className="absolute z-50 mt-1 max-h-96 w-full min-w-[22rem] overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-xl" role="listbox" id={listboxId} aria-label="Resultados de produtos">
          {loading && !rows.length && <div className="px-3 py-4 text-sm text-slate-500">Pesquisando produtos…</div>}
          {!loading && error && <div className="px-3 py-4 text-sm text-red-600" role="alert">{error}</div>}
          {!loading && !error && !rows.length && query.trim() && (
            <div className="px-3 py-4 text-sm text-slate-500">Nenhum produto encontrado para “{query.trim()}”.</div>
          )}
          {rows.map((product) => (
            <div key={product.id}>
              {renderOption(product)}
              {(product.variacoes ?? []).map((variant) => (
                <div key={variant.id}>{renderOption(variant, true)}</div>
              ))}
            </div>
          ))}
          {rows.length > 0 && (
            <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
              <span>{rows.length} de {total} produto(s); variações exibidas com seus saldos.</span>
              {hasMore && (
                <button
                  type="button"
                  className="font-semibold text-brand-700 hover:underline disabled:opacity-50"
                  disabled={loading}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void load(query.trim(), page + 1, true)}
                >
                  Mostrar mais (ou ↓ no último)
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
