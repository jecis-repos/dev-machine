import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the registry module before importing port-allocator
vi.mock("../src/lib/registry.js", () => ({
  loadRegistry: vi.fn(),
}));

// Mock config to avoid filesystem access — no need to mock port range
// since PORT_RANGE_START/END are read from env at module load time
vi.mock("../src/config.js", () => ({}));

import { allocateVitePort, allocateRedisDbSlots } from "../src/lib/port-allocator.js";
import { loadRegistry } from "../src/lib/registry.js";

const mockLoadRegistry = vi.mocked(loadRegistry);

// Default port range: 5173-5250 (78 ports)
const PORT_RANGE_START = 5173;
const PORT_RANGE_END = 5250;

describe("allocateVitePort", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocates first available port when registry is empty", async () => {
    mockLoadRegistry.mockResolvedValue({ instances: [] });
    const port = await allocateVitePort();
    expect(port).toBe(PORT_RANGE_START);
  });

  it("skips ports already in use", async () => {
    mockLoadRegistry.mockResolvedValue({
      instances: [
        { prefix: "a", vite_port: 5173, db_name: "a", redis_db: 0, redis_cache_db: 1, display_name: "A", directory: "/a", branch: "main", timezone: "UTC" },
        { prefix: "b", vite_port: 5174, db_name: "b", redis_db: 2, redis_cache_db: 3, display_name: "B", directory: "/b", branch: "main", timezone: "UTC" },
      ],
    });
    const port = await allocateVitePort();
    expect(port).toBe(5175);
  });

  it("fills gaps when ports are freed", async () => {
    // Port 5173 is free (gap), 5174 is used, 5175 is used
    mockLoadRegistry.mockResolvedValue({
      instances: [
        { prefix: "b", vite_port: 5174, db_name: "b", redis_db: 0, redis_cache_db: 1, display_name: "B", directory: "/b", branch: "main", timezone: "UTC" },
        { prefix: "c", vite_port: 5175, db_name: "c", redis_db: 2, redis_cache_db: 3, display_name: "C", directory: "/c", branch: "main", timezone: "UTC" },
      ],
    });
    const port = await allocateVitePort();
    expect(port).toBe(5173);
  });

  it("throws on port exhaustion", async () => {
    // Fill all ports in the default range 5173-5250 (78 ports)
    const instances = [];
    for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
      instances.push({
        prefix: `i${p}`, vite_port: p, db_name: `db${p}`,
        redis_db: (p - PORT_RANGE_START) * 2, redis_cache_db: (p - PORT_RANGE_START) * 2 + 1,
        display_name: `I${p}`, directory: `/${p}`, branch: "main", timezone: "UTC",
      });
    }
    mockLoadRegistry.mockResolvedValue({ instances });
    await expect(allocateVitePort()).rejects.toThrow("Port exhaustion");
  });
});

describe("allocateRedisDbSlots", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allocates first two available DB slots when registry is empty", async () => {
    mockLoadRegistry.mockResolvedValue({ instances: [] });
    const result = await allocateRedisDbSlots();
    expect(result).toEqual({ redis_db: 0, redis_cache_db: 1 });
  });

  it("skips slots already in use", async () => {
    mockLoadRegistry.mockResolvedValue({
      instances: [
        { prefix: "a", vite_port: 5173, db_name: "a", redis_db: 0, redis_cache_db: 1, display_name: "A", directory: "/a", branch: "main", timezone: "UTC" },
      ],
    });
    const result = await allocateRedisDbSlots();
    expect(result).toEqual({ redis_db: 2, redis_cache_db: 3 });
  });

  it("fills gaps in Redis DB allocation", async () => {
    // DBs 0,1 used; 2,3 free (gap); 4,5 used
    mockLoadRegistry.mockResolvedValue({
      instances: [
        { prefix: "a", vite_port: 5173, db_name: "a", redis_db: 0, redis_cache_db: 1, display_name: "A", directory: "/a", branch: "main", timezone: "UTC" },
        { prefix: "b", vite_port: 5174, db_name: "b", redis_db: 4, redis_cache_db: 5, display_name: "B", directory: "/b", branch: "main", timezone: "UTC" },
      ],
    });
    const result = await allocateRedisDbSlots();
    expect(result).toEqual({ redis_db: 2, redis_cache_db: 3 });
  });

  it("throws on Redis DB slot exhaustion", async () => {
    // Fill all 64 DB slots (32 instances, each using 2 slots)
    const instances = [];
    for (let i = 0; i < 32; i++) {
      instances.push({
        prefix: `i${i}`, vite_port: 5173 + i, db_name: `db${i}`,
        redis_db: i * 2, redis_cache_db: i * 2 + 1,
        display_name: `I${i}`, directory: `/${i}`, branch: "main", timezone: "UTC",
      });
    }
    mockLoadRegistry.mockResolvedValue({ instances });
    await expect(allocateRedisDbSlots()).rejects.toThrow("Redis DB slot exhaustion");
  });
});
