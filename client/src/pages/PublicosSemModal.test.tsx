import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { ToastProvider } from '../components/ui';
import CatalogoPublico from './CatalogoPublico';
import PortalCliente from './PortalCliente';
import { api, apiFetch } from '../lib/api';

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(),
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

const produto = {
  id: 7, sku: 'SKU-7', nome: 'Camiseta', cor: null, cor_hex: null, composicao: null,
  descricao: 'Descrição completa', preco: 20, preco_tipo: 'varejo', preco_venda: 20,
  preco_atacado: null, disponivel_site: true, foto_url: null, fotos: [],
  tamanhos: [{ tamanho_id: 3, codigo: 'M', quantidade: 5 }], medidas: null,
};
const catalogo = {
  nome: 'Catálogo teste', canal: 'varejo', tabela_preco: '', aceita_pedido_site: true,
  como_comprar: null, mostrar_preco: true, mostrar_saldo: true, mostrar_medidas: false,
  politica_comercial: null, total: 1, produtos: [produto],
};
const pedido = {
  id: 11, data: '2026-10-29', status: 'aberta', status_label: 'Aberta', total: 40,
  previsao_entrega: null, condicao_pagamento: null, frete: 0, desconto: 0, observacoes: null,
  pode_decidir: true, documentos: [], decisoes: [],
  itens: [{ produto: 'Camiseta', sku: 'SKU-7', tamanho: 'M', quantidade: 2, preco_unitario: 20, subtotal: 40, foto: null }],
};
const lista = { cliente: { nome: 'Ana', email: null }, acesso_seguro: true, pedidos: [pedido] };

function NavegacaoTeste() {
  const location = useLocation();
  const navigate = useNavigate();
  return <>
    <output data-testid="rota">{location.pathname}{location.hash}</output>
    <button onClick={() => navigate(-1)}>Histórico anterior</button>
    <button onClick={() => navigate('/catalogo/outro')}>Outro catálogo</button>
    <button onClick={() => navigate('/portal/outro')}>Outro portal</button>
  </>;
}
function montar(path: string) {
  return render(<ToastProvider><MemoryRouter initialEntries={[path]}>
    <NavegacaoTeste />
    <Routes><Route path="/catalogo/:token/*" element={<CatalogoPublico />} /><Route path="/portal/:token/*" element={<PortalCliente />} /></Routes>
  </MemoryRouter></ToastProvider>);
}
function semSobreposicao(container: HTMLElement) {
  expect(container.querySelector('[role="dialog"], [aria-modal="true"]')).toBeNull();
  expect(container.querySelector('[class*="fixed inset-0"], [class*="fixed inset-x-0"]')).toBeNull();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(apiFetch).mockResolvedValue(catalogo);
  vi.mocked(api.get).mockImplementation(async (path: string) => path.endsWith('/pedidos') ? lista : pedido);
  vi.mocked(api.post).mockResolvedValue({ portal_url: '/portal/solicitacao', mensagem: 'Cotação solicitada.' });
});

