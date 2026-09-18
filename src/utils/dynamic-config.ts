/**
 * =============================================================================
 * Canvast — Dynamic Configuration / 动态配置
 * =============================================================================
 * @file        src/utils/dynamic-config.ts
 * @brief       Runtime-adjustable performance and behavior parameters
 * @description Centrally manages all tunable parameters with auto-tuning based
 *              on system load, config presets for different resource profiles,
 *              and persistent file backing. Parameters can be adjusted at
 *              runtime without restart. Integrates with SystemMonitor for
 *              automatic throttle response.
 *              运行时动态调整参数管理系统。
 *
 *              Key features / 核心能力：
 *              - All tunable parameters in one place with defaults
 *              - Auto-tuning: CPU/memory pressure → reduce concurrency, GC freq
 *              - Config presets: "minimal" / "balanced" / "performance"
 *              - JSON file persistence for cross-session config
 *              - Validation: all values type-checked and range-clamped
 *              - Change events: subscribers notified on config changes
 *              - Per-component config scoping
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import type { SystemMonitor, HealthStatus } from "./system-monitor.js";
import { type ResourceAllocator, type ResourceBudget, type UserResourcePolicy, getResourceAllocator } from "./resource-allocator.js";

// ─── Configuration Schema / 配置模式 ──────────────────────────

/** Context budget parameters */
export interface ContextBudgetConfig {
  /** Hard ceiling for total context tokens */
  hardCeiling: number;
  /** System prompt allocation */
  systemPromptTokens: number;
  /** Canvas scope max tokens */
  canvasScopeMaxTokens: number;
  /** Max files to include in context */
  maxTaskFiles: number;
  /** Recent history max tokens */
  historyMaxTokens: number;
  /** Per-file token budget */
  perFileTokens: number;
}

/** Sub-agent / concurrency parameters */
export interface ConcurrencyConfig {
  /** Max parallel sub-agents */
  maxParallelAgents: number;
  /** Max recursion depth */
  maxRecursionDepth: number;
  /** Default sub-agent timeout (ms) */
  defaultAgentTimeoutMs: number;
  /** Max total agents across all depths */
  maxTotalAgents: number;
  /** Cooldown between agent spawns (ms) */
  agentSpawnCooldownMs: number;
}

/** GC parameters */
export interface GcParamsConfig {
  /** Auto-GC interval (ms) */
  autoGcIntervalMs: number;
  /** Max nodes before size eviction */
  maxTotalNodes: number;
  /** Max edges before size eviction */
  maxTotalEdges: number;
  /** Max nodes collected per pass */
  maxCollectPerPass: number;
  /** Stale node age before collection (ms) */
  maxStaleAgeMs: number;
}

/** Monitoring parameters */
export interface MonitorParamsConfig {
  /** Monitoring interval (ms) */
  monitorIntervalMs: number;
  /** History retention count */
  historyRetention: number;
  /** Heap warning ratio (0-1) */
  heapWarningRatio: number;
  /** Heap critical ratio (0-1) */
  heapCriticalRatio: number;
  /** RSS critical threshold (bytes) */
  rssCriticalBytes: number;
  /** Max child processes */
  maxChildProcesses: number;
}

/** Canvas scope parameters */
export interface CanvasScopeConfig {
  /** Max BFS traversal depth */
  maxTraversalDepth: number;
  /** Max nodes in a scope view */
  maxScopeNodes: number;
  /** Stale detection batch size */
  staleBatchSize: number;
  /** Stale detection interval (ms) */
  staleDetectionIntervalMs: number;
}

/** Full dynamic configuration */
export interface DynamicConfig {
  context: ContextBudgetConfig;
  concurrency: ConcurrencyConfig;
  gc: GcParamsConfig;
  monitor: MonitorParamsConfig;
  canvas: CanvasScopeConfig;
}

/**
 * One-level-deep partial of DynamicConfig: top-level sections optional and
 * each section's fields optional. Matches the runtime deepMerge behavior
 * (constructor overrides and update() both merge into the preset).
 */
export type PartialDynamicConfig = Partial<{
  context: Partial<ContextBudgetConfig>;
  concurrency: Partial<ConcurrencyConfig>;
  gc: Partial<GcParamsConfig>;
  monitor: Partial<MonitorParamsConfig>;
  canvas: Partial<CanvasScopeConfig>;
}>;

