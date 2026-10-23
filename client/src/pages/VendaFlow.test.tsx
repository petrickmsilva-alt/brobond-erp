import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import OrderPage from './OrderPage';
import ModulePage from './ModulePage';
import { ToastProvider } from '../components/ui';
import { api } from '../lib/api';
import { MODULES } from '../modules';

let usuarioMock: { id: number; name: string; perfil: 'admin' | 'gerente' | 'operador' } = {
  id: 1,
  name: 'Gerente Comercial',
  perfil: 'gerente',
};

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      del: vi.fn(),
    },
  };
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: usuarioMock }),
}));

const VENDA_RESOURCE_META = {
  key: 'vendas',
  label: 'Pedidos de Venda',
  singular: 'Pedido de venda',
  detail: true,
  labelFields: ['id'],
  ops: { create: true, update: true, delete: true },
  fields: [
    { name: 'cliente_id', label: 'Cliente', type: 'ref' as const, ref: 'clientes', required: true },
    { name: 'data', label: 'Data', type: 'date' as const, required: true },
    {
      name: 'status',
      label: 'Status',
      type: 'select' as const,
      required: true,
      default: 'aberta',
      options: [
        { value: 'cotacao', label: 'Cotação' },
        { value: 'aberta', label: 'Aberta' },
        { value: 'faturada', label: 'Faturada' },
        { value: 'entregue', label: 'Entregue' },
        { value: 'cancelada', label: 'Cancelada' },
      ],
    },
    { name: 'total', label: 'Total', type: 'money' as const, readonly: true },
  ],
};

vi.mock('../lib/meta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/meta')>();
  return {
    ...actual,
    useMeta: () => ({
      defaultLocal: { id: 1, nome: 'Loja Matriz' },
      resources: {
        vendas: VENDA_RESOURCE_META,
        compras: { ...VENDA_RESOURCE_META, key: 'compras', label: 'Compras', singular: 'Compra' },
      },
      modules: [],
    }),
  };
});

const apiGet = vi.mocked(api.get);
const apiPost = vi.mocked(api.post);
const apiPut = vi.mocked(api.put);
const apiDel = vi.mocked(api.del);

const CLIENTE_PF = {
  id: 11,
  pessoa: 'pf',
  nome: 'Mariana Costa Ribeiro',
  cnpj_cpf: '52998224725',
  telefone: '62991234567',
  email: 'mariana@exemplo.com.br',
  logradouro: 'Av. Independência',
  numero: '450',
  bairro: 'Centro',
  cidade: 'Aparecida de Goiânia',
  codigo_municipio: '5201405',
  uf: 'GO',
  indicador_ie: '9',
  ativo: true,
};

const CLIENTE_PJ = {
  id: 22,
  pessoa: 'pj',
  nome: 'Confecções Cerrado Ltda',
  razao_social: 'Confecções Cerrado Comércio de Vestuário Ltda',
  nome_fantasia: 'Boutique Cerrado Prime',
  cnpj_cpf: '11222333000181',
  rg_ie: '104567890',
  indicador_ie: '1',
  im: '998877',
  telefone: '6232801122',
  email: 'compras@cerradoprime.com.br',
  logradouro: 'Rua 9',
  numero: '1200',
  bairro: 'Setor Oeste',
  cidade: 'Goiânia',
  codigo_municipio: '5208707',
  uf: 'GO',
  limite_credito: 15000,
  ativo: true,
};

