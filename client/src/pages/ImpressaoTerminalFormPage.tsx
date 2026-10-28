// ============================================================================
// IMPRESSÃO — cadastro/edição de TERMINAL em PÁGINA PRÓPRIA
// ----------------------------------------------------------------------------
// ZERO MODAL / ZERO PAINEL TRANSACIONAL: configurar um terminal de impressão é
// cadastro de módulo (impressoras, protocolos, contingência, permissões), não
// bloco auxiliar. Por isso vive em rota:
//   • `/config/impressao/terminais/novo`
//   • `/config/impressao/terminais/:id/editar`
//
// O servidor continua sendo o dono da configuração (`/print/terminals`); esta
// tela só envia o payload. Nenhum número de estoque/financeiro passa por aqui.
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Printer, Save } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  atualizarTerminalImpressao,
  criarTerminalImpressao,
  listarAgentesImpressao,
  listarImpressorasDetectadas,
  listarTerminaisImpressao,
  type AgenteRemotoCliente,
  type TerminalConfigCliente,
} from '../lib/printAgent';
import { Alert, PageHeader, Spinner, useToast } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

const TERMINAL_VAZIO: Partial<TerminalConfigCliente> = {
  codigo: '',
  nome: '',
  agent_id: null,
  default_printer: '',
  receipt_printer: '',
  receipt_protocol: 'escpos',
  receipt_width_cols: 48,
  label_printer: '',
  label_protocol: 'zpl',
  document_printer: '',
  document_protocol: 'pdf',
  fallback_mode: 'browser_pdf',
  auto_print_pdv: true,
  allow_operator_reprint: true,
  copies_recibo: 1,
  copies_documento: 1,
  ativo: true,
};