/** Recursive partial used by deepMerge (objects recursed, leaves as-is). */
type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, any> ? DeepPartial<T[K]> : T[K];
};

// ─── Presets / 预设 ───────────────────────────────────────────

/** Minimal resource usage — for constrained environments */
export const PRESET_MINIMAL: DynamicConfig = {
  context: {
    hardCeiling: 20000,
    systemPromptTokens: 2000,
    canvasScopeMaxTokens: 3000,
    maxTaskFiles: 3,
    historyMaxTokens: 5000,
    perFileTokens: 1500,
  },
  concurrency: {
    maxParallelAgents: 2,
    maxRecursionDepth: 2,
    defaultAgentTimeoutMs: 120_000,
    maxTotalAgents: 10,
    agentSpawnCooldownMs: 5000,
  },
  gc: {
    autoGcIntervalMs: 30_000,
    maxTotalNodes: 3000,
    maxTotalEdges: 6000,
    maxCollectPerPass: 200,
    maxStaleAgeMs: 30 * 60_000,
  },
  monitor: {
    monitorIntervalMs: 3000,
    historyRetention: 60,
    heapWarningRatio: 0.60,
    heapCriticalRatio: 0.75,
    rssCriticalBytes: 1 * 1024 * 1024 * 1024, // 1 GB
    maxChildProcesses: 8,
  },
  canvas: {
    maxTraversalDepth: 1,
    maxScopeNodes: 5,
    staleBatchSize: 20,
    staleDetectionIntervalMs: 120_000,
  },
};

/** Balanced — default for most environments */
export const PRESET_BALANCED: DynamicConfig = {
  context: {
    hardCeiling: 28000,
    systemPromptTokens: 3000,
    canvasScopeMaxTokens: 5000,
    maxTaskFiles: 5,
    historyMaxTokens: 10000,
    perFileTokens: 2000,
  },
  concurrency: {
    maxParallelAgents: 5,
    maxRecursionDepth: 3,
    defaultAgentTimeoutMs: 300_000,
    maxTotalAgents: 50,
    agentSpawnCooldownMs: 1000,
  },
  gc: {
    autoGcIntervalMs: 60_000,
    maxTotalNodes: 10000,
    maxTotalEdges: 20000,
    maxCollectPerPass: 100,
    maxStaleAgeMs: 60 * 60_000,
  },
  monitor: {
    monitorIntervalMs: 5000,
    historyRetention: 120,
    heapWarningRatio: 0.70,
    heapCriticalRatio: 0.85,
    rssCriticalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
    maxChildProcesses: 20,
  },
  canvas: {
    maxTraversalDepth: 2,
    maxScopeNodes: 10,
    staleBatchSize: 50,
    staleDetectionIntervalMs: 60_000,
  },
};

/** Performance — for powerful machines, full throughput */
export const PRESET_PERFORMANCE: DynamicConfig = {
  context: {
    hardCeiling: 40000,
    systemPromptTokens: 4000,
    canvasScopeMaxTokens: 8000,
    maxTaskFiles: 8,
    historyMaxTokens: 15000,
    perFileTokens: 3000,
  },
  concurrency: {
    maxParallelAgents: 10,
    maxRecursionDepth: 4,
    defaultAgentTimeoutMs: 600_000,
    maxTotalAgents: 100,
    agentSpawnCooldownMs: 500,
  },
  gc: {
    autoGcIntervalMs: 120_000,
    maxTotalNodes: 20000,
    maxTotalEdges: 40000,
    maxCollectPerPass: 200,
    maxStaleAgeMs: 120 * 60_000,
  },
  monitor: {
    monitorIntervalMs: 10000,
    historyRetention: 200,
    heapWarningRatio: 0.75,
    heapCriticalRatio: 0.90,
    rssCriticalBytes: 4 * 1024 * 1024 * 1024, // 4 GB
    maxChildProcesses: 40,
  },
  canvas: {
    maxTraversalDepth: 3,
    maxScopeNodes: 15,
    staleBatchSize: 100,
    staleDetectionIntervalMs: 30_000,
  },
};

export type PresetName = "minimal" | "balanced" | "performance";

