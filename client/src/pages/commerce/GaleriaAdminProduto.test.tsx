// ============================================================================
// COMMERCE — galeria administrativa de /commerce/produtos/:id.
// Contrato: ZERO MODAL, ordem 1..n persistida, principal sem duplicar arquivo,
// ATIVA/INATIVA sem apagar, alt_text em arquivos.alt_text, vínculo variante_id,
// exclusão SOMENTE com confirmação inline.
// ============================================================================
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import GaleriaAdminProduto from './GaleriaAdminProduto';

vi.mock('../../lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));
vi.mock('../../lib/images', () => ({
  prepareImage: vi.fn(async () => ({ nome: 'foto.jpg', mime: 'image/jpeg', dados: 'data:image/jpeg;base64,AAA', thumb: 'data:image/jpeg;base64,AAA', bytes: 3 })),
}));

import { apiFetch } from '../../lib/api';
import { prepareImage } from '../../lib/images';
const fetchMock = vi.mocked(apiFetch);
const prepararMock = vi.mocked(prepareImage);

const FOTO_A = {
  id: 11, nome: 'a.jpg', url: '/api/files/11/token-a', thumb_url: '/api/files/11/token-a?thumb=1',
  principal: true, ordem: 0, alt_text: 'Frente da camiseta', ativo: true, variante_id: null,
};
const FOTO_B = {
  id: 12, nome: 'b.jpg', url: '/api/files/12/token-b', thumb_url: '/api/files/12/token-b?thumb=1',
  principal: false, ordem: 1, alt_text: null, ativo: false, variante_id: 4,
};
const OPCOES = [{ value: 4, label: 'G' }, { value: 5, label: 'GG' }];

function renderGaleria(canEdit = true) {
  return render(
    <ToastProvider>
      <GaleriaAdminProduto produtoId={17} canEdit={canEdit} />
    </ToastProvider>
  );
}

describe('Galeria administrativa do produto (/commerce/produtos/17)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    prepararMock.mockClear();
    fetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = String(init?.method || 'GET').toUpperCase();
      if (method === 'GET' && String(path) === '/tamanhos/options') return OPCOES;
      if (method === 'GET') return [FOTO_A, FOTO_B];
      if (method === 'PUT') return [FOTO_A, FOTO_B];
      if (method === 'DELETE') return { ok: true };
      return { ...FOTO_A, id: 13, principal: false, ordem: 2 };
    });
  });

  it('lista as fotos com posição 1..n, ATIVA/INATIVA e ZERO MODAL', async () => {
    renderGaleria();
    expect(await screen.findByText('Posição 1')).toBeInTheDocument();
    expect(screen.getByText('Posição 2')).toBeInTheDocument();
    expect(screen.getByText('ATIVA')).toBeInTheDocument();
    expect(screen.getByText('INATIVA')).toBeInTheDocument();
    expect(screen.getByText('Imagem principal')).toBeInTheDocument();
    expect(screen.getByText('Variação: G')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
    expect(fetchMock.mock.calls.some(([p]) => String(p) === '/produtos/17/arquivos')).toBe(true);
  });

  it('define imagem principal via PUT (sem duplicar arquivo) e persiste ordem 1..n', async () => {
    const user = userEvent.setup();
    renderGaleria();
    await screen.findByText('Posição 1');
    await user.click(screen.getByRole('button', { name: /Principal/ }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p) === '/produtos/17/arquivos/12' && o?.method === 'PUT'
        && JSON.parse(String(o.body)).principal === true)).toBe(true);
    });
    // Nenhum POST de upload: principal troca metadado, nunca cria novo arquivo.
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Descer imagem 1' }));
    await waitFor(() => {
      const ordem = fetchMock.mock.calls.find(([, o]) => o?.method === 'PUT' && Array.isArray(JSON.parse(String(o.body)).ordem));
      expect(ordem).toBeTruthy();
      expect(JSON.parse(String(ordem![1]!.body)).ordem).toEqual([12, 11]);
    });
  });

  it('ATIVA/INATIVA é um PUT de metadado — exclusão nunca é automática', async () => {
    const user = userEvent.setup();
    renderGaleria();
    await screen.findByText('Posição 1');
    await user.click(screen.getByRole('button', { name: 'Desativar' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p) === '/produtos/17/arquivos/11' && o?.method === 'PUT'
        && JSON.parse(String(o.body)).ativo === false)).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
  });

  it('salva Texto alternativo e vínculo produto → variação → imagem', async () => {
    const user = userEvent.setup();
    renderGaleria();
    await screen.findByText('Posição 1');
    const alt = screen.getByRole('textbox', { name: 'Texto alternativo da imagem 2' });
    await user.clear(alt);
    await user.type(alt, 'Costas da camiseta');
    const salvarTexto = screen.getAllByRole('button', { name: /Salvar/ })[2];
    await user.click(salvarTexto);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p) === '/produtos/17/arquivos/12' && o?.method === 'PUT'
        && JSON.parse(String(o.body)).alt_text === 'Costas da camiseta')).toBe(true);
    });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Variação da imagem 1' }), '5');
    await user.click(screen.getAllByRole('button', { name: /Salvar/ })[1]);
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p) === '/produtos/17/arquivos/11' && o?.method === 'PUT'
        && JSON.parse(String(o.body)).variante_id === 5)).toBe(true);
    });
  });

  it('exclusão exige confirmação INLINE explícita (nenhum DELETE antes dela)', async () => {
    const user = userEvent.setup();
    renderGaleria();
    await screen.findByText('Posição 1');
    await user.click(screen.getAllByRole('button', { name: /Excluir/ })[0]);
    expect(screen.getByText('Excluir imagem da galeria')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);

    await user.click(screen.getAllByRole('button', { name: /Excluir/ })[0]);
    await user.click(screen.getByRole('button', { name: 'Excluir imagem' }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([p, o]) => String(p) === '/produtos/17/arquivos/11' && o?.method === 'DELETE')).toBe(true);
    });
  });

  it('upload usa a infraestrutura existente com validação e metadados (sem caminho interno)', async () => {
    const user = userEvent.setup();
    renderGaleria();
    await screen.findByText('Posição 1');
    await user.type(screen.getByRole('textbox', { name: 'Texto alternativo das novas imagens' }), 'Nova foto');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Variação das novas imagens' }), '4');
    const arquivo = new File(['abc'], 'foto.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('Selecionar imagens da galeria'), arquivo);
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([p, o]) => String(p) === '/produtos/17/arquivos' && o?.method === 'POST');
      expect(post).toBeTruthy();
      const corpo = JSON.parse(String(post![1]!.body));
      expect(corpo.alt_text).toBe('Nova foto');
      expect(corpo.variante_id).toBe(4);
      expect(corpo.ativo).toBe(true);
      expect(prepararMock).toHaveBeenCalledWith(arquivo);
      expect(JSON.stringify(corpo)).not.toMatch(/\/home\/|\/tmp\/|token|storage/i);
    });
  });

  it('somente leitura não mostra ações de escrita', async () => {
    renderGaleria(false);
    expect(await screen.findByText('Posição 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Excluir/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Adicionar imagens/ })).toBeNull();
  });
});
