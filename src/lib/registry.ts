import { readFileSync, writeFileSync } from "node:fs";
import { REGISTRY_PATH } from "../config.js";
import type { Instance, Registry } from "../types.js";
import { withRegistryLock } from "./file-lock.js";

/**
 * Load the instance registry from disk.
 * Returns a Registry with an instances array.
 */
export async function loadRegistry(): Promise<Registry> {
  try {
    const content = readFileSync(REGISTRY_PATH, "utf-8");
    return JSON.parse(content) as Registry;
  } catch {
    return { instances: [] };
  }
}

function writeRegistry(registry: Registry): void {
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

/**
 * Add an instance to the registry (with file locking).
 */
export async function addInstance(instance: Instance): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await loadRegistry();
    const existing = registry.instances.findIndex(
      (i: Instance) => i.prefix === instance.prefix,
    );
    if (existing >= 0) {
      registry.instances[existing] = instance;
    } else {
      registry.instances.push(instance);
    }
    writeRegistry(registry);
  });
}

/**
 * Remove an instance from the registry by prefix (with file locking).
 */
export async function removeInstance(prefix: string): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await loadRegistry();
    registry.instances = registry.instances.filter(
      (i: Instance) => i.prefix !== prefix,
    );
    writeRegistry(registry);
  });
}

/**
 * Update fields on an existing instance (with file locking).
 */
export async function updateInstance(
  prefix: string,
  updates: Partial<Instance>,
): Promise<void> {
  await withRegistryLock(async () => {
    const registry = await loadRegistry();
    const instance = registry.instances.find(
      (i: Instance) => i.prefix === prefix,
    );
    if (instance) {
      Object.assign(instance, updates);
      writeRegistry(registry);
    }
  });
}
