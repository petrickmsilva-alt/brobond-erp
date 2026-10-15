// ============================================================================
// TopNavigation — MASTER TOP NAVIGATION do BROBOND ERP (UX-05).
//
// É a navegação PRINCIPAL do desktop: uma barra horizontal com uma entrada por
// Área da Árvore Master, cada uma abrindo um dropdown em cascata
// (Área → Grupo → Subgrupo → Módulo).
//
// Fonte única: `buildNavigationTree(visibleModules(user))` de `modules.ts`.
// Nada de árvore paralela, nada de cadastro duplicado de módulos, nada de RBAC
// próprio — a mesma `visibleModules` que já alimenta a Sidebar e a Command
// Palette decide o que aparece aqui.
//
// Requisitos atendidos (spec UX-05):
//   §5  desktop: dropdown alinhado ao item, fecha ao clicar fora, Escape fecha,
//       teclado e mouse, foco visível, área ativa e módulo atual identificados,
//       dropdown sempre dentro do viewport e com rolagem interna.
//   §6  active state automático por `moduleOfPath` (inclusive subgrupo).
//   §7  RBAC herdado de `visibleModules` (nunca mostra módulo por existir na árvore).
//   §14 acessibilidade: Tab/Shift+Tab/Enter/Space/Setas/Escape/Home/End, ARIA.
//   §15 performance: árvore memoizada por usuário, listeners só com menu aberto.
//   §17 não presume que as 11 áreas caibam em uma linha: o que não couber vai
//       para o agrupador "Mais", sem esconder nenhuma área.
// ============================================================================
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import {
  buildNavigationTree,
  moduleOfPath,
  visibleModules,
  type Module,
  type ModuleArea,
  type NavAreaNode,
  type NavGroupNode,
} from '../modules';
import { useAuth } from '../auth/AuthContext';

/**
 * Estado de navegação do desktop. É intencionalmente separado do estado do
 * drawer mobile (que vive na Sidebar) — a spec §13 proíbe reutilizar
 * cegamente um estado no outro.
 *
 * `via` distingue "aberto pelo ponteiro" de "aberto por clique/teclado": sem
 * isso, o `mouseenter` abriria o menu e o clique seguinte o fecharia na mesma
 * interação (clique deixaria de funcionar, contra a spec §5).
 */
type Via = 'hover' | 'click';
type MenuAberto = { kind: 'area'; area: ModuleArea; via: Via } | { kind: 'mais'; via: Via } | null;

/** Largura reservada para o agrupador "Mais" quando há áreas excedentes. */
export const RESERVA_MAIS = 96;

/**
 * Quantas Áreas cabem na linha antes de transbordar (§17).
 *
 * Função pura — recebe as larguras naturais medidas e a largura útil da barra,
 * e devolve quantas entradas devem ser renderizadas na linha principal. O
 * restante vai para o agrupador "Mais": nenhuma Área é descartada.
 */
export function quantasCabem(larguras: number[], larguraBarra: number, reservaMais = RESERVA_MAIS): number {
  if (!larguras.length || !larguraBarra) return larguras.length;
  let acumulado = 0;
  let cabem = 0;
  for (let i = 0; i < larguras.length; i += 1) {
    const proximo = acumulado + larguras[i];
    const precisaMais = larguras.length - (i + 1) > 0;
    if (proximo + (precisaMais ? reservaMais : 0) <= larguraBarra) {
      acumulado = proximo;
      cabem = i + 1;
    } else {
      break;
    }
  }
  return cabem >= larguras.length ? larguras.length : Math.max(1, cabem);
}