const PRODUTO_FAMILIA_GRADE = {
  id: 300,
  produto_pai_id: null,
  sku: 'POLO-EXEC',
  nome: 'Camisa Polo Executiva',
  codigo_barras: null,
  descricao: null,
  cor: null,
  categoria: 'Camisas',
  marca: 'BroBond',
  preco_venda: 150,
  ativo: true,
  variacao_tamanho_id: null,
  estoque_disponivel: 23,
  tamanhos: [
    { tamanho_id: 1, tamanho: 'P', quantidade: 10 },
    { tamanho_id: 2, tamanho: 'M', quantidade: 8 },
    { tamanho_id: 3, tamanho: 'G', quantidade: 5 },
    { tamanho_id: 4, tamanho: 'GG', quantidade: 0 },
  ],
  variacoes: [
    {
      id: 301,
      produto_pai_id: 300,
      sku: 'POLO-EXEC-PRT-P',
      nome: 'Camisa Polo Executiva Preta P',
      codigo_barras: '7898881000011',
      descricao: null,
      cor: 'Preta',
      categoria: 'Camisas',
      marca: 'BroBond',
      preco_venda: 150,
      ativo: true,
      variacao_tamanho_id: 1,
      estoque_disponivel: 10,
      tamanhos: [{ tamanho_id: 1, tamanho: 'P', quantidade: 10 }],
    },
    {
      id: 302,
      produto_pai_id: 300,
      sku: 'POLO-EXEC-PRT-M',
      nome: 'Camisa Polo Executiva Preta M',
      codigo_barras: '7898881000028',
      descricao: null,
      cor: 'Preta',
      categoria: 'Camisas',
      marca: 'BroBond',
      preco_venda: 150,
      ativo: true,
      variacao_tamanho_id: 2,
      estoque_disponivel: 8,
      tamanhos: [{ tamanho_id: 2, tamanho: 'M', quantidade: 8 }],
    },
    {
      id: 303,
      produto_pai_id: 300,
      sku: 'POLO-EXEC-PRT-G',
      nome: 'Camisa Polo Executiva Preta G',
      codigo_barras: '7898881000035',
      descricao: null,
      cor: 'Preta',
      categoria: 'Camisas',
      marca: 'BroBond',
      preco_venda: 160,
      ativo: true,
      variacao_tamanho_id: 3,
      estoque_disponivel: 5,
      tamanhos: [{ tamanho_id: 3, tamanho: 'G', quantidade: 5 }],
    },
    {
      id: 304,
      produto_pai_id: 300,
      sku: 'POLO-EXEC-PRT-GG',
      nome: 'Camisa Polo Executiva Preta GG',
      codigo_barras: '7898881000042',
      descricao: null,
      cor: 'Preta',
      categoria: 'Camisas',
      marca: 'BroBond',
      preco_venda: 170,
      ativo: true,
      variacao_tamanho_id: 4,
      estoque_disponivel: 0,
      tamanhos: [{ tamanho_id: 4, tamanho: 'GG', quantidade: 0 }],
    },
  ],
};

// Produto pai sem linhas de variação filhas, mas com grade P/M/G/GG (exige escolha explícita de tamanho)
const PRODUTO_SIMPLES_MULTITAMANHO = {
  id: 400,
  produto_pai_id: null,
  sku: 'CALCA-ALF',
  nome: 'Calça Alfaiataria Slim',
  codigo_barras: '7898882000010',
  descricao: null,
  cor: 'Marinho',
  categoria: 'Calças',
  marca: 'BroBond',
  preco_venda: 250,
  ativo: true,
  variacao_tamanho_id: null,
  estoque_disponivel: 9,
  tamanhos: [
    { tamanho_id: 1, tamanho: 'P', quantidade: 4 },
    { tamanho_id: 2, tamanho: 'M', quantidade: 5 },
    { tamanho_id: 4, tamanho: 'GG', quantidade: 0 },
  ],
  variacoes: [],
};

function RotaAtualProbe() {
  const loc = useLocation();
  return <div data-testid="rota-atual">{loc.pathname}</div>;
}