export const PRESETS: Record<PresetName, DynamicConfig> = {
  minimal: PRESET_MINIMAL,
  balanced: PRESET_BALANCED,
  performance: PRESET_PERFORMANCE,
};

// ─── Auto-Tuning / 自动调整 ────────────────────────────────────

/**
 * Maps a health status to a scaling factor for concurrency.
 * 0 = full stop, 1 = normal, values in between reduce throughput.
 */
export function healthToConcurrencyScale(status: HealthStatus): number {
  switch (status) {
    case "healthy": return 1.0;
    case "warning": return 0.6;
    case "critical": return 0.25;
    case "emergency": return 0.0;
  }
}

/**
 * Maps a health status to a GC frequency multiplier.
 * >1 = more frequent GC, <1 = less frequent.
 */
export function healthToGcFrequencyScale(status: HealthStatus): number {
  switch (status) {
    case "healthy": return 1.0;
    case "warning": return 2.0;
    case "critical": return 5.0;
    case "emergency": return 10.0;
  }
}

// ─── DynamicConfigManager / 动态配置管理器 ─────────────────────

export type ConfigChangeCallback = (
  path: string,
  oldValue: unknown,
  newValue: unknown,
) => void;

export class DynamicConfigManager {
  private config: DynamicConfig;
  private listeners: ConfigChangeCallback[] = [];
  private systemMonitor: SystemMonitor | null = null;
  private baseConfig: DynamicConfig;
  private filePath: string | null = null;
  private persistInterval: ReturnType<typeof setInterval> | null = null;
  private allocator: ResourceAllocator | null = null;

  /** Current auto-tuning scale (1.0 = no throttling) */
  private autoTuneScale = 1.0;

  /** Whether to auto-sync config from ResourceAllocator on each access */
  private autoSyncFromAllocator = false;

  constructor(
    initialConfig?: PartialDynamicConfig & { preset?: PresetName },
    allocator?: ResourceAllocator,
    userPolicy?: UserResourcePolicy,
  ) {
    // If an allocator is provided (or can be created), use it as the source of truth
    this.allocator = allocator ?? null;

    const preset = initialConfig?.preset ?? "balanced";
    this.baseConfig = this.deepMerge(
      structuredClone(PRESETS[preset]),
      initialConfig ?? {},
    );
    this.config = structuredClone(this.baseConfig);

    // If allocator is available, derive initial config from it
    if (this.allocator) {
      this.syncFromAllocator();
      this.autoSyncFromAllocator = true;
    }
  }

  /**
   * Attach a ResourceAllocator and derive all config values from
   * actual hardware state. This replaces static presets with real
   * hardware-adaptive configuration.
   *
   * 挂载资源分配器，从真实硬件状态推导所有配置值。
   * 用硬件自适应配置替代静态预设。
   */
  attachAllocator(allocator: ResourceAllocator): void {
    this.allocator = allocator;
    this.autoSyncFromAllocator = true;
    this.syncFromAllocator();
  }