export default function TopNavigation() {
  const { user } = useAuth();
  const location = useLocation();

  // A árvore só é reconstruída quando o usuário (RBAC) muda — nunca a cada
  // abertura de menu nem a cada mudança de rota.
  const areas = useMemo<NavAreaNode[]>(() => {
    const tree = buildNavigationTree(visibleModules(user));
    return tree.flatMap((section) => section.areas);
  }, [user]);

  const moduloAtivo = useMemo(() => moduleOfPath(location.pathname, visibleModules(user)), [location.pathname, user]);
  const areaAtiva = moduloAtivo?.area;
  const grupoAtivo = moduloAtivo?.group;
  const subgrupoAtivo = moduloAtivo?.subgroup;

  const [aberto, setAberto] = useState<MenuAberto>(null);
  // Quantas áreas cabem antes de transbordar; o excedente vai para "Mais".
  const [visiveis, setVisiveis] = useState<number>(areas.length);
  const barraRef = useRef<HTMLDivElement>(null);
  const medidorRef = useRef<HTMLDivElement>(null);
  const raizRef = useRef<HTMLElement>(null);

  const fechar = useCallback(() => setAberto(null), []);

  /**
   * Abre/fecha a Área por clique ou teclado. Um menu aberto apenas por hover
   * (o ponteiro pousou nele) é CONFIRMADO no primeiro clique, em vez de fechado.
   */
  const alternarArea = useCallback((area: ModuleArea) => {
    setAberto((prev) =>
      prev?.kind === 'area' && prev.area === area && prev.via === 'click' ? null : { kind: 'area', area, via: 'click' }
    );
  }, []);

  const alternarMais = useCallback(() => {
    setAberto((prev) => (prev?.kind === 'mais' && prev.via === 'click' ? null : { kind: 'mais', via: 'click' }));
  }, []);

  const hoverArea = useCallback((area: ModuleArea, entrar: boolean) => {
    setAberto((prev) => {
      if (entrar) return prev?.kind === 'area' && prev.area === area ? prev : { kind: 'area', area, via: 'hover' };
      return prev?.kind === 'area' && prev.area === area ? null : prev;
    });
  }, []);

  const hoverMais = useCallback((entrar: boolean) => {
    setAberto((prev) => {
      if (entrar) return prev?.kind === 'mais' ? prev : { kind: 'mais', via: 'hover' };
      return prev?.kind === 'mais' ? null : prev;
    });
  }, []);

  // --- Medição do overflow (§17) -------------------------------------------
  // Mede a largura natural de cada área em um espelho invisível e decide
  // quantas entradas cabem. Nenhuma área é descartada: as que não couberem
  // aparecem dentro do dropdown "Mais".
  useLayoutEffect(() => {
    const barra = barraRef.current;
    const medidor = medidorRef.current;
    if (!barra || !medidor) return;

    const calcular = () => {
      const itens = [...medidor.querySelectorAll<HTMLElement>('[data-medida-area]')];
      const larguras = itens.map((el) => el.getBoundingClientRect().width);
      setVisiveis(quantasCabem(larguras, barra.clientWidth));
    };

    calcular();
    // `ResizeObserver` não existe em jsdom nem em navegadores muito antigos:
    // sem ele a medição ainda acontece na montagem e no `resize` da janela.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(calcular);
    ro?.observe(barra);
    window.addEventListener('resize', calcular);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', calcular);
    };
  }, [areas]);

  // --- Fechamento ao clicar fora e Escape (§5) ------------------------------
  useEffect(() => {
    if (!aberto) return;
    const onDown = (e: MouseEvent) => {
      if (raizRef.current && !raizRef.current.contains(e.target as Node)) fechar();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') fechar();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [aberto, fechar]);

  // Rota nova (deep link, clique, Command Palette): fecha o menu pendente.
  useEffect(() => {
    setAberto(null);
  }, [location.pathname]);

  const primarias = areas.slice(0, visiveis);
  const excedentes = areas.slice(visiveis);

  if (!areas.length) return null;

  return (
    <nav
      ref={raizRef}
      aria-label="Navegação principal"
      data-testid="top-navigation"
      className="relative border-t border-slate-200/80 bg-white/95 dark:border-slate-800/60 dark:bg-[#090d16]/80"
    >
      <div ref={barraRef} className="mx-auto flex h-11 max-w-[1800px] items-stretch gap-0.5 px-2 sm:px-4">
        {primarias.map((areaNode) => (
          <AreaMenu
            key={areaNode.area}
            areaNode={areaNode}
            aberto={aberto?.kind === 'area' && aberto.area === areaNode.area}
            onAlternar={() => alternarArea(areaNode.area)}
            onAbrir={() => setAberto({ kind: 'area', area: areaNode.area, via: 'click' })}
            onFechar={fechar}
            onHover={(entrar) => hoverArea(areaNode.area, entrar)}
            areaAtiva={areaAtiva === areaNode.area}
            grupoAtivo={areaAtiva === areaNode.area ? grupoAtivo : undefined}
            subgrupoAtivo={areaAtiva === areaNode.area ? subgrupoAtivo : undefined}
            moduloAtivoId={areaAtiva === areaNode.area ? moduloAtivo?.id : undefined}
            pathAtual={location.pathname}
          />
        ))}

        {excedentes.length > 0 && (
          <MaisMenu
            areas={excedentes}
            aberto={aberto?.kind === 'mais'}
            onAlternar={alternarMais}
            onAbrir={() => setAberto({ kind: 'mais', via: 'click' })}
            onHover={hoverMais}
            onFechar={fechar}
            areaAtiva={areaAtiva}
            grupoAtivo={grupoAtivo}
            subgrupoAtivo={subgrupoAtivo}
            moduloAtivoId={moduloAtivo?.id}
            pathAtual={location.pathname}
          />
        )}
      </div>

      {/* Espelho invisível: mede a largura natural de cada área sem layout real.
          Fica clipado por um contêiner do tamanho da barra — sem isso a largura
          natural (maior que o viewport) criaria overflow horizontal na página. */}
      <div aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 h-0 w-full overflow-hidden">
        <div ref={medidorRef} className="flex w-max gap-0.5 whitespace-nowrap">
          {areas.map((a) => (
            <span key={a.area} data-medida-area={a.area} className="flex shrink-0 items-center gap-1.5 px-3 text-[13px] font-semibold">
              <a.icon className="h-4 w-4" strokeWidth={2} />
              {a.area}
              <ChevronDown className="h-3.5 w-3.5" />
            </span>
          ))}
        </div>
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Entrada de Área com dropdown em cascata
// ---------------------------------------------------------------------------
function AreaMenu({
  areaNode,
  aberto,
  onAlternar,
  onAbrir,
  onHover,
  onFechar,
  areaAtiva,
  grupoAtivo,
  subgrupoAtivo,
  moduloAtivoId,
  pathAtual,
}: {
  areaNode: NavAreaNode;
  aberto: boolean;
  onAlternar: () => void;
  onAbrir: () => void;
  onHover: (entrar: boolean) => void;
  onFechar: () => void;
  areaAtiva: boolean;
  grupoAtivo?: string;
  subgrupoAtivo?: string;
  moduloAtivoId?: string;
  pathAtual: string;
}) {
  const Icon = areaNode.icon;
  const menuId = `topnav-menu-${slug(areaNode.area)}`;
  const botaoRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Deslocamento à esquerda quando o dropdown passaria da borda direita (§5).
  const [deslocamento, setDeslocamento] = useState(0);

  useLayoutEffect(() => {
    if (!aberto) {
      setDeslocamento(0);
      return;
    }
    const menu = menuRef.current;
    if (!menu) return;
    const r = menu.getBoundingClientRect();
    const margem = 8;
    const excesso = r.right - (window.innerWidth - margem);
    setDeslocamento(excesso > 0 ? -excesso : 0);
  }, [aberto]);

  // Abrir com ArrowDown/Enter/Space e já levar o foco ao primeiro módulo (§14).
  const onBotaoKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!aberto) onAbrir();
      window.setTimeout(() => focarPrimeiroItem(menuRef.current), 0);
    }
  };

  return (
    <div className="relative flex items-stretch" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <button
        ref={botaoRef}
        type="button"
        data-topnav-area={areaNode.area}
        aria-haspopup="true"
        aria-expanded={aberto}
        aria-controls={menuId}
        aria-current={areaAtiva ? 'page' : undefined}
        onClick={onAlternar}
        onKeyDown={onBotaoKeyDown}
        className={`group relative flex items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50 ${
          areaAtiva
            ? 'text-navy-900 dark:text-white'
            : aberto
              ? 'bg-slate-100 text-navy-900 dark:bg-navy-800 dark:text-white'
              : 'text-slate-600 hover:bg-slate-100 hover:text-navy-900 dark:text-slate-300 dark:hover:bg-navy-800/70 dark:hover:text-white'
        }`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${areaAtiva ? 'text-brand-500' : 'text-slate-400 group-hover:text-brand-500'}`}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className="whitespace-nowrap">{areaNode.area}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${aberto ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
        {areaAtiva && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand-500" aria-hidden="true" />}
      </button>

      {aberto && (
        <div
          style={deslocamento ? { transform: `translateX(${deslocamento}px)` } : undefined}
          className="absolute left-0 top-full z-40 w-[min(46rem,calc(100vw-2rem))] pt-1"
        >
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={`${areaNode.area} — módulos`}
            onKeyDown={(e) => onMenuKeyDown(e, botaoRef)}
            className="max-h-[min(72vh,44rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-3 shadow-modal animate-fade-in dark:border-navy-700 dark:bg-navy-900"
          >
            {areaNode.groups.length === 1 ? (
              <GroupColumns
                groupNode={areaNode.groups[0]}
                grupoAtivo={grupoAtivo}
                subgrupoAtivo={subgrupoAtivo}
                moduloAtivoId={moduloAtivoId}
                pathAtual={pathAtual}
                onNavegar={onFechar}
              />
            ) : (
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                {areaNode.groups.map((groupNode) => (
                  <div key={groupNode.group} className="min-w-0">
                    <GroupHeading groupNode={groupNode} destaque={grupoAtivo === groupNode.group} />
                    <GroupColumns
                      groupNode={groupNode}
                      grupoAtivo={grupoAtivo}
                      subgrupoAtivo={subgrupoAtivo}
                      moduloAtivoId={moduloAtivoId}
                      pathAtual={pathAtual}
                      onNavegar={onFechar}
                      semTitulo
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Cabeçalho de Grupo dentro do dropdown (nível 2 da Árvore Master). */
function GroupHeading({ groupNode, destaque }: { groupNode: NavGroupNode; destaque: boolean }) {
  const Icon = groupNode.icon;
  return (
    <div
      data-topnav-group={groupNode.group}
      className={`mb-1.5 flex items-center gap-2 border-b pb-1.5 text-[11px] font-bold uppercase tracking-wider ${
        destaque
          ? 'border-brand-500/40 text-brand-600 dark:text-brand-400'
          : 'border-slate-100 text-slate-400 dark:border-navy-800 dark:text-navy-300'
      }`}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
      <span className="truncate">{groupNode.group}</span>
    </div>
  );
}

/** Subgrupo (nível 3) + módulos (nível 4). */
function GroupColumns({
  groupNode,
  grupoAtivo,
  subgrupoAtivo,
  moduloAtivoId,
  pathAtual,
  onNavegar,
  semTitulo,
}: {
  groupNode: NavGroupNode;
  grupoAtivo?: string;
  subgrupoAtivo?: string;
  moduloAtivoId?: string;
  pathAtual: string;
  onNavegar: () => void;
  semTitulo?: boolean;
}) {
  return (
    <div className="min-w-0">
      {!semTitulo && <GroupHeading groupNode={groupNode} destaque={grupoAtivo === groupNode.group} />}
      <div className="space-y-2">
        {groupNode.subgroups.map((sub) => (
          <div key={sub.subgroup}>
            {groupNode.subgroups.length > 1 && (
              <p
                data-topnav-subgroup={sub.subgroup}
                className={`px-2 pb-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                  subgrupoAtivo === sub.subgroup ? 'text-brand-600 dark:text-brand-400' : 'text-slate-400 dark:text-navy-400'
                }`}
              >
                {sub.subgroup}
              </p>
            )}
            <ul className="space-y-0.5">
              {sub.modules.map((m) => (
                <li key={m.id}>
                  <ModuleLink m={m} ativo={moduloAtivoId === m.id} pathAtual={pathAtual} onNavegar={onNavegar} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModuleLink({ m, ativo, pathAtual, onNavegar }: { m: Module; ativo: boolean; pathAtual: string; onNavegar: () => void }) {
  const Icon = m.icon;
  const isPlanned = Boolean(m.planned?.length);
  const descendente = !ativo && pathAtual.startsWith(m.path + '/');
  const marcado = ativo || descendente;

  return (
    <Link
      to={m.path}
      role="menuitem"
      data-module-id={m.id}
      data-planned={isPlanned ? 'true' : undefined}
      aria-current={ativo ? 'page' : undefined}
      title={isPlanned ? `${m.label} — Em breve` : m.description}
      onClick={onNavegar}
      className={`flex items-center gap-2 rounded-lg px-2 py-[7px] text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50 ${
        marcado
          ? 'bg-navy-50 font-semibold text-navy-900 dark:bg-navy-800 dark:text-white'
          : isPlanned
            ? 'text-slate-400 hover:bg-slate-50 hover:text-slate-600 dark:text-navy-400 dark:hover:bg-navy-800/60 dark:hover:text-slate-200'
            : 'text-slate-600 hover:bg-slate-50 hover:text-navy-900 dark:text-slate-300 dark:hover:bg-navy-800/60 dark:hover:text-white'
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${marcado ? 'text-brand-500' : 'text-slate-400'}`} strokeWidth={2} aria-hidden="true" />
      <span className="truncate">{m.label}</span>
      {isPlanned && (
        <span className="ml-auto shrink-0 rounded border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-300">
          Em breve
        </span>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Agrupador "Mais" — áreas que não couberam na linha (§17)
// ---------------------------------------------------------------------------
function MaisMenu({
  areas,
  aberto,
  onAlternar,
  onAbrir,
  onHover,
  onFechar,
  areaAtiva,
  grupoAtivo,
  subgrupoAtivo,
  moduloAtivoId,
  pathAtual,
}: {
  areas: NavAreaNode[];
  aberto: boolean;
  onAlternar: () => void;
  onAbrir: () => void;
  onHover: (entrar: boolean) => void;
  onFechar: () => void;
  areaAtiva?: ModuleArea;
  grupoAtivo?: string;
  subgrupoAtivo?: string;
  moduloAtivoId?: string;
  pathAtual: string;
}) {
  const [areaExpandida, setAreaExpandida] = useState<ModuleArea | null>(null);
  const botaoRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const ativaNoBucket = areas.some((a) => a.area === areaAtiva);

  useEffect(() => {
    if (!aberto) setAreaExpandida(null);
    else if (ativaNoBucket && areaAtiva) setAreaExpandida(areaAtiva);
  }, [aberto, ativaNoBucket, areaAtiva]);

  return (
    <div className="relative flex items-stretch" onMouseEnter={() => onHover(true)} onMouseLeave={() => onHover(false)}>
      <button
        type="button"
        ref={botaoRef}
        data-topnav-area="__mais__"
        aria-haspopup="true"
        aria-expanded={aberto}
        aria-controls="topnav-menu-mais"
        aria-current={ativaNoBucket ? 'page' : undefined}
        onClick={onAlternar}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!aberto) onAbrir();
            window.setTimeout(() => focarPrimeiroItem(menuRef.current), 0);
          }
        }}
        className={`flex items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50 ${
          ativaNoBucket || aberto
            ? 'bg-slate-100 text-navy-900 dark:bg-navy-800 dark:text-white'
            : 'text-slate-600 hover:bg-slate-100 hover:text-navy-900 dark:text-slate-300 dark:hover:bg-navy-800/70 dark:hover:text-white'
        }`}
      >
        <MoreHorizontal className={`h-4 w-4 shrink-0 ${ativaNoBucket ? 'text-brand-500' : 'text-slate-400'}`} aria-hidden="true" />
        <span className="whitespace-nowrap">Mais</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform ${aberto ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {aberto && (
        <div className="absolute right-0 top-full z-40 w-[min(30rem,calc(100vw-2rem))] pt-1">
          <div
            ref={menuRef}
            id="topnav-menu-mais"
            role="menu"
            aria-label="Mais áreas — módulos"
            onKeyDown={(e) => onMenuKeyDown(e, botaoRef)}
            className="max-h-[min(72vh,44rem)] overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-2 shadow-modal animate-fade-in dark:border-navy-700 dark:bg-navy-900"
          >
            {areas.map((areaNode) => {
              const Icon = areaNode.icon;
              const expandida = areaExpandida === areaNode.area;
              return (
                <div key={areaNode.area} className="border-b border-slate-100 last:border-b-0 dark:border-navy-800">
                  <button
                    type="button"
                    data-topnav-area={areaNode.area}
                    aria-expanded={expandida}
                    aria-controls={`topnav-mais-${slug(areaNode.area)}`}
                    onClick={() => setAreaExpandida((prev) => (prev === areaNode.area ? null : areaNode.area))}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy-500/50 ${
                      areaAtiva === areaNode.area
                        ? 'text-brand-600 dark:text-brand-400'
                        : 'text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-navy-800/60'
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-slate-400" strokeWidth={2} aria-hidden="true" />
                    <span className="flex-1 truncate">{areaNode.area}</span>
                    <ChevronRight
                      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform ${expandida ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                  {expandida && (
                    <div id={`topnav-mais-${slug(areaNode.area)}`} className="space-y-2 px-2 pb-2 pl-4">
                      {areaNode.groups.map((groupNode) => (
                        <GroupColumns
                          key={groupNode.group}
                          groupNode={groupNode}
                          grupoAtivo={grupoAtivo}
                          subgrupoAtivo={subgrupoAtivo}
                          moduloAtivoId={moduloAtivoId}
                          pathAtual={pathAtual}
                          onNavegar={onFechar}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function slug(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
}

/**
 * Navegação por teclado dentro de um dropdown aberto (§14):
 *   ArrowDown/ArrowUp  próximo/anterior item focável
 *   Home/End           primeiro/último
 *   ArrowRight/Left    mesmo que Down/Up (cascata não é lateral aqui)
 *   Escape             fecha e devolve o foco ao botão da Área
 *   Tab/Shift+Tab      sai do menu (o listener de clique-fora fecha em seguida)
 */
function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>, gatilho: React.RefObject<HTMLElement>) {
  const menu = e.currentTarget;
  if (e.key === 'Escape') {
    e.preventDefault();
    gatilho.current?.focus();
    // Deixa o Escape subir para o handler global, que fecha o menu.
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  // `offsetParent` filtra apenas itens ocultos — em jsdom ele é sempre null, o
  // que não pode zerar a navegação; nesse caso confiamos na ordem do DOM.
  const candidatos = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"], button[data-topnav-area]')];
  const itens = candidatos.filter((el) => el.offsetParent !== null);
  const lista = itens.length ? itens : candidatos;
  if (!lista.length) return;
  const atual = lista.indexOf(document.activeElement as HTMLElement);
  const paraFrente = e.key === 'ArrowDown' || e.key === 'ArrowRight';
  let proximo: number;
  if (e.key === 'Home') proximo = 0;
  else if (e.key === 'End') proximo = lista.length - 1;
  else if (atual < 0) proximo = paraFrente ? 0 : lista.length - 1;
  else proximo = (atual + (paraFrente ? 1 : -1) + lista.length) % lista.length;
  lista[proximo]?.focus();
}

/**
 * Foca o primeiro item de um dropdown recém-aberto (abertura por teclado).
 *
 * Inclui os botões de Área do agrupador "Mais": eles não têm `role="menuitem"`
 * (são controles expansíveis, não links), então sem esse seletor a abertura por
 * teclado do "Mais" deixava o foco no gatilho. É a mesma lista que
 * `onMenuKeyDown` já usa para navegar.
 */
export function focarPrimeiroItem(menu: HTMLElement | null) {
  menu?.querySelector<HTMLElement>('[role="menuitem"], button[data-topnav-area]')?.focus();
}
