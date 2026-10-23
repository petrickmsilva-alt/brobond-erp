// ============================================================================
// Núcleo do agente: sobe a API local (127.0.0.1), mantém heartbeat e o loop
// de polling da fila. Tudo sequencial e tolerante a queda: ERP fora do ar
// vira backoff, nunca crash nem impressão duplicada.
// ============================================================================
import { hostname } from 'node:os';
import type { Server } from 'node:http';
import { loadToken, saveConfig, saveToken, type AgentConfig } from '../config/config.js';
import { ErpClient } from '../transport/erpClient.js';
import { criarLocalServer, ouvirLoopback } from '../transport/localServer.js';
import { JobRunner } from '../queue/jobRunner.js';
import { DryRunPrinter, UnsupportedPrinter, journalEm, type Printer } from '../printer/printer.js';
import { RendererRegistry, TextRenderer } from '../renderer/renderer.js';
import { Backoff, dormir } from './backoff.js';
import type { Logger } from '../logging/logger.js';

export const AGENT_VERSION = '0.1.0';

export class PrintAgent {
  private client: ErpClient;
  private printer: Printer;
  private runner: JobRunner;
  private server: Server | null = null;
  private rodando = false;
  private ultimoHeartbeat = 0;

  constructor(private cfg: AgentConfig, private log: Logger) {
    const token = loadToken(cfg);
    this.client = new ErpClient(cfg.erpUrl, cfg.machineId && token ? { machineId: cfg.machineId, token } : null, fetch, AGENT_VERSION);
    this.printer = cfg.dryRun ? new DryRunPrinter(`${cfg.dir}/outbox`) : new UnsupportedPrinter();
    const registry = new RendererRegistry();
    registry.register('text', new TextRenderer());
    this.runner = new JobRunner(this.client, registry, this.printer, journalEm(cfg.dir), log);
  }

  async parear(codigo: string): Promise<void> {
    const out = await this.client.pair(codigo, {
      nome: this.cfg.nome || `Agente ${hostname()}`,
      terminal: this.cfg.terminal || undefined,
      platform: process.platform,
    });
    this.cfg.machineId = out.machine_id;
    this.cfg.terminal = out.terminal ?? this.cfg.terminal;
    saveToken(this.cfg, out.token);
    saveConfig(this.cfg);
    this.client.setIdentity({ machineId: out.machine_id, token: out.token });
    this.log.info(`pareado como ${out.machine_id} (empresa ${out.empresa_id})`);
  }

  async startLocalServer(): Promise<void> {
    this.server = criarLocalServer({
      version: AGENT_VERSION,
      erpOrigin: this.cfg.erpOrigin,
      status: () => ({
        pareado: this.client.pareado,
        machineId: this.cfg.machineId,
        printers: this.cfg.dryRun ? ['dry-run (arquivo)'] : [],
      }),
      pair: async (codigo) => {
        await this.parear(codigo);
        return { machine_id: this.cfg.machineId!, nome: this.cfg.nome || hostname() };
      },
    });
    await ouvirLoopback(this.server, this.cfg.localPort);
    this.log.info(`API local em http://127.0.0.1:${this.cfg.localPort} (somente loopback)`);
  }

  /** Um ciclo: heartbeat (se vencido) + processa a fila até esvaziar. */
  async ciclo(): Promise<boolean> {
    if (!this.client.pareado) return false;
    const agora = Date.now();
    if (agora - this.ultimoHeartbeat >= this.cfg.heartbeatMs) {
      await this.client.heartbeat(await this.printer.printers());
      this.ultimoHeartbeat = agora;
    }
    let houve = true;
    let rodadas = 0;
    while (houve && rodadas < 50) {
      houve = await this.runner.processarProximo();
      rodadas++;
    }
    return true;
  }

  async run(): Promise<void> {
    this.rodando = true;
    const backoff = new Backoff(this.cfg.pollMs, 60_000);
    this.log.info(this.client.pareado ? 'agente iniciado (pareado) — polling na fila' : 'agente iniciado SEM pareamento — use POST /pair na API local ou --pair CODIGO');
    while (this.rodando) {
      try {
        await this.ciclo();
        await dormir(backoff.proximaEspera(false));
      } catch (e) {
        const espera = backoff.proximaEspera(true);
        this.log.warn(`falha no ciclo (${(e as Error).message}) — nova tentativa em ${Math.round(espera / 1000)}s`);
        await dormir(espera);
      }
    }
  }

  async stop(): Promise<void> {
    this.rodando = false;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
