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
  type ProductSearchSize,
  type SearchProduct,
} from '../lib/productSearch';
import {
  buildProductSelection,
  parentOnlySizes,
  sizeIsSellable,
  type ProductSelection,
} from '../lib/productSelection';

type SelectionResult = void | boolean;

export type ProductSelectorProps = ProductSearchFilters & {
  id?: string;
  name?: string;
  value?: string | number | null;
  onChange?: (id: string, product?: SearchProduct, selection?: ProductSelection) => void;
  /**
   * `product` é a linha escolhida (a variação, quando for o caso) e `selection`
   * traz a combinação canônica completa: produto PAI, tamanho_id, variação,
   * SKU e preço. Quem precisa vender/baixar estoque deve usar `selection`.
   */
  onSelect?: (product: SearchProduct, selection: ProductSelection) => SelectionResult | Promise<SelectionResult>;
  /** Enter sem lista aberta: caminho rápido de leitor/SKU exato do PDV. */
  onSubmit?: (query: string) => SelectionResult | Promise<SelectionResult>;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  clearOnSelect?: boolean;
  selectParentsWithVariants?: boolean;
  /**
   * Contexto de venda: tamanho com saldo zero continua visível, mas fica
   * indisponível para escolha. Fora de venda (cadastro/filtro) pode ficar
   * desligado, porque ali o saldo não impede a seleção.
   */
  requiresStock?: boolean;
  className?: string;
  debounceMs?: number;
  'aria-label'?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Não foi possível pesquisar produtos.';
}

/** Saldo por tamanho apenas informativo (uma única combinação possível). */
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

// ---------------------------------------------------------------------------
// Modelo de opções — hierarquia pai → (tamanhos) e variações → (tamanhos)
// ---------------------------------------------------------------------------

type ProductEntry = {
  key: string;
  kind: 'product';
  row: SearchProduct;
  parent: SearchProduct | null;
  variant: boolean;
  sizes: ProductSearchSize[];
  /** Precisa de escolha explícita de tamanho/variação antes de selecionar. */
  needsSizeChoice: boolean;
  /** Pode ser escolhido diretamente (combinação única e inequívoca). */
  selectable: boolean;
  /**
   * Escolha de referência (cadastro/filtro sem `onSelect`): o formulário
   * guarda o produto pai, sem afirmar combinação de estoque. Nunca chama
   * `onSelect` com o pai — a regra 7 continua valendo.
   */
  referenceOnly: boolean;
};

type SizeEntry = {
  key: string;
  kind: 'size';
  row: SearchProduct;
  parent: SearchProduct | null;
  variant: boolean;
  size: ProductSearchSize;
  /** Tamanho existe, mas o contexto de venda exige saldo e ele é zero. */
  blocked: boolean;
};

type OptionEntry = ProductEntry | SizeEntry;

type VariantPlan = {
  product: SearchProduct;
  entry: ProductEntry;
  sizeEntries: SizeEntry[];
};

type FamilyPlan = {
  product: SearchProduct;
  variants: SearchProduct[];
  parentEntry: ProductEntry | null;
  parentSizeEntries: SizeEntry[];
  variantPlans: VariantPlan[];
  entries: OptionEntry[];
};

function optionDomId(listboxId: string, key: string): string {
  return `${listboxId}-${key}`;
}

function sizeKey(rowId: number, size: ProductSearchSize): string {
  return `s-${rowId}-${size.tamanho_id ?? 'sem'}`;
}

function isEntryDisabled(entry: OptionEntry, includeInactive: boolean): boolean {
  if (entry.kind === 'size') return entry.blocked;
  return !entry.row.ativo && !includeInactive;
}

