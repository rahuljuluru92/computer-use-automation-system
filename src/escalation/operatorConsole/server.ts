/**
 * The operator console.
 *
 * Deliberately the least clever thing in this repository. A stuck run needs a
 * human to see it, take it, fix it, and hand it back; that is four verbs, and
 * this serves them over four routes plus a page that polls. The brief blesses
 * exactly this seam - the *mechanism* has to be real, the console does not have
 * to be a product - and the mechanism is not here. It is the lease, the capture
 * and the handoff protocol. This is the window onto them.
 *
 * Two things about it are load-bearing rather than incidental.
 *
 * **It binds to loopback.** An operator console is a remote-control for a
 * signed-in banking session. Listening on 0.0.0.0 would put that on the network
 * of whoever runs it, and the only reason to do so would be convenience.
 *
 * **Claiming is separate from resolving.** The console cannot resolve an
 * intervention nobody took, because "resolved" is a claim about what a human
 * did in the browser, and a console that can assert it without anyone having
 * held the session can lie to the run about what happened to a customer's
 * account.
 *
 * The run may be a different process. When it is, it POSTs the intervention
 * here and polls for the answer, and the browser it is holding stays where it
 * is - which is the point, because the operator drives *that* browser, not a
 * copy of it.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import type { InterventionBus } from '../bus.ts';
import { InterventionError } from '../bus.ts';
import { Resolution, type InterventionRecord } from '../intervention.ts';
import { consolePage } from './ui.ts';

export interface ConsoleOptions {
  bus: InterventionBus;
  port?: number;
  /** Loopback only. Overridable for tests that need an ephemeral port. */
  host?: string;
}

export interface RunningConsole {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function startOperatorConsole(o: ConsoleOptions): Promise<RunningConsole> {
  const host = o.host ?? '127.0.0.1';
  const bus = o.bus;

  const server = createServer((req, res) => {
    handle(req, res, bus).catch((err: unknown) => {
      send(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((done) => server.listen(o.port ?? 4500, host, done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (o.port ?? 4500);

  return {
    server, port,
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((done) => { server.close(() => { done(); }); }),
  };
}

// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse, bus: InterventionBus): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(consolePage());
    return;
  }

  if (method === 'GET' && path === '/api/interventions') {
    send(res, 200, { interventions: bus.list() });
    return;
  }

  // A run in another process raising an intervention here.
  if (method === 'POST' && path === '/api/interventions') {
    const body = await readJson(req) as { timeoutMs?: number } & Record<string, unknown>;
    const { timeoutMs, ...input } = body;
    // `raise` builds the record synchronously and resolves only when a human
    // is done, so the record is readable immediately and the promise is left
    // to the poller. It never rejects; "nobody came" is one of its outcomes.
    void bus.raise(input as Parameters<InterventionBus['raise']>[0],
      timeoutMs !== undefined ? { timeoutMs } : {});
    const record = bus.get(String(input.id));
    send(res, 201, record ?? { error: 'not created' });
    return;
  }

  const match = /^\/api\/interventions\/([^/]+)(?:\/(claim|resolve|actions|lease|abandon|screenshot))?$/
    .exec(path);
  if (!match) { send(res, 404, { error: `no route for ${method} ${path}` }); return; }

  const id = decodeURIComponent(match[1]!);
  const action = match[2];
  const record = bus.get(id);
  if (!record) { send(res, 404, { error: `no intervention ${id}` }); return; }

  try {
    switch (action) {
      case undefined:
        send(res, 200, record);
        return;

      case 'screenshot':
        await sendScreenshot(res, record);
        return;

      case 'claim': {
        const body = await readJson(req) as { operatorId?: string };
        const operatorId = (body.operatorId ?? '').trim();
        if (!operatorId) { send(res, 400, { error: 'claim needs an operatorId' }); return; }
        send(res, 200, bus.claim(id, operatorId));
        return;
      }

      case 'resolve': {
        const body = await readJson(req) as { resolution?: string; note?: string };
        const parsed = Resolution.safeParse(body.resolution);
        if (!parsed.success) {
          send(res, 400, { error: `resolution must be one of ${Resolution.options.join(', ')}` });
          return;
        }
        send(res, 200, bus.resolve(id, parsed.data, body.note));
        return;
      }

      case 'actions': {
        const body = await readJson(req) as { action?: Parameters<InterventionBus['recordHumanAction']>[1] };
        if (body.action) bus.recordHumanAction(id, body.action);
        send(res, 202, { ok: true });
        return;
      }

      case 'lease': {
        const body = await readJson(req) as { transfers?: InterventionRecord['leaseTransfers'] };
        if (body.transfers) bus.recordLeaseTransfers(id, body.transfers);
        send(res, 202, { ok: true });
        return;
      }

      case 'abandon': {
        const body = await readJson(req) as { abandon?: NonNullable<InterventionRecord['abandon']> };
        if (body.abandon) bus.recordAbandon(id, body.abandon);
        send(res, 202, { ok: true });
        return;
      }
    }
  } catch (e) {
    if (e instanceof InterventionError) {
      // A wrong-state transition is the console and the run disagreeing about
      // what has already happened - usually two tabs open. It is the operator's
      // problem to see, not a server fault.
      send(res, 409, { error: e.message, code: e.code });
      return;
    }
    throw e;
  }
}

/**
 * Serve the screenshot of the screen the run got stuck on.
 *
 * The path came from another process, so it is checked against the evidence
 * directory it claims to live in before anything is read. A console that will
 * serve any path a POST names is a file-read primitive wearing a helpful hat.
 */
async function sendScreenshot(res: ServerResponse, record: InterventionRecord): Promise<void> {
  if (!record.screenshotPath || !record.evidenceDir) {
    send(res, 404, { error: 'no screenshot for this intervention' });
    return;
  }
  const root = resolve(record.evidenceDir);
  const file = resolve(join(root, record.screenshotPath));
  if (file !== root && !file.startsWith(root + sep)) {
    send(res, 403, { error: 'screenshot path escapes its evidence directory' });
    return;
  }
  try {
    const bytes = await readFile(file);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    res.end(bytes);
  } catch {
    send(res, 404, { error: 'screenshot not readable' });
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // An intervention record is a few kilobytes. Anything larger is a mistake
    // or an attack, and either way this is not the place to find out how big.
    if (size > 1_000_000) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}
