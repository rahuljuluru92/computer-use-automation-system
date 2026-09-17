/**
 * `cua operator` - the console a stuck run escalates into.
 *
 * Started once and left open. Runs come and go against it, which is why the bus
 * lives here rather than in the run: an operator should not have to be watching
 * at the moment a run gets stuck, and a run should not have to know whether
 * anybody was.
 *
 * It holds no browser. The run keeps the session it is already signed into, and
 * the operator drives that window - so what crosses between the two processes
 * is a decision, not a screen.
 */

import { InterventionBus } from '../escalation/bus.ts';
import { startOperatorConsole } from '../escalation/operatorConsole/server.ts';
import { describeIntervention } from '../escalation/intervention.ts';

export interface OperatorCommandOptions {
  port?: number | undefined;
  /** How long an intervention waits on silence before the run abandons. */
  timeoutMs?: number | undefined;
}

export async function runOperatorCommand(opts: OperatorCommandOptions): Promise<number> {
  const bus = new InterventionBus({
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // Mirror every change to the terminal. An operator watching the browser has
  // no reason to also be watching the page, and this is the audit trail
  // scrolling past in the place they already are.
  bus.onChange((record) => {
    console.log(`  ${describeIntervention(record)}`);
  });

  const running = await startOperatorConsole({
    bus,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });

  console.log(`operator console  ${running.url}`);
  console.log(`  Route a run to it with:  npm run replay -- --artifact <path> --operator ${running.url}`);
  console.log(`  Capability catalog (read-only):  ${running.url}/catalog`);
  console.log(`  Loopback only. Ctrl-C to stop.\n`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      console.log('\nstopping; settling anything still open as timed out.');
      // A run blocked on this console must not be left waiting on a promise
      // that can no longer be resolved. Shutting the bus down settles them.
      bus.shutdown();
      void running.close().then(resolve);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });

  return 0;
}
