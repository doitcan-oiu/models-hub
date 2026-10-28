import type { Env } from './env';
import { Store } from './store';
import type { AttemptRecord, GatewayChannel } from '../shared/types';

/** Serializes short state mutations only. Upstream requests never enter this queue. */
export class GatewayState {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(_state: DurableObjectState, private env: Env) {}
  fetch(request: Request): Promise<Response> {
    const job = this.tail.then(async () => {
      try {
        const args = await request.json() as Record<string,unknown>; const store = new Store(this.env,false); const op = new URL(request.url).pathname; let result: unknown;
        if (op === '/attempt') result = await store.recordAttempt(args as unknown as AttemptRecord);
        else if (op === '/health') result = await store.updateHealth(args.channelId as string,args.patch as Partial<GatewayChannel['health']>,args.status as GatewayChannel['status']);
        else if (op === '/reset-health') result = await store.resetChannelHealth(args.channelId as string);
        else if (op === '/quota') result = await store.incrementKeyUsage(args.keyId as string,args.profileId as string,args.limit as number);
        else if (op === '/rr') result = await store.nextRoundRobin(args.scope as string);
        else if (op === '/rate') result = await store.reserveChannel(args.channel as GatewayChannel,args.estimatedTokens as number);
        else return Response.json({ error:'Unknown operation' },{ status:404 });
        return Response.json({ result:result ?? null });
      } catch { return Response.json({ error:'State mutation failed' },{ status:500 }); }
    });
    this.tail = job.catch(() => {}); return job;
  }
}
