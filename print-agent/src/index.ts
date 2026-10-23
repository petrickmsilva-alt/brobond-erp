// Entrada do agente local de impressão do BroBond ERP.
//
// Uso:
//   brobond-print-agent              → API local (127.0.0.1) + polling
//   brobond-print-agent --pair XXXX-XXXX-XXXX
//                                    → pareia com o código gerado no ERP
//                                      (Configurações → Impressão) e sai
//   brobond-print-agent --once       → um ciclo de polling e sai (testes)
import { loadConfig } from './config/config.js';
import { Logger } from './logging/logger.js';
import { PrintAgent } from './core/agent.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const log = new Logger(cfg.logLevel);
  const agent = new PrintAgent(cfg, log);

  const pairIdx = args.indexOf('--pair');
  if (pairIdx >= 0) {
    const codigo = args[pairIdx + 1];
    if (!codigo) {
      log.error('uso: --pair XXXX-XXXX-XXXX (código gerado no ERP)');
      process.exitCode = 2;
      return;
    }
    await agent.parear(codigo);
    log.info('pareamento concluído. Agora rode o agente sem argumentos.');
    return;
  }

  if (args.includes('--once')) {
    await agent.ciclo();
    return;
  }

  await agent.startLocalServer();
  const parar = () => {
    void agent.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', parar);
  process.on('SIGTERM', parar);
  await agent.run();
}

main().catch((e) => {
  console.error('Falha fatal no agente:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
