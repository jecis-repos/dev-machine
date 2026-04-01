import { loadRegistry } from "./registry.js";

const PORT_RANGE_START = parseInt(process.env.DEVMACHINE_PORT_RANGE_START ?? "5173", 10);
const PORT_RANGE_END = parseInt(process.env.DEVMACHINE_PORT_RANGE_END ?? "5250", 10);

/**
 * Allocate the next available Vite dev server port using gap-filling.
 * When instances are destroyed, their ports become available again.
 */
export async function allocateVitePort(): Promise<number> {
  const registry = await loadRegistry();
  const used = new Set(registry.instances.map((i) => i.vite_port));

  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!used.has(port)) {
      return port;
    }
  }

  throw new Error(
    `Port exhaustion: all ports in range ${PORT_RANGE_START}-${PORT_RANGE_END} are allocated. ` +
    `${used.size} instances running. Remove unused instances or expand the range.`,
  );
}

/**
 * Allocate a pair of Redis DB slots (session + cache).
 * Same gap-filling logic applied to Redis database numbers.
 */
export async function allocateRedisDbSlots(): Promise<{ redis_db: number; redis_cache_db: number }> {
  const registry = await loadRegistry();
  const usedDbs = new Set<number>();
  for (const instance of registry.instances) {
    usedDbs.add(instance.redis_db);
    usedDbs.add(instance.redis_cache_db);
  }

  let sessionDb = -1;
  let cacheDb = -1;

  for (let db = 0; db < 64; db++) {
    if (!usedDbs.has(db)) {
      if (sessionDb === -1) {
        sessionDb = db;
      } else if (cacheDb === -1) {
        cacheDb = db;
        break;
      }
    }
  }

  if (sessionDb === -1 || cacheDb === -1) {
    throw new Error("Redis DB slot exhaustion: all 64 databases are allocated.");
  }

  return { redis_db: sessionDb, redis_cache_db: cacheDb };
}
