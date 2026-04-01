import { describe, it, expect } from "vitest";
import { validateDbName, validateHostname, quoteDbIdentifier } from "../src/lib/sanitize.js";

describe("validateDbName", () => {
  it("accepts lowercase alphanumeric with underscores", () => {
    expect(() => validateDbName("my_db_01")).not.toThrow();
    expect(() => validateDbName("test")).not.toThrow();
    expect(() => validateDbName("a")).not.toThrow();
    expect(() => validateDbName("db_123_name")).not.toThrow();
  });

  it("rejects uppercase letters", () => {
    expect(() => validateDbName("MyDb")).toThrow("Invalid database name");
  });

  it("rejects special characters", () => {
    expect(() => validateDbName("my-db")).toThrow("Invalid database name");
    expect(() => validateDbName("my.db")).toThrow("Invalid database name");
    expect(() => validateDbName("my db")).toThrow("Invalid database name");
    expect(() => validateDbName("db@name")).toThrow("Invalid database name");
  });

  it("rejects SQL injection attempts", () => {
    expect(() => validateDbName("db; DROP TABLE")).toThrow("Invalid database name");
    expect(() => validateDbName("db'--")).toThrow("Invalid database name");
    expect(() => validateDbName('db"')).toThrow("Invalid database name");
  });

  it("rejects empty string", () => {
    expect(() => validateDbName("")).toThrow("Invalid database name");
  });
});

describe("validateHostname", () => {
  it("accepts valid hostnames", () => {
    expect(() => validateHostname("example.com")).not.toThrow();
    expect(() => validateHostname("my-app.test")).not.toThrow();
    expect(() => validateHostname("sub.domain.test")).not.toThrow();
    expect(() => validateHostname("localhost")).not.toThrow();
    expect(() => validateHostname("a.b.c")).not.toThrow();
  });

  it("rejects uppercase letters", () => {
    expect(() => validateHostname("Example.com")).toThrow("Invalid hostname");
  });

  it("rejects special characters", () => {
    expect(() => validateHostname("my_host.com")).toThrow("Invalid hostname");
    expect(() => validateHostname("host name.com")).toThrow("Invalid hostname");
    expect(() => validateHostname("host@name")).toThrow("Invalid hostname");
  });

  it("rejects empty string", () => {
    expect(() => validateHostname("")).toThrow("Invalid hostname");
  });
});

describe("quoteDbIdentifier", () => {
  it("wraps valid name in double quotes", () => {
    expect(quoteDbIdentifier("my_db")).toBe('"my_db"');
    expect(quoteDbIdentifier("test_123")).toBe('"test_123"');
  });

  it("throws for invalid names before quoting", () => {
    expect(() => quoteDbIdentifier("My-DB")).toThrow("Invalid database name");
    expect(() => quoteDbIdentifier("db; DROP")).toThrow("Invalid database name");
  });
});
