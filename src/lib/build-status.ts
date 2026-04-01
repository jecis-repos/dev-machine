import { writeFile, rm, mkdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE_DIR, PROJECT_SUBDIR } from "../config.js";

export interface BuildStep {
  step: number;
  name: string;
  status: "pending" | "active" | "done" | "warning" | "error";
  duration?: number;
}

export interface BuildStatusData {
  instance: string;
  branch: string;
  displayName: string;
  mode: "create" | "update";
  totalSteps: number;
  currentStep: number;
  stepName: string;
  status: "building" | "complete" | "error";
  startedAt: string;
  updatedAt: string;
  error?: string;
  steps: BuildStep[];
}

const CREATE_STEPS: string[] = [
  "Validating configuration",
  "Allocating resources",
  "Verifying certificates",
  "Validating branch",
  "Cloning repository",
  "Detecting runtime version",
  "Generating environment",
  "Configuring Docker",
  "Configuring web server",
  "Setting up database config",
  "Creating databases",
  "Updating hosts",
  "Generating Makefile",
  "Starting services",
  "Installing dependencies",
  "Database & optimization",
];

const UPDATE_STEPS: string[] = [
  "Checking container",
  "Preparing update",
  "Pulling latest code",
  "Installing dependencies",
  "Building frontend",
  "Running migrations",
  "Optimizing",
];

const moduleDir = dirname(fileURLToPath(import.meta.url));
const STATUS_PAGE_PATH = join(moduleDir, "..", "..", "static", "build-status.html");

function publicDir(prefix: string): string {
  return join(BASE_DIR, prefix, PROJECT_SUBDIR, "public");
}

function statusJsonPath(prefix: string): string {
  return join(publicDir(prefix), "build-status.json");
}

function statusHtmlPath(prefix: string): string {
  return join(publicDir(prefix), "build-status.html");
}

export class BuildProgress {
  private status: BuildStatusData;
  private prefix: string;
  private stepStartTime: number;

  constructor(prefix: string, branch: string, displayName: string, mode: "create" | "update") {
    this.prefix = prefix;
    this.stepStartTime = Date.now();

    const stepNames = mode === "create" ? CREATE_STEPS : UPDATE_STEPS;

    this.status = {
      instance: prefix,
      branch,
      displayName,
      mode,
      totalSteps: stepNames.length,
      currentStep: 0,
      stepName: "Initializing...",
      status: "building",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: stepNames.map((name, i) => ({
        step: i + 1,
        name,
        status: "pending",
      })),
    };
  }

  async begin(stepNumber: number): Promise<void> {
    this.stepStartTime = Date.now();
    const idx = stepNumber - 1;
    if (idx >= 0 && idx < this.status.steps.length) {
      this.status.currentStep = stepNumber;
      this.status.stepName = this.status.steps[idx].name;
      this.status.steps[idx].status = "active";
      this.status.updatedAt = new Date().toISOString();
      await this.flush();
    }
  }

  async complete(stepNumber: number): Promise<void> {
    const idx = stepNumber - 1;
    if (idx >= 0 && idx < this.status.steps.length) {
      this.status.steps[idx].status = "done";
      this.status.steps[idx].duration = Date.now() - this.stepStartTime;
      this.status.updatedAt = new Date().toISOString();
      await this.flush();
    }
  }

  async warn(stepNumber: number): Promise<void> {
    const idx = stepNumber - 1;
    if (idx >= 0 && idx < this.status.steps.length) {
      this.status.steps[idx].status = "warning";
      this.status.steps[idx].duration = Date.now() - this.stepStartTime;
      this.status.updatedAt = new Date().toISOString();
      await this.flush();
    }
  }

  async fail(stepNumber: number, error: string): Promise<void> {
    const idx = stepNumber - 1;
    if (idx >= 0 && idx < this.status.steps.length) {
      this.status.steps[idx].status = "error";
      this.status.steps[idx].duration = Date.now() - this.stepStartTime;
    }
    this.status.status = "error";
    this.status.error = error;
    this.status.updatedAt = new Date().toISOString();
    await this.flush();
  }

  async finish(): Promise<void> {
    this.status.status = "complete";
    this.status.updatedAt = new Date().toISOString();
    await this.flush();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await this.cleanup();
  }

  async cleanup(): Promise<void> {
    try {
      const jsonPath = statusJsonPath(this.prefix);
      const htmlPath = statusHtmlPath(this.prefix);
      if (existsSync(jsonPath)) await rm(jsonPath, { force: true });
      if (existsSync(htmlPath)) await rm(htmlPath, { force: true });
    } catch {
      // Non-critical
    }
  }

  get currentStep(): number {
    return this.status.currentStep;
  }

  async deploy(): Promise<void> {
    const pubDir = publicDir(this.prefix);
    if (!existsSync(pubDir)) return;

    if (existsSync(STATUS_PAGE_PATH)) {
      try {
        await copyFile(STATUS_PAGE_PATH, statusHtmlPath(this.prefix));
      } catch {
        // Non-critical
      }
    }

    await this.flush();
  }

  private async flush(): Promise<void> {
    const pubDir = publicDir(this.prefix);
    if (!existsSync(pubDir)) {
      try {
        await mkdir(pubDir, { recursive: true });
      } catch {
        return;
      }
    }

    try {
      await writeFile(statusJsonPath(this.prefix), JSON.stringify(this.status, null, 2), "utf-8");
    } catch {
      // Non-critical — filesystem may not be ready
    }
  }
}
