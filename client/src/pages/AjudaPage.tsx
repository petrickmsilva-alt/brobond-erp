import { Link } from 'react-router-dom';
import { ArrowRight, BookOpen, HelpCircle } from 'lucide-react';
import { MODULES, type Module } from '../modules';
import { PageHeader } from '../components/ui';

const GUIAS: { titulo: string; modulos: string[]; passos: string[] }[] = [
  {
    titulo: 'Começar (primeiros cadastros)',
    modulos: ['tamanhos', 'categorias', 'cores', 'insumos', 'fornecedores', 'produtos'],
    passos: [
      'Cadastre os tamanhos da grade (PP, P, M, G, GG) com a ordem de exibição.',
      'Cadastre categorias, cores e coleções.',
      'Cadastre os insumos (tecido, botão, zíper...) com unidade, fornecedor e custo médio.',
      'Cadastre os produtos com SKU, código de barras (EAN) e preço de venda.',
    ],
  },
  {
    titulo: 'Ficha técnica e custo (F3)',
    modulos: ['custo', 'fichas'],
    passos: [
      'Em “Custo de Fabricação”, crie a ficha do produto informando mão de obra, indiretos e margem.',
      'Na ficha, adicione os insumos com consumo por peça e perda (%): o custo e o preço sugerido são recalculados na hora.',
      'Clique em “Aplicar preço ao produto” para gravar custo e preço de venda (fica na auditoria).',
    ],
  },
  {
    titulo: 'Ordens de fabricação (F3)',
    modulos: ['ordens', 'fichas'],
    passos: [
      'Crie uma OP por tamanho único ou por grade (vários tamanhos na mesma OP).',
      'Ao concluir, as peças entram no Local padrão (configurável em Estoque → Locais) e os insumos da ficha são baixados (com a perda).',
      'Sem saldo de insumos? O sistema bloqueia — gerente/admin pode concluir com ?forcar=true, deixando o saldo negativo e auditado.',
      'Reabrir uma OP concluída estorna tudo automaticamente.',
    ],
  },
  {
    titulo: 'Estoque, locais e grade (F4)',
    modulos: ['locais', 'estoque', 'inventario', 'movimentacoes'],
    passos: [
      'Cadastre locais (almoxarifado, loja, expedição, facção). Marque um deles como "Local padrão" — ele passa a ser a origem padrão das movimentações (substitui o antigo padrão fixo "almoxarifado").',
      'Gestão livre: o administrador pode incluir, alterar e excluir um local mesmo que ele já esteja em uso. Renomear propaga o novo nome para saldos, movimentações e inventários; excluir mantém o histórico com o nome do local (só o cadastro sai).',
      'A página “Estoque Físico — Grade” mostra a matriz produto × tamanho; clique numa célula para lançar entrada/saída/ajuste.',
      'Transferências: no módulo Movimentações, escolha “transferência”, origem e destino (a saída e a entrada são lançadas juntas).',
      'Inventário: abra uma contagem por local (congela os saldos), digite as contagens e feche — os ajustes são gerados uma única vez.',
    ],
  },
  {
    titulo: 'Compras, vendas e representantes',
    modulos: ['compras', 'vendas', 'representantes', 'clientes'],
    passos: [
      'Compras: monte o pedido de insumos; ao “receber”, o estoque do insumo entra e o custo médio é recalculado.',
      'Vendas: monte o pedido com produto × tamanho; ao faturar, as peças saem do estoque e a comissão do representante é calculada.',
      'Pedidos podem ser impressos em A4.',
    ],
  },
  {
    titulo: 'Importar e exportar planilhas (F5)',
    modulos: ['produtos', 'clientes', 'fornecedores', 'insumos'],
    passos: [
      'Em qualquer listagem: “Exportar” baixa CSV (Excel pt-BR) ou XLSX respeitando a busca e os filtros ativos.',
      'Produtos, clientes, fornecedores, insumos e saldos iniciais podem ser importados de CSV ou XLSX com pré-visualização, validação linha a linha e modelo para download.',
      'O dashboard traz vendas dos últimos 12 meses, produção das últimas 8 semanas, top 10 produtos e insumos em alerta.',
    ],
  },
  {
    titulo: 'Conta e segurança (F6)',
    modulos: ['config', 'usuarios', 'auditoria'],
    passos: [
      '“Lembrar-me” no login mantém a sessão por 30 dias neste navegador.',
      'Esqueceu a senha? “Esqueci minha senha” envia um link (válido por 1 hora) para o seu e-mail.',
      'Em Configurações você troca a senha (política: mín. 8 caracteres, sem palavras óbvias) e pode “Sair de todos os dispositivos”.',
      'Administradores gerenciam usuários/perfis e veem a auditoria completa; o backup do banco pode ser baixado em Configurações.',
    ],
  },
  {
    titulo: 'Celular e catálogos (F7)',
    modulos: ['config', 'produtos'],
    passos: [
      'Use pelo celular: as listagens viram cartões com botão flutuante (+), e dá para instalar como aplicativo (PWA).',
      'Crie catálogos públicos (módulo Catálogos) para compartilhar produtos com preço por link — sem login do cliente.',
      'As preferências que você salvar em Configurações ficam guardadas por usuário.',
    ],
  },
];

function mod(m: string): Module | undefined {
  return MODULES.find((x) => x.id === m);
}

export default function AjudaPage() {
  return (
    <div className="p-4 pb-16 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-navy-800 text-white">
              <HelpCircle className="h-5 w-5" />
            </span>
            Ajuda — guia rápido
          </span>
        }
        description="Como usar cada parte do BROBOND ERP, na ordem em que a fábrica trabalha."
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {GUIAS.map((g) => (
          <section key={g.titulo} className="card p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-navy-900">
              <BookOpen className="h-4 w-4 text-brand-500" />
              {g.titulo}
            </h2>
            <ol className="mt-3 space-y-2">
              {g.passos.map((p, i) => (
                <li key={i} className="flex gap-2.5 text-sm text-slate-600">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-navy-50 text-[11px] font-bold text-navy-600">{i + 1}</span>
                  {p}
                </li>
              ))}
            </ol>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {g.modulos.map((mid) => {
                const m = mod(mid);
                if (!m) return null;
                const Icon = m.icon;
                return (
                  <Link key={mid} to={m.path} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-navy-800 transition-colors hover:border-brand-300 hover:bg-brand-50">
                    <Icon className="h-3.5 w-3.5 text-slate-400" />
                    {m.label}
                    <ArrowRight className="h-3 w-3 text-slate-300" />
                  </Link>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
