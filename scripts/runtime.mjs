import { randomUUID } from 'node:crypto';

export class Runtime {
  constructor() {
    const port = Number(process.env.RSRS_RPC_PORT ?? '15169');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Runtime port');
    this.base = 'http://127.0.0.1:' + port;
  }

  async json(path, request, timeout) {
    const response = await fetch(this.base + path, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
      ...(request && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    });
    if (!response.ok) throw new Error('Runtime HTTP ' + response.status);
    return response.json();
  }

  async bind() {
    this.health = await this.json('/api/health', null, 5000);
    const { protocol_range, account_id, instance_id, generation } = this.health;
    if (!(protocol_range?.minimum <= 1 && protocol_range?.maximum >= 1) ||
        typeof account_id !== 'string' || !instance_id || !Number.isSafeInteger(generation)) {
      throw new Error('Unsupported Runtime protocol or scope');
    }
    this.scope = { account_id, instance_id, generation };
    if (this.health.store_ready !== true) throw new Error('Runtime library is locked or unavailable');
  }

  matchesScope(reply) {
    return Object.entries(this.scope).every(([key, value]) => reply?.scope?.[key] === value);
  }

  async request(method, args, timeout, operation) {
    const id = randomUUID();
    const reply = await this.json('/api/rpc', {
      v: 1, id, scope: this.scope, method, args,
      ...(operation && { operation_id: operation, idempotency_key: operation }),
    }, timeout);
    if (reply.v !== 1 || reply.id !== id || !this.matchesScope(reply)) {
      throw new Error('Runtime response identity mismatch');
    }
    return reply;
  }

  envelope(reply, command) {
    const doc = reply?.envelope;
    if (doc?.command === 'cli' && doc.status === 'fail' && reply.ok === false && command !== 'remember') {
      throw new Error('Runtime rejected ' + command + ' (' + (doc.summary?.reason ?? 'unknown') + ')');
    }
    if (doc?.command !== command || typeof doc.status !== 'string') {
      throw new Error('Runtime response has no matching ' + command + ' envelope');
    }
    return doc;
  }

  async call(command, args = [], timeout = 5000) {
    return this.envelope(await this.request('cli.exec', ['--json', command, ...args], timeout), command);
  }

  async remember(args, operation) {
    const readReceipt = reply => {
      if (!this.matchesScope(reply) || reply.operation_id !== operation ||
          reply.idempotency_key !== operation) throw new Error('Runtime write receipt identity mismatch');
      return this.envelope(reply, 'remember');
    };

    try {
      return readReceipt(await this.request('cli.exec', ['--json', 'remember', ...args], 10000, operation));
    } catch (error) {
      console.error('Respire write response unavailable:', error.name);
      const result = this.envelope(await this.request('runtime.result', [operation], 2500), 'runtime.result');
      return readReceipt(result.summary?.response);
    }
  }
}