/**
 * Seletor global de produtos. Toda a busca acontece no backend central; esta
 * tela só mantém a página já exibida (20 itens por vez), nunca o catálogo todo.
 *
 * Quando o resultado tem mais de um tamanho (ou variações), o produto-pai não é
 * escolhido diretamente: o usuário escolhe a combinação (tamanho/variação) e só
 * então `onSelect`/`onSubmit` recebem produto PAI + tamanho_id.
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
  requiresStock = false,
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
  const hintId = `${reactId}-product-hint`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestSeq = useRef(0);
  const editSeq = useRef(0);
  // Evita que o `focus()` devolvido ao campo reabra a lista recém-fechada com
  // o termo antigo (o estado de `query`/`selected` ainda é o anterior).
  const focusGuard = useRef(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SearchProduct | null>(null);
  const [selectedSize, setSelectedSize] = useState<ProductSearchSize | null>(null);
  const [rows, setRows] = useState<SearchProduct[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
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
    setHint('');
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
      setSelectedSize(null);
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
        setSelectedSize(null);
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

  // Hierarquia de opções: o pai só entra como escolha direta quando a
  // combinação é inequívoca; caso contrário ele é o cabeçalho e os tamanhos (e
  // variações) viram opções irmãs — nunca aninhadas dentro do botão do pai.
  const plans = useMemo<FamilyPlan[]>(() => rows.map((product) => {
    const variants = product.variacoes ?? [];
    const parentSizes = parentOnlySizes(product);
    const entries: OptionEntry[] = [];
    const parentSizeEntries: SizeEntry[] = [];
    const variantPlans: VariantPlan[] = [];
    let parentEntry: ProductEntry | null = null;

    const showParent = variants.length === 0 || selectParentsWithVariants;
    if (showParent) {
      const needsSizeChoice = variants.length > 0 || parentSizes.length > 1;
      parentEntry = {
        key: `p-${product.id}`,
        kind: 'product',
        row: product,
        parent: null,
        variant: false,
        sizes: parentSizes,
        needsSizeChoice,
        selectable: !needsSizeChoice,
        // Cadastro/filtro (sem `onSelect`) continua podendo apontar o pai,
        // exatamente como antes: ali o valor é uma referência de produto, não
        // uma linha de venda/estoque. Com `onSelect` a combinação é obrigatória.
        referenceOnly: needsSizeChoice && !onSelect && variants.length > 0,
      };
      entries.push(parentEntry);
      if (needsSizeChoice) {
        for (const size of parentSizes) {
          const entry: SizeEntry = {
            key: sizeKey(product.id, size),
            kind: 'size',
            row: product,
            parent: null,
            variant: false,
            size,
            blocked: !sizeIsSellable(size, requiresStock),
          };
          parentSizeEntries.push(entry);
          entries.push(entry);
        }
      }
    }

    for (const variant of variants) {
      const sizes = variant.tamanhos;
      const needsSizeChoice = sizes.length > 1;
      const entry: ProductEntry = {
        key: `v-${variant.id}`,
        kind: 'product',
        row: variant,
        parent: product,
        variant: true,
        sizes,
        needsSizeChoice,
        selectable: !needsSizeChoice,
        referenceOnly: false,
      };
      entries.push(entry);
      const sizeEntries: SizeEntry[] = [];
      if (needsSizeChoice) {
        for (const size of sizes) {
          const sizeEntry: SizeEntry = {
            key: sizeKey(variant.id, size),
            kind: 'size',
            row: variant,
            parent: product,
            variant: true,
            size,
            blocked: !sizeIsSellable(size, requiresStock),
          };
          sizeEntries.push(sizeEntry);
          entries.push(sizeEntry);
        }
      }
      variantPlans.push({ product: variant, entry, sizeEntries });
    }

    return { product, variants, parentEntry, parentSizeEntries, variantPlans, entries };
  }), [rows, selectParentsWithVariants, requiresStock, onSelect]);

  const options = useMemo(() => plans.flatMap((plan) => plan.entries), [plans]);
  const optionIndexes = useMemo(
    () => new Map(options.map((entry, index) => [entry.key, index])),
    [options],
  );

  useEffect(() => {
    if (activeIndex > options.length - 1) setActiveIndex(0);
  }, [activeIndex, options.length]);

  const commit = useCallback(async (
    row: SearchProduct,
    size: ProductSearchSize | null,
    parent: SearchProduct | null,
    explicitSize: boolean,
  ) => {
    if (selecting) return;
    requestSeq.current += 1;
    setLoading(false);
    setSelecting(true);
    setError('');
    setHint('');
    const selection = buildProductSelection(row, size, parent);
    let succeeded = true;
    try {
      const result = await onSelect?.(row, selection);
      succeeded = result !== false;
    } catch (cause) {
      succeeded = false;
      setError(errorMessage(cause));
    }
    if (succeeded) {
      onChange?.(String(row.id), row, selection);
      setOpen(false);
      if (clearOnSelect) {
        requestSeq.current += 1;
        setSelected(null);
        setSelectedSize(null);
        setQuery('');
        setRows([]);
      } else {
        setSelected(row);
        // Só mostra o tamanho no campo quando ele foi escolhido de propósito:
        // a seleção direta (combinação única) continua idêntica ao passado.
        setSelectedSize(explicitSize ? size : null);
        setQuery('');
      }
    }
    setSelecting(false);
    focusGuard.current = true;
    inputRef.current?.focus();
  }, [clearOnSelect, onChange, onSelect, selecting]);

  /** Referência administrativa ao produto pai (cadastro/filtro), sem venda. */
  const commitReference = useCallback((row: SearchProduct) => {
    if (selecting) return;
    requestSeq.current += 1;
    setLoading(false);
    setError('');
    setHint('');
    onChange?.(String(row.id), row);
    setOpen(false);
    if (clearOnSelect) {
      requestSeq.current += 1;
      setSelected(null);
      setSelectedSize(null);
      setQuery('');
      setRows([]);
    } else {
      setSelected(row);
      setSelectedSize(null);
      setQuery('');
    }
    focusGuard.current = true;
    inputRef.current?.focus();
  }, [clearOnSelect, onChange, selecting]);

  /** Escolhe a opção ativa: tamanho direto, combinação ou guia para os filhos. */
  const activate = useCallback(async (entry: OptionEntry) => {
    if (entry.kind === 'size') {
      if (entry.blocked) {
        setHint(`Tamanho ${entry.size.tamanho} sem saldo disponível para venda.`);
        return;
      }
      await commit(entry.row, entry.size, entry.parent, true);
      return;
    }
    if (!entry.selectable) {
      if (entry.referenceOnly) {
        commitReference(entry.row);
        return;
      }
      const firstSize = options.findIndex(
        (option) => option.kind === 'size' && option.row.id === entry.row.id && !option.blocked,
      );
      if (firstSize >= 0) {
        setActiveIndex(firstSize);
        setHint(`Escolha o tamanho de ${entry.row.nome} para continuar.`);
        return;
      }
      const firstVariant = options.findIndex(
        (option) => option.kind === 'product' && option.variant && option.parent?.id === entry.row.id,
      );
      if (firstVariant >= 0) {
        setActiveIndex(firstVariant);
        setHint(`Escolha a variação de ${entry.row.nome} para continuar.`);
        return;
      }
      setHint(`Nenhuma combinação disponível para ${entry.row.nome}.`);
      return;
    }
    const size = entry.sizes.length === 1 ? entry.sizes[0] : null;
    await commit(entry.row, size, entry.parent, false);
  }, [commit, commitReference, options]);

  const updateQuery = (next: string) => {
    editSeq.current += 1;
    focusGuard.current = false;
    if (selected) {
      setSelected(null);
      setSelectedSize(null);
      onChange?.('');
    }
    setQuery(next);
    setOpen(Boolean(next.trim()));
    setActiveIndex(0);
    setHint('');
  };

  const clear = () => {
    requestSeq.current += 1;
    editSeq.current += 1;
    focusGuard.current = false;
    setSelected(null);
    setSelectedSize(null);
    setQuery('');
    setRows([]);
    setOpen(false);
    setError('');
    setHint('');
    onChange?.('');
    inputRef.current?.focus();
  };

  /** Move a opção ativa pulando o que está desabilitado neste contexto. */
  const moveActive = (delta: number) => {
    if (!options.length) return;
    let index = activeIndex;
    for (let step = 0; step < options.length; step += 1) {
      index = (index + delta + options.length) % options.length;
      if (!isEntryDisabled(options[index], includeInactive)) {
        setActiveIndex(index);
        return;
      }
    }
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
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'ArrowRight') {
      const entry = options[activeIndex];
      if (!open || !entry || entry.kind !== 'product' || entry.selectable) return;
      event.preventDefault();
      void activate(entry);
      return;
    }
    if (event.key === 'ArrowLeft') {
      const entry = options[activeIndex];
      if (!open || !entry || entry.kind !== 'size') return;
      event.preventDefault();
      const parentIndex = options.findIndex(
        (option) => option.kind === 'product' && option.row.id === entry.row.id,
      );
      if (parentIndex >= 0) {
        setActiveIndex(parentIndex);
        setHint('');
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (hint) {
        // O primeiro Escape apenas recolhe a instrução de escolha.
        setHint('');
        return;
      }
      setOpen(false);
      return;
    }
    if (event.key === 'Tab') {
      setOpen(false);
      setHint('');
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (open && options.length) {
      void activate(options[Math.min(activeIndex, options.length - 1)]);
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

  const renderSizeOption = (entry: SizeEntry) => {
    const index = optionIndexes.get(entry.key);
    if (index === undefined) return null;
    const active = activeIndex === index;
    const unavailable = entry.blocked;
    return (
      <button
        key={entry.key}
        type="button"
        id={optionDomId(listboxId, entry.key)}
        role="option"
        aria-selected={active}
        aria-disabled={unavailable || undefined}
        disabled={selecting || unavailable}
        data-tamanho-id={entry.size.tamanho_id ?? ''}
        title={unavailable
          ? `Tamanho ${entry.size.tamanho} sem saldo disponível para venda`
          : `Selecionar tamanho ${entry.size.tamanho} (${formatNumber(entry.size.quantidade)} disponível)`}
        aria-label={`Tamanho ${entry.size.tamanho}: ${formatNumber(entry.size.quantidade)} disponível${unavailable ? ' — indisponível para venda' : ''}`}
        className={`rounded border px-2 py-1 font-mono text-[11px] transition ${
          unavailable
            ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400 line-through'
            : active
              ? 'border-brand-500 bg-brand-50 text-brand-900 ring-1 ring-brand-400'
              : 'border-slate-200 bg-white text-slate-700 hover:border-brand-400 hover:bg-brand-50'
        } ${selecting ? 'opacity-60' : ''}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void activate(entry)}
        onMouseEnter={() => setActiveIndex(index)}
      >
        {entry.size.tamanho}: {formatNumber(entry.size.quantidade)}
      </button>
    );
  };

  const renderProductEntry = (entry: ProductEntry, sizeEntries: SizeEntry[], variant: boolean) => {
    const index = optionIndexes.get(entry.key);
    if (index === undefined) return null;
    const active = activeIndex === index;
    const inactive = !entry.row.ativo && !includeInactive;
    return (
      <div className={`flex items-start gap-2 px-3 py-2 ${variant ? 'pl-7' : ''}`}>
        <button
          type="button"
          id={optionDomId(listboxId, entry.key)}
          role="option"
          aria-selected={active}
          aria-disabled={!entry.selectable && !entry.referenceOnly || undefined}
          disabled={selecting || inactive}
          className={`min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'text-brand-900' : ''}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void activate(entry)}
          onMouseEnter={() => setActiveIndex(index)}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {variant ? '↳ ' : ''}<span className="font-mono text-xs">{entry.row.sku}</span> — {entry.row.nome}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-500">
                {entry.row.codigo_barras && <span>EAN {entry.row.codigo_barras}</span>}
                {entry.row.cor && <span>{entry.row.cor}</span>}
                {entry.row.categoria && <span>{entry.row.categoria}</span>}
                {entry.row.marca && <span>{entry.row.marca}</span>}
                {!entry.row.ativo && <span className="font-semibold text-red-600">Inativo</span>}
              </div>
            </div>
            <span className={`shrink-0 text-xs font-semibold ${entry.row.estoque_disponivel > 0 ? 'text-emerald-700' : 'text-slate-500'}`}>
              {formatNumber(entry.row.estoque_disponivel)} un.
            </span>
          </div>
          {entry.needsSizeChoice ? (
            <div className="mt-1 text-[11px] font-medium text-brand-700">
              {entry.referenceOnly
                ? 'Escolha a variação abaixo — ou selecione o produto pai'
                : sizeEntries.length
                  ? 'Escolha o tamanho ao lado para continuar'
                  : 'Escolha uma variação/tamanho abaixo'}
            </div>
          ) : (
            <div className="mt-1.5"><StockSizes product={entry.row} /></div>
          )}
        </button>
        {entry.needsSizeChoice && sizeEntries.length > 0 && (
          <div
            role="group"
            aria-label={`Tamanhos de ${entry.row.nome}`}
            className="flex shrink-0 flex-wrap justify-end gap-1"
          >
            {sizeEntries.map(renderSizeOption)}
          </div>
        )}
      </div>
    );
  };

  const displayedValue = selected
    ? `${productLabel(selected)}${selectedSize && selectedSize.tamanho ? ` · ${selectedSize.tamanho}` : ''}`
    : query;

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
          aria-describedby={hint ? hintId : undefined}
          aria-activedescendant={open && options[activeIndex] ? optionDomId(listboxId, options[activeIndex].key) : undefined}
          autoComplete="off"
          className="input w-full pl-9 pr-9"
          placeholder={placeholder}
          value={displayedValue}
          disabled={disabled}
          required={required}
          autoFocus={autoFocus}
          onChange={(event) => updateQuery(event.target.value)}
          onFocus={() => {
            if (focusGuard.current) {
              focusGuard.current = false;
              return;
            }
            if (!selected && query.trim() && rows.length) setOpen(true);
          }}
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
          {plans.map((plan) => (
            <div key={plan.product.id} className="border-b border-slate-100 last:border-0">
              {plan.parentEntry ? (
                renderProductEntry(plan.parentEntry, plan.parentSizeEntries, false)
              ) : (
                // Pai usado apenas como cabeçalho quando a operação exige uma
                // combinação (variação/tamanho) e o chamador pediu para não
                // oferecer o pai como escolha direta.
                <div className="px-3 py-2">
                  <div className="text-sm font-medium text-slate-700">{plan.product.sku} — {plan.product.nome}</div>
                  <div className="mt-1 text-[11px] text-slate-500">Escolha uma variação/tamanho abaixo</div>
                </div>
              )}
              {plan.variantPlans.map((variantPlan) => (
                <div key={variantPlan.product.id}>
                  {renderProductEntry(variantPlan.entry, variantPlan.sizeEntries, true)}
                </div>
              ))}
            </div>
          ))}
          {rows.length > 0 && (
            <div className="flex items-center justify-between gap-2 bg-slate-50 px-3 py-2 text-[11px] text-slate-500">
              <span>{rows.length} de {total} produto(s); tamanhos e variações com os saldos reais.</span>
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

      {hint && (
        <div id={hintId} role="status" aria-live="polite" className="mt-1 text-[11px] font-medium text-amber-700">
          {hint}
        </div>
      )}
    </div>
  );
});
