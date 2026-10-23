import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ImpressaoPage from './ImpressaoPage';
import { ToastProvider } from '../components/ui';

const mockUser = {
  id: 1,
  name: 'Admin Impressão',
  email: 'admin@brobond.test',
  perfil: 'admin' as const,
};

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    meta: null,
    loading: false,
    logout: vi.fn(),
    refreshMeta: vi.fn(),
  }),
}));

describe('ImpressaoPage — Central de Impressão Operacional (P5)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('127.0.0.1:17831')) {
        return new Response(
          JSON.stringify({
            ok: true,
            version: '0.2.0',
            pareado: true,
            machine_id: 'mach-local-01',
            printers: ['Zebra_ZD220', 'Elgin_i9'],
            protocols: ['text', 'escpos', 'zpl', 'epl2'],
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/print/resumo')) {
        return new Response(
          JSON.stringify({
            fila: { queued: 2, claimed: 1, printing: 0, failed: 1, cancelled: 0, printed_24h: 18, reprints_24h: 2, orphan_leases: 0 },
            agentes: { total: 2, ativos: 2, online: 1, revogados: 0 },
            terminais_ativos: 1,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/print/terminals')) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                id: 1,
                codigo: 'CAIXA-01',
                nome: 'Caixa Balcão 01',
                agent_id: 1,
                agent_nome: 'PC Caixa 01',
                agent_machine_id: 'mach-01',
                agent_online: true,
                agent_printers: ['Elgin_i9'],
                default_printer: 'Elgin_i9',
                receipt_printer: 'Elgin_i9',
                receipt_protocol: 'escpos',
                receipt_width_cols: 48,
                label_printer: 'Zebra_ZD220',
                label_protocol: 'zpl',
                document_printer: null,
                document_protocol: 'pdf',
                fallback_mode: 'browser_pdf',
                auto_print_pdv: true,
                allow_operator_reprint: true,
                copies_recibo: 1,
                copies_documento: 1,
                ativo: true,
              },
            ],
            total: 1,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/print/impressoras-detectadas')) {
        return new Response(JSON.stringify({ agentes: [], impressoras: ['Zebra_ZD220', 'Elgin_i9'] }), { status: 200 });
      }
      if (url.includes('/api/print/jobs')) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                public_id: 'a1b2c3d4-0000-4000-8000-000000000001',
                doc_type: 'recibo_pdv',
                source: 'pdv',
                source_ref: 'venda:99',
                terminal: 'CAIXA-01',
                printer_name: 'Elgin_i9',
                printer_protocol: 'escpos',
                copies: 1,
                status: 'PRINTED',
                attempts: 1,
                max_attempts: 3,
                requested_by_nome: 'Operador 1',
                agent_nome: 'PC Caixa 01',
                criado_em: '2026-10-23T12:00:00.000Z',
              },
            ],
            total: 1,
            page: 1,
            pageSize: 25,
          }),
          { status: 200 }
        );
      }
      if (url.includes('/api/print/agents')) {
        return new Response(
          JSON.stringify({
            rows: [
              {
                id: 1,
                machine_id: 'mach-01-abcdef123456',
                nome: 'PC Caixa 01',
                terminal: 'CAIXA-01',
                token_prefix: 'bpa_1234',
                status: 'ativo',
                online: true,
                agent_version: '0.2.0',
                platform: 'win32',
                printers: ['Elgin_i9', 'Zebra_ZD220'],
                last_heartbeat_at: '2026-10-23T12:01:00.000Z',
                last_ip: '127.0.0.1',
                criado_em: '2026-10-23T10:00:00.000Z',
                revoked_at: null,
              },
            ],
            total: 1,
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ rows: [], total: 0 }), { status: 200 });
    });
  });

  it('exibe KPIs da fila, lista jobs e navega entre Terminais e Agentes sem expor segredos', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ToastProvider>
          <ImpressaoPage />
        </ToastProvider>
      </MemoryRouter>
    );

    expect(screen.getByText('Central de Impressão Operacional')).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('venda:99')).toBeInTheDocument();
      expect(screen.getByText('18')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Terminais & Impressoras/i }));
    await waitFor(() => {
      expect(screen.getByText('Caixa Balcão 01')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Agentes Locais/i }));
    await waitFor(() => {
      expect(screen.getByText('PC Caixa 01')).toBeInTheDocument();
      expect(screen.getByText(/Prefixo bpa_1234\*\*\*/)).toBeInTheDocument();
    });
  });
});
