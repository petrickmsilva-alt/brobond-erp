import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ForgotPage } from './ForgotReset';
vi.mock('../lib/api', () => ({ api: { post: vi.fn().mockResolvedValue({ ok: true }) }, ApiError: class ApiError extends Error {} }));
describe('Recuperação de senha segura', () => {
  it('não promete envio sem SMTP e nunca encaminha usuário ao console para obter um token', async () => {
    render(<MemoryRouter><ForgotPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/e-mail/i), { target: { value: 'fixture@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /enviar link/i }));
    await waitFor(() => expect(screen.getByText(/serviço de e-mail estiver disponível/i)).toBeInTheDocument());
    expect(screen.getByText(/peça ajuda ao administrador/i)).toBeInTheDocument();
    expect(screen.queryByText(/console do servidor/i)).toBeNull();
  });
});