  /**
   * Sync all config values from the resource allocator's computed budget.
   * Called automatically before each access when autoSync is enabled.
   */
  syncFromAllocator(): void {
    if (!this.allocator) return;
    const budget = this.allocator.computeBudget();

    // Context budget: scale with available RAM
    const ramScale = Math.max(0.25, Math.min(1.0, budget.availableRam / (4 * 1024 * 1024 * 1024))); // scale relative to 4GB
    this.config.context = {
      hardCeiling: Math.floor(28000 * ramScale),
      systemPromptTokens: Math.floor(3000 * ramScale),
      canvasScopeMaxTokens: Math.floor(5000 * ramScale),
      maxTaskFiles: Math.max(2, Math.floor(5 * ramScale)),
      historyMaxTokens: Math.floor(10000 * ramScale),
      perFileTokens: Math.floor(2000 * ramScale),
    };

    // Concurrency: directly from allocator
    this.config.concurrency = {
      maxParallelAgents: budget.maxConcurrentAgents,
      maxRecursionDepth: budget.hardware.tier === "low" ? 2 : budget.hardware.tier === "medium" ? 3 : 4,
      defaultAgentTimeoutMs: budget.agentTimeoutMs,
      maxTotalAgents: budget.maxConcurrentAgents * 3, // allow queue depth of 3x
      agentSpawnCooldownMs: budget.hardware.tier === "low" ? 3000 : budget.hardware.tier === "medium" ? 1500 : 500,
    };

    // GC: based on available RAM and tier
    const gcAgg = budget.gcAggressiveness;
    this.config.gc = {
      autoGcIntervalMs: gcAgg === "aggressive" ? 15_000 : gcAgg === "gentle" ? 120_000 : 60_000,
      maxTotalNodes: budget.hardware.tier === "low" ? 3000 : budget.hardware.tier === "medium" ? 10000 : 20000,
      maxTotalEdges: budget.hardware.tier === "low" ? 6000 : budget.hardware.tier === "medium" ? 20000 : 40000,
      maxCollectPerPass: budget.hardware.tier === "low" ? 50 : budget.hardware.tier === "medium" ? 100 : 200,
      maxStaleAgeMs: gcAgg === "aggressive" ? 15 * 60_000 : gcAgg === "gentle" ? 120 * 60_000 : 60 * 60_000,
    };

    // Monitor: adaptive intervals
    this.config.monitor = {
      monitorIntervalMs: budget.hardware.tier === "low" ? 10000 : 5000,
      historyRetention: budget.hardware.tier === "low" ? 60 : 120,
      heapWarningRatio: 0.70,
      heapCriticalRatio: 0.85,
      rssCriticalBytes: budget.maxTotalRam,
      maxChildProcesses: budget.maxChildProcesses,
    };

    // Canvas: scale with available RAM
    this.config.canvas = {
      maxTraversalDepth: budget.hardware.tier === "low" ? 1 : 2,
      maxScopeNodes: Math.max(3, Math.floor(10 * ramScale)),
      staleBatchSize: Math.max(10, Math.floor(50 * ramScale)),
      staleDetectionIntervalMs: budget.hardware.tier === "low" ? 120_000 : 60_000,
    };
  }

  // ─── Accessors / 访问器 ────────────────────────────────────

  /** Get a snapshot of the full current config */
  get full(): DynamicConfig { this.maybeSync(); return structuredClone(this.config); }

  /** Get context budget config */
  get context(): ContextBudgetConfig { this.maybeSync(); return { ...this.config.context }; }

  /** Get concurrency config (with auto-tune applied) */
  get concurrency(): ConcurrencyConfig {
    this.maybeSync();
    const c = { ...this.config.concurrency };
    c.maxParallelAgents = Math.max(1, Math.floor(c.maxParallelAgents * this.autoTuneScale));
    c.maxTotalAgents = Math.max(1, Math.floor(c.maxTotalAgents * this.autoTuneScale));
    return c;
  }

  /** Get raw concurrency config (without auto-tune) */
  get rawConcurrency(): ConcurrencyConfig { this.maybeSync(); return { ...this.config.concurrency }; }

  /** Get GC config (with auto-tune applied) */
  get gc(): GcParamsConfig {
    this.maybeSync();
    const c = { ...this.config.gc };
    if (this.autoTuneScale < 1.0) {
      const freqScale = healthToGcFrequencyScale(
        this.autoTuneScale <= 0.25 ? "critical" :
        this.autoTuneScale <= 0.6 ? "warning" : "healthy",
      );
      c.autoGcIntervalMs = Math.max(5000, Math.floor(c.autoGcIntervalMs / freqScale));
      c.maxCollectPerPass = Math.floor(c.maxCollectPerPass * 2);
    }
    return c;
  }

  /** Get raw GC config */
  get rawGc(): GcParamsConfig { this.maybeSync(); return { ...this.config.gc }; }

  /** Get monitor config */
  get monitor(): MonitorParamsConfig { this.maybeSync(); return { ...this.config.monitor }; }

  /** Get canvas scope config */
  get canvas(): CanvasScopeConfig { this.maybeSync(); return { ...this.config.canvas }; }

  /** Get current auto-tune scale */
  get currentAutoTuneScale(): number { return this.autoTuneScale; }

  /** Get the attached resource allocator (if any) */
  get resourceAllocator(): ResourceAllocator | null { return this.allocator; }

  /** Whether auto-sync from allocator is enabled */
  get isAutoSyncEnabled(): boolean { return this.autoSyncFromAllocator; }

