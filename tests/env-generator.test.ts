import { describe, it, expect } from "vitest";
import { setEnvValue } from "../src/lib/env-generator.js";

describe("setEnvValue", () => {
  it("replaces an existing key", () => {
    const content = "APP_ENV=local\nAPP_DEBUG=true\n";
    const result = setEnvValue(content, "APP_ENV", "staging");
    expect(result).toContain("APP_ENV=staging");
    expect(result).toContain("APP_DEBUG=true");
    expect(result).not.toContain("APP_ENV=local");
  });

  it("appends a new key when it does not exist", () => {
    const content = "APP_ENV=local\n";
    const result = setEnvValue(content, "NEW_KEY", "new_value");
    expect(result).toContain("APP_ENV=local");
    expect(result).toContain("NEW_KEY=new_value");
  });

  it("handles empty content", () => {
    const result = setEnvValue("", "APP_KEY", "secret123");
    expect(result).toContain("APP_KEY=secret123");
  });

  it("replaces the correct key when key is a substring of another", () => {
    const content = "APP=one\nAPP_URL=http://localhost\n";
    const result = setEnvValue(content, "APP_URL", "http://example.com");
    expect(result).toContain("APP=one");
    expect(result).toContain("APP_URL=http://example.com");
    expect(result).not.toContain("APP_URL=http://localhost");
  });

  it("replaces value that contains special regex characters", () => {
    const content = "DB_URL=postgres://user:pass@host/db\n";
    const result = setEnvValue(content, "DB_URL", "postgres://new:pass@host/db2");
    expect(result).toContain("DB_URL=postgres://new:pass@host/db2");
  });

  it("appends with trailing newline even if content had none", () => {
    const result = setEnvValue("EXISTING=val", "NEW", "val2");
    expect(result).toContain("NEW=val2\n");
  });

  it("replaces only the first match on its own line", () => {
    const content = "KEY=old\nOTHER=value\n";
    const result = setEnvValue(content, "KEY", "new");
    const lines = result.trim().split("\n");
    expect(lines).toContain("KEY=new");
    expect(lines).toContain("OTHER=value");
  });
});
