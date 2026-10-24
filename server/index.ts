// VulnSeal server entry point.
import { createApp } from "./app.ts";
import { openContext } from "./context.ts";

const ctx = openContext();
const { app, shutdown } = createApp(ctx.svc, ctx.sessions, ctx.cfg);

try {
  const block = await ctx.ledger.ping();
  console.log(`[server] chain OK at ${ctx.ledger.rpcUrl} (block ${block}), contract ${ctx.dep.address}`);
} catch (e) {
  console.warn(`[server] WARNING: ${(e as Error).message}`);
}

const server = app.listen(ctx.cfg.port, ctx.cfg.host, () => {
  console.log(`[server] VulnSeal listening on http://${ctx.cfg.host}:${ctx.cfg.port}`);
});
server.on("error", (e) => {
  console.error(`[server] failed to listen: ${e.message}`);
  process.exit(1);
});

const stop = () => {
  shutdown();
  server.close(() => {
    ctx.store.close();
    ctx.ledger.provider.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