  /**
   * Sync from allocator if enabled, but throttle to avoid recomputing
   * on every single access. Syncs at most once per second.
   */
  private lastSyncTime = 0;
  private maybeSync(): void {
    if (!this.autoSyncFromAllocator || !this.allocator) return;
    const now = Date.now();
    if (now - this.lastSyncTime > 1000) {
      this.lastSyncTime = now;
      this.syncFromAllocator();
    }
  }

  // ─── Mutation / 修改 ──────────────────────────────────────

  /**
   * Update a specific config value by dotted path.
   * E.g., "context.hardCeiling", "concurrency.maxParallelAgents"
   */
  set(path: string, value: unknown): void {
    const parts = path.split(".");
    let target: any = this.config;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in target)) {
        throw new Error(`Invalid config path: ${path}`);
      }
      target = target[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    if (!(lastKey in target)) {
      throw new Error(`Invalid config key: ${lastKey} in ${path}`);
    }

    const oldValue = target[lastKey];
    const validated = this.validate(lastKey, value);
    target[lastKey] = validated;

    // Notify listeners
    for (const listener of this.listeners) {
      try { listener(path, oldValue, validated); } catch { /* swallow */ }
    }
  }

  /**
   * Batch-update multiple config values.
   */
  update(partial: PartialDynamicConfig): void {
    if (partial.context) {
      for (const [k, v] of Object.entries(partial.context)) {
        this.set(`context.${k}`, v);
      }
    }
    if (partial.concurrency) {
      for (const [k, v] of Object.entries(partial.concurrency)) {
        this.set(`concurrency.${k}`, v);
      }
    }
    if (partial.gc) {
      for (const [k, v] of Object.entries(partial.gc)) {
        this.set(`gc.${k}`, v);
      }
    }
    if (partial.monitor) {
      for (const [k, v] of Object.entries(partial.monitor)) {
        this.set(`monitor.${k}`, v);
      }
    }
    if (partial.canvas) {
      for (const [k, v] of Object.entries(partial.canvas)) {
        this.set(`canvas.${k}`, v);
      }
    }
  }

  /** Apply a named preset */
  applyPreset(name: PresetName): void {
    this.baseConfig = structuredClone(PRESETS[name]);
    this.config = structuredClone(this.baseConfig);
    this.notifyAll();
  }

  /** Reset to the initial base config */
  reset(): void {
    this.config = structuredClone(this.baseConfig);
    this.autoTuneScale = 1.0;
    this.notifyAll();
  }

  // ─── Auto-Tuning / 自动调整 ────────────────────────────────

  /**
   * Attach a SystemMonitor for automatic throttle response.
   * When the monitor detects resource pressure, config automatically
   * scales down concurrency and scales up GC frequency.
   *
   * SystemMonitor emits a CONTINUOUS throttle factor in [0, 1]
   * (1.0 = healthy, decreasing toward — but never reaching — 0 under
   * pressure). Map it directly onto the auto-tune scale: continuous,
   * no dead zones, and consistent with the "guardrail, not kill switch"
   * design principle (never hard-zero the system).
   */
  attachMonitor(monitor: SystemMonitor): void {
    this.systemMonitor = monitor;
    monitor.onThrottleChange((factor) => {
      const oldScale = this.autoTuneScale;
      const nextScale = Math.max(0, Math.min(1, factor));
      if (Math.abs(nextScale - oldScale) < 0.01) return;
      this.autoTuneScale = nextScale;
      for (const listener of this.listeners) {
        try { listener("_autoTuneScale", oldScale, this.autoTuneScale); } catch { /* */ }
      }
    });
  }

  /** Manually set auto-tune scale (overrides monitor-driven tuning) */
  setAutoTuneScale(scale: number): void {
    this.autoTuneScale = Math.max(0, Math.min(1, scale));
  }

  /** Compute effective parallelism considering system health */
  getEffectiveParallelism(requested: number): number {
    const base = Math.min(requested, this.config.concurrency.maxParallelAgents);
    return Math.max(1, Math.floor(base * this.autoTuneScale));
  }

  // ─── Persistence / 持久化 ──────────────────────────────────

  /** Enable periodic config persistence to a JSON file */
  enablePersistence(filePath: string, intervalMs: number = 60_000): void {
    this.filePath = filePath;
    this.persistInterval = setInterval(() => this.persist(), intervalMs);
    if ("unref" in this.persistInterval) {
      (this.persistInterval as any).unref();
    }
  }

  /** Disable periodic config persistence */
  disablePersistence(): void {
    if (this.persistInterval !== null) {
      clearInterval(this.persistInterval);
      this.persistInterval = null;
    }
  }

  /** Persist current config to file (also called on process exit) */
  persist(): void {
    if (!this.filePath) return;
    try {
      const fs = require("node:fs");
      const data = JSON.stringify(this.config, null, 2);
      fs.writeFileSync(this.filePath, data, "utf-8");
    } catch {
      // File persistence is best-effort
    }
  }

  /** Load config from a persisted JSON file */
  static load(filePath: string): DynamicConfigManager {
    try {
      const fs = require("node:fs");
      const data = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(data);
      return new DynamicConfigManager(parsed);
    } catch {
      return new DynamicConfigManager();
    }
  }

  // ─── Change Listeners ────────────────────────────────────

  /** Subscribe to config changes */
  onChange(listener: ConfigChangeCallback): void {
    this.listeners.push(listener);
  }

  /** Unsubscribe from config changes */
  offChange(listener: ConfigChangeCallback): void {
    const idx = this.listeners.indexOf(listener);
    if (idx >= 0) this.listeners.splice(idx, 1);
  }

  // ─── Private ──────────────────────────────────────────────

  private validate(key: string, value: unknown): unknown {
    if (typeof value !== "number") return value;
    // Range-clamp numeric values
    const num = value as number;
    const ranges: Record<string, [number, number]> = {
      hardCeiling: [5000, 100000],
      systemPromptTokens: [500, 10000],
      canvasScopeMaxTokens: [500, 20000],
      maxTaskFiles: [1, 20],
      historyMaxTokens: [1000, 50000],
      perFileTokens: [500, 10000],
      maxParallelAgents: [1, 50],
      maxRecursionDepth: [1, 10],
      defaultAgentTimeoutMs: [10000, 3600000],
      maxTotalAgents: [1, 1000],
      agentSpawnCooldownMs: [0, 60000],
      autoGcIntervalMs: [5000, 600000],
      maxTotalNodes: [100, 100000],
      maxTotalEdges: [200, 200000],
      maxCollectPerPass: [10, 1000],
      maxStaleAgeMs: [60000, 86400000],
      monitorIntervalMs: [1000, 60000],
      historyRetention: [10, 1000],
      heapWarningRatio: [0.1, 1.0],
      heapCriticalRatio: [0.1, 1.0],
      rssCriticalBytes: [100 * 1024 * 1024, 64 * 1024 * 1024 * 1024],
      maxChildProcesses: [1, 100],
      maxTraversalDepth: [1, 10],
      maxScopeNodes: [1, 50],
      staleBatchSize: [1, 500],
      staleDetectionIntervalMs: [5000, 600000],
    };

    const range = ranges[key];
    if (range) {
      return Math.max(range[0], Math.min(range[1], num));
    }
    return num;
  }

  private notifyAll(): void {
    for (const listener of this.listeners) {
      try { listener("_reset", null, this.config); } catch { /* */ }
    }
  }

  /**
   * Deep-merge `override` onto `base` (objects merged recursively, arrays and
   * scalars replaced). Accepts arbitrary-depth partials — this is what the
   * constructor (PartialDynamicConfig) and presets actually pass.
   */
  private deepMerge<T extends Record<string, any>>(base: T, override: DeepPartial<T>): T {
    const result = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        (result as any)[k] = this.deepMerge((result as any)[k] || {}, v);
      } else if (v !== undefined) {
        (result as any)[k] = v;
      }
    }
    return result;
  }
}

// ─── Convenience: Singleton ──────────────────────────────────

let defaultConfigInstance: DynamicConfigManager | null = null;

/** Get or create the default DynamicConfigManager singleton */
export function getDynamicConfig(
  config?: Partial<DynamicConfig> & { preset?: PresetName },
): DynamicConfigManager {
  if (!defaultConfigInstance) {
    defaultConfigInstance = new DynamicConfigManager(config);
  }
  return defaultConfigInstance;
}

/** Reset the singleton (for testing) */
export function resetDynamicConfig(): void {
  defaultConfigInstance = null;
}