export default function ImpressaoTerminalFormPage({ modo = 'novo' }: { modo?: 'novo' | 'editar' }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { id } = useParams();
  const { user } = useAuth();
  const isGestor = user?.perfil === 'admin' || user?.perfil === 'gerente';

  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [terminal, setTerminal] = useState<Partial<TerminalConfigCliente> | null>(null);
  const [agentes, setAgentes] = useState<AgenteRemotoCliente[]>([]);
  const [impressoras, setImpressoras] = useState<string[]>([]);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro('');
    try {
      const [terminais, ags, detectadas] = await Promise.all([
        listarTerminaisImpressao(),
        listarAgentesImpressao().catch(() => ({ rows: [] as AgenteRemotoCliente[], total: 0 })),
        listarImpressorasDetectadas().catch(() => ({ agentes: [], todas: [] as string[] }) as unknown as { agentes: []; todas: string[] }),
      ]);
      setAgentes(ags.rows || []);
      const lista = Array.isArray((detectadas as any).todas) ? ((detectadas as any).todas as string[]) : [];
      setImpressoras(lista);
      if (modo === 'editar') {
        const alvo = (terminais.rows || []).find((t) => Number(t.id) === Number(id));
        if (!alvo) {
          setErro('Terminal não encontrado nesta empresa.');
          return;
        }
        setTerminal({ ...alvo });
      } else {
        setTerminal({ ...TERMINAL_VAZIO });
      }
    } catch (e) {
      setErro((e as Error).message || 'Não foi possível carregar a configuração de impressão.');
    } finally {
      setCarregando(false);
    }
  }, [id, modo]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const podeSalvar = useMemo(() => !!terminal && String(terminal.codigo || '').trim().length > 0, [terminal]);

  async function salvar() {
    if (!terminal || !isGestor) return;
    setSalvando(true);
    setErro('');
    try {
      const payload = {
        ...terminal,
        default_printer: terminal.default_printer || null,
        receipt_printer: terminal.receipt_printer || null,
        label_printer: terminal.label_printer || null,
        document_printer: terminal.document_printer || null,
      };
      if (modo === 'editar' && terminal.id) {
        await atualizarTerminalImpressao(terminal.id, payload);
        toast.success(`Terminal ${terminal.codigo} atualizado.`);
      } else {
        await criarTerminalImpressao(payload);
        toast.success('Terminal cadastrado com sucesso.');
      }
      navigate('/config/impressao');
    } catch (e) {
      setErro((e as Error).message || 'Falha ao salvar terminal.');
    } finally {
      setSalvando(false);
    }
  }

  if (!isGestor) {
    return (
      <div className="space-y-4 p-4 sm:p-6">
        <PageHeader title="Terminal de impressão" description="Configuração de impressoras por terminal." />
        <Alert tone="amber">Somente gerentes e administradores configuram terminais de impressão.</Alert>
        <button className="btn-secondary" onClick={() => navigate('/config/impressao')}>
          Voltar
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            <Printer className="h-5 w-5 text-navy-600" />
            {modo === 'editar' ? `Editar terminal ${terminal?.codigo ?? ''}` : 'Novo terminal de impressão'}
          </span>
        }
        description="Vincule impressoras térmicas e de documentos a este posto de trabalho."
        actions={
          <div className="flex gap-2">
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/config/impressao')} disabled={salvando}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void salvar()} disabled={salvando || carregando || !podeSalvar}>
              {salvando ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Salvar terminal
            </button>
          </div>
        }
      />

      {carregando && <Spinner label="Carregando terminal..." />}
      {erro && <Alert tone="red">{erro}</Alert>}

      {terminal && !carregando && (
        <div className="card mx-auto max-w-4xl space-y-4 p-5 text-sm">
          <datalist id="impressoras-detectadas-list">
            {impressoras.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="terminal-codigo">
                Código (ex.: CAIXA-1)
              </label>
              <input
                id="terminal-codigo"
                type="text"
                className="input font-mono uppercase"
                value={terminal.codigo || ''}
                onChange={(e) => setTerminal({ ...terminal, codigo: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label" htmlFor="terminal-nome">
                Nome amigável
              </label>
              <input
                id="terminal-nome"
                type="text"
                className="input"
                placeholder="Caixa Balcão Principal"
                value={terminal.nome || ''}
                onChange={(e) => setTerminal({ ...terminal, nome: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="terminal-agente">
                Agente vinculado (opcional)
              </label>
              <select
                id="terminal-agente"
                className="input"
                value={terminal.agent_id ?? ''}
                onChange={(e) => setTerminal({ ...terminal, agent_id: e.target.value ? Number(e.target.value) : null })}
              >
                <option value="">Qualquer agente deste terminal</option>
                {agentes
                  .filter((a) => a.status === 'ativo')
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.nome} ({a.machine_id.slice(0, 8)})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="terminal-impressora-padrao">
                Impressora padrão
              </label>
              <input
                id="terminal-impressora-padrao"
                list="impressoras-detectadas-list"
                type="text"
                className="input"
                placeholder="Nome no spooler ou tcp://192.168.1.50:9100"
                value={terminal.default_printer || ''}
                onChange={(e) => setTerminal({ ...terminal, default_printer: e.target.value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="terminal-recibo">
                Impressora de recibo (PDV)
              </label>
              <input
                id="terminal-recibo"
                list="impressoras-detectadas-list"
                type="text"
                className="input"
                placeholder="Ex.: Elgin_i9"
                value={terminal.receipt_printer || ''}
                onChange={(e) => setTerminal({ ...terminal, receipt_printer: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="terminal-protocolo-recibo">
                Protocolo recibo
              </label>
              <select
                id="terminal-protocolo-recibo"
                className="input"
                value={terminal.receipt_protocol || 'escpos'}
                onChange={(e) => setTerminal({ ...terminal, receipt_protocol: e.target.value })}
              >
                <option value="escpos">ESC/POS (térmica)</option>
                <option value="text">Texto puro</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="terminal-largura">
                Largura bobina
              </label>
              <select
                id="terminal-largura"
                className="input"
                value={terminal.receipt_width_cols || 48}
                onChange={(e) => setTerminal({ ...terminal, receipt_width_cols: Number(e.target.value) })}
              >
                <option value={48}>80 mm (48 colunas)</option>
                <option value={42}>72 mm (42 colunas)</option>
                <option value={32}>58 mm (32 colunas)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="terminal-etiqueta">
                Impressora de etiquetas
              </label>
              <input
                id="terminal-etiqueta"
                list="impressoras-detectadas-list"
                type="text"
                className="input"
                placeholder="Ex.: Zebra_ZD220"
                value={terminal.label_printer || ''}
                onChange={(e) => setTerminal({ ...terminal, label_printer: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="terminal-protocolo-etiqueta">
                Protocolo etiquetas
              </label>
              <select
                id="terminal-protocolo-etiqueta"
                className="input"
                value={terminal.label_protocol || 'zpl'}
                onChange={(e) => setTerminal({ ...terminal, label_protocol: e.target.value })}
              >
                <option value="zpl">ZPL II (Zebra / compatível)</option>
                <option value="epl2">EPL2 (Elgin L42 / TLP2844)</option>
                <option value="a4">Folha A4 / Pimaco (navegador)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="label" htmlFor="terminal-documento">
                Impressora de documentos
              </label>
              <input
                id="terminal-documento"
                list="impressoras-detectadas-list"
                type="text"
                className="input"
                value={terminal.document_printer || ''}
                onChange={(e) => setTerminal({ ...terminal, document_printer: e.target.value })}
              />
            </div>
            <div>
              <label className="label" htmlFor="terminal-protocolo-documento">
                Protocolo documentos
              </label>
              <select
                id="terminal-protocolo-documento"
                className="input"
                value={terminal.document_protocol || 'pdf'}
                onChange={(e) => setTerminal({ ...terminal, document_protocol: e.target.value })}
              >
                <option value="pdf">PDF / contingência</option>
                <option value="escpos">ESC/POS</option>
                <option value="text">Texto puro</option>
              </select>
            </div>
            <div>
              <label className="label" htmlFor="terminal-fallback">
                Contingência (fallback)
              </label>
              <select
                id="terminal-fallback"
                className="input"
                value={terminal.fallback_mode || 'browser_pdf'}
                onChange={(e) => setTerminal({ ...terminal, fallback_mode: e.target.value })}
              >
                <option value="browser_pdf">PDF no navegador</option>
                <option value="browser_html">HTML no navegador</option>
                <option value="queue_only">Somente fila</option>
                <option value="none">Desativado</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-6 pt-1">
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={terminal.auto_print_pdv !== false} onChange={(e) => setTerminal({ ...terminal, auto_print_pdv: e.target.checked })} />
              Enfileirar cupom automaticamente após venda no PDV
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={terminal.allow_operator_reprint !== false} onChange={(e) => setTerminal({ ...terminal, allow_operator_reprint: e.target.checked })} />
              Permitir reimpressão por perfil Operador
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="checkbox" checked={terminal.ativo !== false} onChange={(e) => setTerminal({ ...terminal, ativo: e.target.checked })} />
              Terminal ativo
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
