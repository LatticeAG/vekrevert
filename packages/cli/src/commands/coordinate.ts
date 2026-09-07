/** vekrevert coordinate [--listen host:port] [--db path] */

import { listenCoordinator } from "@latticeag/vekrevert";

export async function coordinateCommand(argv: string[]): Promise<number> {
  let listen = process.env.VEKREVERT_COORDINATE_LISTEN ?? "127.0.0.1:7465";
  let db = process.env.VEKREVERT_COORDINATE_DB ?? "./.vekrevert/coordinator.db";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--listen") listen = argv[++i] ?? listen;
    else if (a.startsWith("--listen=")) listen = a.slice("--listen=".length);
    else if (a === "--db") db = argv[++i] ?? db;
    else if (a.startsWith("--db=")) db = a.slice("--db=".length);
    else if (a.startsWith("-")) {
      process.stderr.write(`unknown flag ${a}\n`);
      return 2;
    }
  }
  const [host, portRaw] = listen.includes(":") ? listen.split(":") : ["127.0.0.1", listen];
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    process.stderr.write("usage: vekrevert coordinate [--listen host:port] [--db path]\n");
    return 2;
  }
  const handle = await listenCoordinator({
    host: host || "127.0.0.1",
    port,
    dbPath: db,
    ...(process.env.VEKREVERT_API_KEY ? { apiKey: process.env.VEKREVERT_API_KEY } : {}),
  });
  process.stdout.write(`coordinator listening ${handle.url} db=${db}\n`);
  process.stdout.write("leases are per-resource, short-TTL; this is not a global lock manager\n");
  await new Promise<void>((resolve) => {
    const stop = () => {
      void handle.close().finally(() => resolve());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
