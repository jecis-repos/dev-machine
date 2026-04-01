import { describe, it, expect, vi, beforeEach } from "vitest";

const mockExecSync = vi.fn();
const mockReadFile = vi.fn();

vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock("node:fs/promises", () => ({
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

let hostsEnabled = true;
vi.mock("../src/config.js", () => ({
  HOSTS_FILE: "/etc/hosts",
  get HOSTS_UPDATE_ENABLED() { return hostsEnabled; },
  instanceHostname: (prefix: string) => `${prefix}.app.test`,
}));

vi.mock("../src/lib/sanitize.js", () => ({
  validateHostname: () => {},
}));

import { addHostEntry, removeHostEntry } from "../src/lib/hosts.js";

describe("addHostEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostsEnabled = true;
  });

  it("adds a new host entry when hostname not present", async () => {
    mockReadFile.mockResolvedValue("127.0.0.1 localhost\n");
    mockExecSync.mockReturnValue(Buffer.from(""));

    const result = await addHostEntry("myapp");
    expect(result).toContain("Added myapp.app.test");
    expect(mockExecSync).toHaveBeenCalledOnce();
  });

  it("skips if hostname already exists in hosts file", async () => {
    mockReadFile.mockResolvedValue("127.0.0.1 localhost\n127.0.0.1 myapp.app.test\n");

    const result = await addHostEntry("myapp");
    expect(result).toContain("already exists");
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("returns disabled message when hosts update is disabled", async () => {
    hostsEnabled = false;
    const result = await addHostEntry("myapp");
    expect(result).toBe("Hosts update disabled");
    expect(mockReadFile).not.toHaveBeenCalled();
  });
});

describe("removeHostEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostsEnabled = true;
  });

  it("removes a host entry using sed", async () => {
    mockExecSync.mockReturnValue(Buffer.from(""));

    const result = await removeHostEntry("myapp");
    expect(result).toContain("Removed myapp.app.test");
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining("myapp.app.test"),
      expect.any(Object),
    );
  });

  it("returns disabled message when hosts update is disabled", async () => {
    hostsEnabled = false;
    const result = await removeHostEntry("myapp");
    expect(result).toBe("Hosts update disabled");
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
