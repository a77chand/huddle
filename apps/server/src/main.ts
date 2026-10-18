import { aiService } from './ai.ts';
import { buildApp } from './app.ts';
import { senderFromEnv } from './notify.ts';
import { Store } from './store.ts';

const env = process.env;
const store = new Store(env.DATABASE_PATH ?? 'huddle.db');
const { app, runDue, idle } = await buildApp({
  store,
  sender: senderFromEnv(env, (m) => console.warn(m)),
  makeCard: aiService(env.AI_URL),
  logger: true,
});
if (!env.AI_URL) app.log.warn('AI_URL not set: voice notes are stored as preset status only.');

// Escalation is decided here, not on the phone — the phone in trouble may be dead.
const ticker = setInterval(() => runDue(), 5_000);
const purger = setInterval(() => store.purge(Date.now() - 24 * 3600_000), 3600_000);

await app.listen({ host: env.HOST ?? '0.0.0.0', port: Number(env.PORT ?? 8787) });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(ticker);
    clearInterval(purger);
    await app.close();
    await idle();
    process.exit(0);
  });
}