describe('Catálogo público — rotas sem sobreposição', () => {
  it('abre detalhe, monta pedido e apresenta resultado na página, preservando o carrinho', async () => {
    const user = userEvent.setup(); const { container } = montar('/catalogo/abc');
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes de Camiseta' }));
    expect(screen.getByTestId('rota')).toHaveTextContent('/catalogo/abc/produto/7');
    expect(screen.getByText('Descrição completa')).toBeInTheDocument(); semSobreposicao(container);
    await user.click(screen.getByRole('button', { name: /Adicionar ao pedido/ }));
    await user.click(screen.getByRole('button', { name: /Montar pedido/ }));
    expect(screen.getByTestId('rota')).toHaveTextContent('/catalogo/abc/pedido');
    expect(screen.getByText(/Tamanho M · Varejo/)).toBeInTheDocument(); semSobreposicao(container);
    await user.type(screen.getByRole('textbox', { name: 'Seu nome' }), 'Ana');
    await user.click(screen.getByRole('button', { name: /Enviar pedido/ }));
    expect(await screen.findByText('Pedido enviado!')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/publico/catalogo/abc/pedido', expect.objectContaining({ nome: 'Ana', itens: [expect.objectContaining({ produto_id: 7, tamanho_id: 3, quantidade: 1 })] }));
    expect(screen.getByRole('link', { name: /Acompanhar no portal/ })).toHaveAttribute('href', '/portal/solicitacao');
    semSobreposicao(container);
  });

  it('abre URL de produto diretamente e preserva links legados por hash', async () => {
    const { container } = montar('/catalogo/abc#p-7');
    await waitFor(() => expect(screen.getByTestId('rota')).toHaveTextContent('/catalogo/abc/produto/7'));
    expect(await screen.findByText('Descrição completa')).toBeInTheDocument();
    semSobreposicao(container);
  });

  it('carrega diretamente a rota compartilhável de um produto', async () => {
    const { container } = montar('/catalogo/abc/produto/7');
    expect(await screen.findByText('Descrição completa')).toBeInTheDocument();
    expect(screen.getByTestId('rota')).toHaveTextContent('/catalogo/abc/produto/7');
    semSobreposicao(container);
  });

  it('descarta a resposta atrasada de catálogo de outro token', async () => {
    let terminar!: (value: unknown) => void;
    const pendente = new Promise((resolve) => { terminar = resolve; });
    vi.mocked(apiFetch).mockImplementation(async (path: string) => path.includes('/outro')
      ? { ...catalogo, nome: 'Outro catálogo', produtos: [], total: 0 }
      : pendente);
    const user = userEvent.setup(); montar('/catalogo/abc');
    await user.click(screen.getByRole('button', { name: 'Outro catálogo' }));
    expect(await screen.findByRole('heading', { name: 'Outro catálogo' })).toBeInTheDocument();
    await act(async () => terminar(catalogo));
    expect(screen.queryByText('Descrição completa')).toBeNull();
    expect(screen.getByText('Este catálogo ainda não tem produtos.')).toBeInTheDocument();
  });

  it('histórico volta ao catálogo e mantém o rascunho durante a navegação', async () => {
    const user = userEvent.setup(); montar('/catalogo/abc');
    await user.click(await screen.findByRole('button', { name: 'Ver detalhes de Camiseta' }));
    await user.click(screen.getByRole('button', { name: /Adicionar ao pedido/ }));
    await user.click(screen.getByRole('button', { name: 'Histórico anterior' }));
    expect(screen.getByTestId('rota')).toHaveTextContent('/catalogo/abc');
    expect(await screen.findByText('1 produto(s)')).toBeInTheDocument();
  });

  it('não habilita envio por rota direta quando o catálogo não aceita pedidos', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ...catalogo, aceita_pedido_site: false });
    const { container } = montar('/catalogo/abc/pedido');
    expect(await screen.findByText('Pedidos não estão disponíveis neste catálogo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Enviar pedido/ })).toBeNull();
    semSobreposicao(container);
  });

  it('trocar token não mantém produtos ou carrinho do catálogo anterior', async () => {
    vi.mocked(apiFetch).mockImplementation(async (path: string) => path.includes('/outro')
      ? { ...catalogo, nome: 'Outro catálogo', produtos: [], total: 0 }
      : catalogo);
    const user = userEvent.setup(); montar('/catalogo/abc');
    await user.click(await screen.findByRole('button', { name: /Ver detalhes de Camiseta/ }));
    await user.click(screen.getByRole('button', { name: /Adicionar ao pedido/ }));
    await user.click(screen.getByRole('button', { name: 'Outro catálogo' }));
    expect(await screen.findByRole('heading', { name: 'Outro catálogo' })).toBeInTheDocument();
    expect(screen.queryByText('Descrição completa')).toBeNull();
    expect(screen.queryByText('1 produto(s)')).toBeNull();
  });
});

describe('Portal do cliente — rotas e confirmações inline', () => {
  it('lista → detalhe por URL → confirmação da decisão sem diálogo nem chamada antecipada', async () => {
    const user = userEvent.setup(); const { container } = montar('/portal/abc');
    await user.click(await screen.findByRole('link', { name: /Pedido #11/ }));
    expect(await screen.findByText('Camiseta')).toBeInTheDocument();
    expect(screen.getByTestId('rota')).toHaveTextContent('/portal/abc/pedido/11');
    semSobreposicao(container);
    await user.type(screen.getByRole('textbox', { name: /Nome do responsável/ }), 'Ana');
    await user.click(screen.getByRole('button', { name: 'Aceitar proposta' }));
    expect(screen.getByText(/Confirmar a decisão: aceitar/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/portal/abc/pedido/11/decisao', { decisao: 'aceitar', responsavel: 'Ana', mensagem: '' }));
    expect(await screen.findByText('Decisão registrada.')).toBeInTheDocument();
    expect(screen.getByTestId('rota')).toHaveTextContent('/portal/abc'); semSobreposicao(container);
  });

  it('abre detalhe diretamente e recompra somente após confirmação explícita', async () => {
    const user = userEvent.setup(); const { container } = montar('/portal/abc/pedido/11');
    await screen.findByText('Camiseta');
    await user.click(screen.getByRole('button', { name: /Repetir este pedido/ }));
    expect(screen.getByText(/Criar uma nova cotação/)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled(); semSobreposicao(container);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText(/Criar uma nova cotação/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /Repetir este pedido/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(await screen.findByText('Cotação solicitada.')).toBeInTheDocument();
    expect(api.post).toHaveBeenCalledWith('/portal/abc/pedido/11/recomprar', {});
  });

  it('troca de token descarta o detalhe anterior mesmo com resposta atrasada', async () => {
    let terminar!: (value: unknown) => void;
    const pendente = new Promise((resolve) => { terminar = resolve; });
    vi.mocked(api.get).mockImplementation(async (path: string) => {
      if (path === '/portal/abc/pedido/11') return pendente;
      if (path === '/portal/outro/pedidos') return { ...lista, cliente: { nome: 'Bruna', email: null }, pedidos: [] };
      return lista;
    });
    const user = userEvent.setup(); montar('/portal/abc/pedido/11');
    await screen.findByText('Olá, Ana');
    await user.click(screen.getByRole('button', { name: 'Outro portal' }));
    expect(await screen.findByText('Olá, Bruna')).toBeInTheDocument();
    await act(async () => terminar(pedido));
    expect(screen.queryByText('Camiseta')).toBeNull();
    expect(screen.getByText('Nenhum pedido encontrado.')).toBeInTheDocument();
  });
});
