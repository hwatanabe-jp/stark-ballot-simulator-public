import type { Server } from 'node:http';
import { logger } from '@stark-ballot/diagnostics/logger';
import { shutdownHostProcesses } from '@stark-ballot/node-adapters/zkvm/executor';

/** Install once at the executable boundary; imported test servers own their own lifetime. */
export function installStaticServerShutdown(server: Server): void {
  let shutdown: Promise<void> | undefined;
  function onSignal(signal: 'SIGTERM' | 'SIGINT'): void {
    shutdown ??= (async () => {
      const closed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      try {
        const executions = await shutdownHostProcesses();
        const cleanupComplete = executions.every((execution) => execution.cleanup === 'complete');
        if (!cleanupComplete) {
          logger.error('Static server host cleanup is unconfirmed', { event: 'static_server_cleanup_unconfirmed' });
        }
        process.exitCode = cleanupComplete ? (signal === 'SIGINT' ? 130 : 143) : 1;
      } catch {
        logger.error('Static server host shutdown failed', { event: 'static_server_shutdown_failed' });
        process.exitCode = 1;
      } finally {
        server.closeAllConnections();
        await closed;
      }
      // Let in-flight executor finally blocks finish their asynchronous artifact cleanup.
      // Setting the exit code keeps that cleanup alive after all server sockets close.
    })();
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}