function renderComRotas(rotaInicial: string) {
  const moduloVendas = MODULES.find((m) => m.id === 'vendas')!;
  return render(
    <MemoryRouter initialEntries={[rotaInicial]}>
      <ToastProvider>
        <RotaAtualProbe />
        <Routes>
          <Route path="/vendas" element={<ModulePage module={moduloVendas} />} />
          <Route path="/vendas/novo" element={<OrderPage tipo="venda" modo="novo" />} />
          <Route path="/vendas/:id/editar" element={<OrderPage tipo="venda" modo="editar" />} />
          <Route path="/vendas/:id" element={<OrderPage tipo="venda" />} />
          <Route path="/clientes/novo" element={<div>Página Novo Cliente</div>} />
          <Route path="/clientes/:id/editar" element={<div>Página Editar Cliente</div>} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Nova Venda Profissional PF/CNPJ — Motor Único de Vendas', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    usuarioMock = { id: 1, name: 'Gerente Comercial', perfil: 'gerente' };

    apiGet.mockImplementation(((path: string) => {
      if (path === '/tamanhos/options') {
        return Promise.resolve([
          { value: 1, label: 'P' },
          { value: 2, label: 'M' },
          { value: 3, label: 'G' },
          { value: 4, label: 'GG' },
        ]);
      }
      if (path === '/representantes/options') {
        return Promise.resolve([{ value: 5, label: 'Carlos Vendedor' }]);
      }
      if (path === '/contas_financeiras/options') {
        return Promise.resolve([{ value: 9, label: 'Banco Itaú Principal' }]);
      }
      if (path.startsWith('/locais?')) {
        return Promise.resolve({ rows: [{ id: 1, nome: 'Loja Matriz', ativo: true }] });
      }
      if (path.startsWith('/clientes?')) {
        const u = new URL(`http://x${path}`);
        const pessoa = u.searchParams.get('f.pessoa');
        const q = (u.searchParams.get('q') || '').toLowerCase();
        const base = pessoa === 'pj' ? [CLIENTE_PJ] : [CLIENTE_PF];
        const filtrados = !q
          ? base
          : base.filter(
              (c: Record<string, unknown>) =>
                String(c.nome || '').toLowerCase().includes(q) ||
                String(c.razao_social || '').toLowerCase().includes(q) ||
                String(c.nome_fantasia || '').toLowerCase().includes(q) ||
                String(c.cnpj_cpf || '').includes(q) ||
                String(c.telefone || '').includes(q)
            );
        return Promise.resolve({ rows: filtrados, total: filtrados.length, page: 1, pageSize: 12 });
      }
      if (path.startsWith('/clientes/por-documento?')) {
        const u = new URL(`http://x${path}`);
        const doc = u.searchParams.get('documento');
        if (doc === CLIENTE_PF.cnpj_cpf) return Promise.resolve({ encontrado: true, cliente: CLIENTE_PF });
        if (doc === CLIENTE_PJ.cnpj_cpf) return Promise.resolve({ encontrado: true, cliente: CLIENTE_PJ });
        return Promise.resolve({ encontrado: false });
      }
      if (path === `/clientes/${CLIENTE_PF.id}`) return Promise.resolve(CLIENTE_PF);
      if (path === `/clientes/${CLIENTE_PJ.id}`) return Promise.resolve(CLIENTE_PJ);
      if (path.startsWith('/estoques/disponivel')) {
        // Contrato canônico: o servidor devolve o vendável no local de saída
        // (aqui 5), o local explícito e o físico total (10, em dois locais).
        return Promise.resolve({ produto_id: 300, tamanho_id: 2, quantidade: 5, local_id: 1, local: 'Loja Matriz', por_local: [{ local_id: 1, local: 'Loja Matriz', quantidade: 5 }], estoque_fisico: 10, outros_locais: 5, semantica: 'estoque_vendavel_no_local_de_saida' });
      }
      if (path.startsWith('/produtos/busca')) {
        const u = new URL(`http://x${path}`);
        const q = (u.searchParams.get('q') || '').toLowerCase();
        if (q.includes('calca') || q.includes('calça') || q.includes('7898882000010')) {
          return Promise.resolve({ rows: [PRODUTO_SIMPLES_MULTITAMANHO], total: 1, page: 1, pageSize: 20, hasMore: false });
        }
        return Promise.resolve({ rows: [PRODUTO_FAMILIA_GRADE], total: 1, page: 1, pageSize: 20, hasMore: false });
      }
      if (path.startsWith('/vendas?')) {
        return Promise.resolve({
          rows: [{ id: 42, cliente_id: 11, cliente_id__label: 'Mariana Costa Ribeiro', data: '2026-10-23', status: 'aberta', total: 300 }],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      }
      if (path === '/vendas/501' || path === '/vendas/88') {
        const idNum = path.endsWith('501') ? 501 : 88;
        return Promise.resolve({
          id: idNum,
          cliente_id: 22,
          cliente_id__label: 'Confecções Cerrado Ltda',
          data: '2026-10-23',
          status: 'aberta',
          canal_venda: 'representante',
          desconto: 50,
          frete: 30,
          total: 460,
          fin_status: 'a_receber',
          fin_forma_pagamento: 'boleto',
          fin_parcelas: 2,
          fin_vencimento: '2026-11-23',
        });
      }
      if (path === '/vendas/501/itens' || path === '/vendas/88/itens') {
        return Promise.resolve([
          {
            id: 9001,
            produto_id: 300,
            produto_id__label: 'POLO-EXEC — Camisa Polo Executiva',
            tamanho_id: 3,
            tamanho_id__label: 'G',
            quantidade: 3,
            preco_unitario: 160,
            desconto_pct: 0,
            subtotal: 480,
          },
        ]);
      }
      if (path === '/vendas/88/fiscal') {
        return Promise.resolve({
          venda_id: 88,
          emitido: false,
          documento: null,
          documentos: [],
          configuracao: { habilitado: true, provider: 'homologacao', ambiente: 'homologacao' },
        });
      }
      if (path.startsWith('/vendas/88/fiscal/previa')) {
        return Promise.resolve({
          pendencias: [],
          pode_emitir: true,
          provider: 'homologacao',
          ambiente: 'homologacao',
        });
      }
      if (path.startsWith('/lancamentos_financeiros?')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    }) as never);

    apiPost.mockResolvedValue({ id: 501, status: 'aberta' });
    apiPut.mockResolvedValue({ id: 501, status: 'faturada' });
    apiDel.mockResolvedValue({ ok: true });
  });

  it('em /vendas (listagem), clicar em Novo ou Editar navega para página própria sem abrir modal', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas');

    const botoesNovo = await screen.findAllByRole('button', { name: /Novo pedido de venda/i });
    await user.click(botoesNovo[0]);

    expect(screen.getByTestId('rota-atual')).toHaveTextContent('/vendas/novo');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Nova venda/i })).toBeInTheDocument();
  });

  it('em /vendas (listagem), clicar em Editar na linha abre /vendas/:id/editar sem modal', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas');

    const botaoEditar = await screen.findByRole('button', { name: /Editar/i });
    await user.click(botaoEditar);

    await waitFor(() => expect(screen.getByTestId('rota-atual')).toHaveTextContent('/vendas/42/editar'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('PF: busca por CPF com máscara normalizando dígitos, valida CPF inválido, exibe dados PF e cria venda com R$ 1.500,00 e dd/mm/aaaa', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas/novo');

    // Modo PF ativo por padrão
    const radioPf = screen.getByRole('radio', { name: /Pessoa Física/i });
    expect(radioPf).toHaveAttribute('aria-checked', 'true');

    const buscaCliente = screen.getByRole('combobox', { name: /Buscar cliente Pessoa Física/i });

    // CPF inválido exibe alerta imediato
    await user.type(buscaCliente, '111.111.111-11');
    expect(await screen.findByText(/CPF inválido/i)).toBeInTheDocument();

    // Limpa e busca por CPF mascarado válido -> backend recebe apenas dígitos (52998224725)
    await user.clear(buscaCliente);
    await user.type(buscaCliente, '529.982.247-25');

    await waitFor(() =>
      expect(apiGet.mock.calls.some(([p]) => String(p).includes('/clientes?') && String(p).includes('q=52998224725'))).toBe(true)
    );

    const opcaoPf = await screen.findByRole('option', { name: /Mariana Costa Ribeiro/i });
    await user.click(opcaoPf);

    // Exibe dados PF selecionados (nome completo, CPF formatado, telefone e e-mail)
    expect(screen.getByText('Mariana Costa Ribeiro')).toBeInTheDocument();
    expect(screen.getByText('529.982.247-25')).toBeInTheDocument();
    expect(screen.getByText('mariana@exemplo.com.br')).toBeInTheDocument();

    // Adiciona 12 peças tamanho M (12 * 150 = R$ 1.800,00)
    const campoProd = screen.getByRole('combobox', { name: 'Buscar produto da venda' });
    fireEvent.change(campoProd, { target: { value: 'Polo' } });
    await user.click(await screen.findByRole('option', { name: /POLO-EXEC-PRT-M/ }));

    const inputQtd = screen.getByLabelText(/^Qtd\./i);
    await user.clear(inputQtd);
    await user.type(inputQtd, '12');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    // Aplica Desconto R$ 1.500,00, Frete R$ 85,50 e Data 25/10/2026
    const campoDesconto = screen.getByLabelText(/Desconto comercial/i);
    fireEvent.change(campoDesconto, { target: { value: '1500,00' } });
    fireEvent.blur(campoDesconto);
    expect(campoDesconto).toHaveValue('R$ 1.500,00');

    const campoFrete = screen.getByLabelText(/Frete \(R\$\)/i);
    fireEvent.change(campoFrete, { target: { value: '85,50' } });
    fireEvent.blur(campoFrete);
    expect(campoFrete).toHaveValue('R$ 85,50');

    const campoData = screen.getByLabelText(/^Data da venda/i);
    await user.clear(campoData);
    await user.type(campoData, '25102026');
    expect(campoData).toHaveValue('25/10/2026');

    // Salva pedido -> envia valores numéricos normalizados e data ISO YYYY-MM-DD
    await user.click(screen.getAllByRole('button', { name: 'Salvar pedido' })[0]);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/vendas',
        expect.objectContaining({
          cliente_id: 11,
          data: '2026-10-25',
          desconto: 1500,
          frete: 85.5,
          status: 'aberta',
        })
      )
    );
    expect(apiPost).toHaveBeenCalledWith('/vendas/501/itens', {
      produto_id: 300,
      tamanho_id: 2,
      quantidade: 12,
      preco_unitario: 150,
      desconto_pct: 0,
    });
    await waitFor(() => expect(screen.getByTestId('rota-atual')).toHaveTextContent('/vendas/501'));
  });

  it('PJ + Anti-duplicidade: detecta CNPJ digitado no modo PF, alterna para PJ sem duplicar, exibe IE/Fantasia e finaliza em 3 parcelas', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas/novo');

    // Digitar CNPJ válido enquanto está em modo PF aciona aviso anti-duplicação
    const buscaPf = screen.getByRole('combobox', { name: /Buscar cliente Pessoa Física/i });
    await user.type(buscaPf, '11.222.333/0001-81');

    const botaoAlternar = await screen.findByRole('button', {
      name: /Alternar modalidade e selecionar este cliente/i,
    });
    await user.click(botaoAlternar);

    // O motor único muda automaticamente para PJ e exibe Razão Social, Fantasia, CNPJ e IE
    expect(screen.getByRole('radio', { name: /Pessoa Jurídica/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Confecções Cerrado Comércio de Vestuário Ltda')).toBeInTheDocument();
    expect(screen.getByText('Boutique Cerrado Prime')).toBeInTheDocument();
    expect(screen.getByText('11.222.333/0001-81')).toBeInTheDocument();
    expect(screen.getByText('104567890')).toBeInTheDocument();

    // Seleciona produto por leitura rápida de código de barras (EAN + Enter) -> variação G (R$ 160)
    const campoProd = screen.getByRole('combobox', { name: 'Buscar produto da venda' });
    fireEvent.change(campoProd, { target: { value: '7898881000035' } });
    fireEvent.keyDown(campoProd, { key: 'Enter' });

    await screen.findByDisplayValue('160');
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    // Configura financeiro: Boleto, 3 parcelas, vencimento 25/11/2026
    await user.selectOptions(screen.getByLabelText(/Forma de pagamento/i), 'boleto');
    const campoParcelas = screen.getByLabelText(/Nº de parcelas/i);
    await user.clear(campoParcelas);
    await user.type(campoParcelas, '3');
    const campoVenc = screen.getByLabelText(/1º Vencimento/i);
    await user.type(campoVenc, '25112026');
    expect(campoVenc).toHaveValue('25/11/2026');

    // Finaliza a venda: cria cabeçalho -> grava item -> transiciona status para faturada
    await user.click(screen.getAllByRole('button', { name: 'Finalizar venda' })[0]);

    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        '/vendas',
        expect.objectContaining({
          cliente_id: 22,
          fin_forma_pagamento: 'boleto',
          fin_parcelas: 3,
          fin_vencimento: '2026-11-25',
          status: 'aberta',
        })
      )
    );
    expect(apiPost).toHaveBeenCalledWith('/vendas/501/itens', {
      produto_id: 300,
      tamanho_id: 3,
      quantidade: 1,
      preco_unitario: 160,
      desconto_pct: 0,
    });
    expect(apiPut).toHaveBeenCalledWith('/vendas/501', { status: 'faturada' });
  });

  it('Produtos: exige seleção explícita de tamanho em pai multitamanho (P/M/GG) e bloqueia tamanho GG sem saldo', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas/novo');

    const campoProd = screen.getByRole('combobox', { name: 'Buscar produto da venda' });
    fireEvent.change(campoProd, { target: { value: 'Calça Alfaiataria' } });

    // Aguarda o debounce de busca retornar as opções
    const btnGG = await screen.findByRole('option', { name: /Tamanho GG: 0 disponível/i });
    expect(btnGG).toBeDisabled();

    const listbox = screen.getByRole('listbox', { name: 'Resultados de produtos' });

    // Clicar no pai ambíguo NÃO seleciona o pai: orienta a escolher o tamanho explícito
    const opcaoPai = within(listbox).getByRole('option', { name: /CALCA-ALF — Calça Alfaiataria Slim/i });
    await user.click(opcaoPai);
    expect(await screen.findByText(/Escolha o tamanho de Calça Alfaiataria Slim para continuar/i)).toBeInTheDocument();

    // Escolher explicitamente o tamanho M habilita a inclusão com estoque 5 un.
    const btnM = within(listbox).getByRole('option', { name: /Tamanho M: 5 disponível/i });
    await user.click(btnM);

    await screen.findByDisplayValue('250');
    // O número exibido vem de `/estoques/disponivel` (mesma regra do faturamento)
    // e o local é explícito: nunca "10" somando locais, nunca um saldo anônimo.
    expect(await screen.findByText(/Estoque disponível em Loja Matriz: 5 un\./i)).toBeInTheDocument();
    expect(screen.getByText(/físico total: 10 un\. em todos os locais/i)).toBeInTheDocument();
  });

  it('Acessibilidade por teclado: alterna PF/PJ por setas, navega cliente com ArrowDown/Enter/Escape e foca resumo de erros', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas/novo');

    // Tentar salvar sem cliente exibe resumo de erro acessível e marca aria-invalid
    await user.click(screen.getAllByRole('button', { name: 'Salvar pedido' })[0]);
    expect((await screen.findAllByText(/Selecione um cliente Pessoa Física/i)).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('combobox', { name: /Buscar cliente Pessoa Física/i })).toHaveAttribute('aria-invalid', 'true');

    // Setas no radiogroup alternam PF -> PJ com foco no rádio PJ
    const radioPf = screen.getByRole('radio', { name: /Pessoa Física/i });
    radioPf.focus();
    await user.keyboard('{ArrowRight}');
    const radioPj = screen.getByRole('radio', { name: /Pessoa Jurídica/i });
    expect(radioPj).toHaveAttribute('aria-checked', 'true');
    expect(radioPj).toHaveFocus();

    // Combobox de cliente PJ responde a Escape e Enter pelo teclado
    const buscaPj = screen.getByRole('combobox', { name: /Buscar cliente Pessoa Jurídica/i });
    await user.click(buscaPj);
    await screen.findByRole('option', { name: /Confecções Cerrado/i });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.keyboard('{ArrowDown}');
    await screen.findByRole('option', { name: /Confecções Cerrado/i });
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Confecções Cerrado Comércio de Vestuário Ltda')).toBeInTheDocument();
  });

  it('Erro de servidor sem perda de dados nem duplicação: se faturar falhar (409), preserva dados e na nova tentativa atualiza a venda já criada', async () => {
    const user = userEvent.setup();
    apiPut
      .mockRejectedValueOnce(new Error('Saldo insuficiente no local Loja Matriz.'))
      .mockResolvedValue({ id: 501, status: 'faturada' });

    renderComRotas('/vendas/novo');

    // Seleciona cliente PF
    const buscaPf = screen.getByRole('combobox', { name: /Buscar cliente Pessoa Física/i });
    await user.click(buscaPf);
    await user.click(await screen.findByRole('option', { name: /Mariana Costa Ribeiro/i }));

    // Preenche observação importante que não pode ser perdida
    const obs = screen.getByLabelText(/Observações do pedido/i);
    await user.type(obs, 'Entregar com embalagem presenteável');

    // Adiciona item
    const campoProd = screen.getByRole('combobox', { name: 'Buscar produto da venda' });
    fireEvent.change(campoProd, { target: { value: 'Polo' } });
    await user.click(await screen.findByRole('option', { name: /POLO-EXEC-PRT-P/ }));
    await user.click(screen.getByRole('button', { name: 'Adicionar item' }));

    // 1ª tentativa de finalizar falha no PUT faturada com 409
    await user.click(screen.getAllByRole('button', { name: 'Finalizar venda' })[0]);

    expect((await screen.findAllByText(/Saldo insuficiente no local Loja Matriz/i)).length).toBeGreaterThanOrEqual(1);
    // Dados digitados e itens permanecem intactos!
    expect(obs).toHaveValue('Entregar com embalagem presenteável');
    expect(screen.getByText('Mariana Costa Ribeiro')).toBeInTheDocument();

    const chamadasPostVendasAntes = apiPost.mock.calls.filter(([p]) => p === '/vendas').length;
    expect(chamadasPostVendasAntes).toBe(1);

    // 2ª tentativa NÃO chama POST /vendas de novo (usa PUT /vendas/501) e conclui o faturamento!
    await user.click(screen.getAllByRole('button', { name: 'Finalizar venda' })[0]);

    await waitFor(() => expect(screen.getByTestId('rota-atual')).toHaveTextContent('/vendas/501'));
    const chamadasPostVendasDepois = apiPost.mock.calls.filter(([p]) => p === '/vendas').length;
    expect(chamadasPostVendasDepois).toBe(1);
  });

  it('Permissões: perfil operador cria venda sem consultar endpoints gerenciais restritos (/contas_financeiras)', async () => {
    usuarioMock = { id: 3, name: 'Operador Balcão', perfil: 'operador' };
    const user = userEvent.setup();
    renderComRotas('/vendas/novo');

    const buscaPf = screen.getByRole('combobox', { name: /Buscar cliente Pessoa Física/i });
    await user.click(buscaPf);
    await user.click(await screen.findByRole('option', { name: /Mariana Costa Ribeiro/i }));

    expect(apiGet.mock.calls.some(([p]) => String(p).includes('/contas_financeiras'))).toBe(false);
    expect(apiGet.mock.calls.some(([p]) => String(p).includes('/lancamentos_financeiros'))).toBe(false);
    expect(screen.getByLabelText(/Conta financeira/i)).toBeDisabled();
  });

  it('Edição, Cancelamento e Fiscal em /vendas/88/editar: consulta prévia fiscal e cancela com confirmação', async () => {
    const user = userEvent.setup();
    renderComRotas('/vendas/88/editar');

    expect(await screen.findByRole('heading', { name: /Editar pedido de venda #88/i })).toBeInTheDocument();

    // Consulta prévia fiscal NF-e 55
    await user.click(screen.getByRole('button', { name: /Verificar pendências fiscais/i }));
    expect(await screen.findByText(/Nenhuma pendência cadastral ou tributária/i)).toBeInTheDocument();

    // Cancela o pedido com diálogo de confirmação
    apiPut.mockResolvedValueOnce({ id: 88, status: 'cancelada' });
    await user.click(screen.getByRole('button', { name: /Cancelar pedido/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /Confirmar cancelamento/i }));

    await waitFor(() => expect(apiPut).toHaveBeenCalledWith('/vendas/88', { status: 'cancelada' }));
  });
});
