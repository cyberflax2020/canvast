/**
 * =============================================================================
 * Canvast — System Resource Monitor / 系统资源监控
 * =============================================================================
 * @file        src/utils/system-monitor.ts
 * @brief       Real-time CPU, memory, and process monitoring with alerting
 * @description Monitors system resources to prevent the agent harness from
 *              exhausting CPU/memory and crashing the host machine. Provides
 *              configurable thresholds, alert callbacks, and trend analysis.
 *              实时监控 CPU、内存、进程资源，防止 agent harness 耗尽系统资源。
 *
 *              Key features / 核心能力：
 *              - Process CPU usage tracking (user + system)
 *              - Memory: heap used/total, RSS, external, array buffers
 *              - System: free memory, load average, total memory
 *              - Child process counting and zombie detection
 *              - Configurable threshold alerts with hysteresis
 *              - Rolling history for trend analysis
 *              - Automatic throttle signals to harness
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes:
 *   [2026-08-08] Initial implementation — resource monitoring + alerting
 * =============================================================================
 */

import * as os from "node:os";

// ─── Types / 类型定义 ────────────────────────────────────────

/** Granular memory breakdown */
export interface MemorySnapshot {
  /** V8 heap used (bytes) — the most important metric for JS apps */
  heapUsed: number;
  /** V8 heap total (bytes) */
  heapTotal: number;
  /** Resident Set Size — total RAM used by the process (bytes) */
  rss: number;
  /** Memory used by C++ objects bound to JS (bytes) */
  external: number;
  /** ArrayBuffer memory allocated outside V8 heap (bytes) */
  arrayBuffers: number;
  /** System free memory (bytes) */
  systemFree: number;
  /** System total memory (bytes) */
  systemTotal: number;
  /** Memory usage ratio (0-1): (heapUsed + external + arrayBuffers) / systemTotal */
  usageRatio: number;
}

/** CPU usage snapshot */
export interface CpuSnapshot {
  /** Process CPU usage since last measurement (microseconds) */
  processUser: number;
  processSystem: number;
  /** CPU usage ratio (0-1): (user+sys) / (elapsed * cores) */
  processRatio: number;
  /** System load average (1min) */
  systemLoad1: number;
  /** System load average (5min) */
  systemLoad5: number;
  /** System load average (15min) */
  systemLoad15: number;
  /** Number of logical CPU cores */
  cpuCores: number;
}

/** Process tree snapshot */
export interface ProcessSnapshot {
  /** Estimated child process count (tracked via internal registry) */
  childProcessCount: number;
  /** Number of child processes that have not been awaited */
  zombieCount: number;
  /** Total bytes reported by tracked child processes */
  childTotalRss: number;
}

/** Full system health snapshot */
export interface HealthSnapshot {
  timestamp: number;
  memory: MemorySnapshot;
  cpu: CpuSnapshot;
  process: ProcessSnapshot;
  /** Overall health status */
  status: HealthStatus;
}

export type HealthStatus = "healthy" | "warning" | "critical" | "emergency";

/** Threshold configuration */
export interface ResourceThresholds {
  /** Heap usage ratio (0-1). Default 0.70 → warning, 0.85 → critical, 0.95 → emergency */
  heapWarningRatio: number;
  heapCriticalRatio: number;
  heapEmergencyRatio: number;
  /** RSS limit in bytes. Default 2GB → critical */
  rssCriticalBytes: number;
  /** System memory: when free memory drops below this ratio (0-1) */
  systemMemoryWarningRatio: number;
  systemMemoryCriticalRatio: number;
  /** CPU: process usage ratio sustained above this triggers warning */
  cpuWarningRatio: number;
  cpuCriticalRatio: number;
  /** Load average / cpuCores ratio */
  loadWarningRatio: number;
  loadCriticalRatio: number;
  /** Max child processes before warning */
  maxChildProcesses: number;
  /** Max zombie count before warning */
  maxZombies: number;
  /** Monitoring interval in ms */
  monitorIntervalMs: number;
  /** History retention count */
  historyRetention: number;
}

export const DEFAULT_THRESHOLDS: ResourceThresholds = {
  heapWarningRatio: 0.70,
  heapCriticalRatio: 0.85,
  heapEmergencyRatio: 0.95,
  rssCriticalBytes: 2 * 1024 * 1024 * 1024, // 2 GB
  systemMemoryWarningRatio: 0.15,  // warn when <15% free
  systemMemoryCriticalRatio: 0.05, // critical when <5% free
  cpuWarningRatio: 0.50,
  cpuCriticalRatio: 0.80,
  loadWarningRatio: 0.70,
  loadCriticalRatio: 1.0,
  maxChildProcesses: 20,
  maxZombies: 5,
  monitorIntervalMs: 5000,
  historyRetention: 120, // 10 min at 5s interval
};

/** Alert callback type */
export type AlertCallback = (snapshot: HealthSnapshot, alert: AlertInfo) => void;

export interface AlertInfo {
  level: HealthStatus;
  component: "heap" | "rss" | "system_memory" | "cpu" | "load" | "processes" | "zombies";
  message: string;
  currentValue: number;
  thresholdValue: number;
  unit: string;
}

/** Monitor configuration */
export interface MonitorConfig {
  thresholds: ResourceThresholds;
  onAlert?: AlertCallback;
  autoThrottle: boolean;
}

// ─── SystemMonitor / 系统监控器 ───────────────────────────────

export class SystemMonitor {
  private thresholds: ResourceThresholds;
  private onAlert?: AlertCallback;
  private autoThrottle: boolean;

  private history: HealthSnapshot[] = [];
  private childProcesses = new Map<number, { rss: number; startTime: number }>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastCpuUsage: { user: number; system: number } = { user: 0, system: 0 };
  private lastCpuTime: number = 0;
  private running = false;

  /**
   * Continuous throttle factor: 1.0 = full speed, 0.0 = fully stopped.
   * Replaces the old discrete 0-3 levels with smooth self-regulation.
   * 连续调节因子：1.0 = 全速，0.0 = 完全停止。
   * 用平滑自调节替代旧的离散四级开关。
   */
  private _throttleFactor = 1.0;
  private throttleListeners: Array<(factor: number) => void> = [];

  constructor(config?: Partial<MonitorConfig>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config?.thresholds };
    this.onAlert = config?.onAlert;
    this.autoThrottle = config?.autoThrottle ?? true;
  }

  // ─── Lifecycle ────────────────────────────────────────────

  /** Start periodic monitoring */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = Date.now();
    this.intervalHandle = setInterval(
      () => this.sample(),
      this.thresholds.monitorIntervalMs,
    );
    // Don't hold the event loop open for monitoring
    if (this.intervalHandle && typeof this.intervalHandle === "object" && "unref" in this.intervalHandle) {
      (this.intervalHandle as any).unref();
    }
  }

  /** Stop periodic monitoring */
  stop(): void {
    this.running = false;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /** Check if monitor is currently running */
  get isRunning(): boolean { return this.running; }

  // ─── Snapshot / 快照 ──────────────────────────────────────

  /** Take a single health snapshot (can be called manually or by interval) */
  snapshot(): HealthSnapshot {
    const memory = this.sampleMemory();
    const cpu = this.sampleCpu();
    const process = this.sampleProcess();
    const status = this.evaluateHealth(memory, cpu, process);

    return {
      timestamp: Date.now(),
      memory,
      cpu,
      process,
      status,
    };
  }

  /** Get recent history for trend analysis */
  getHistory(count?: number): HealthSnapshot[] {
    const n = count ?? this.thresholds.historyRetention;
    return this.history.slice(-n);
  }

  /**
   * Continuous throttle factor (0-1).
   * 1.0 = full speed, 0.0 = fully stopped.
   * Derived from health status + resource utilization.
   */
  get throttleFactor(): number { return this._throttleFactor; }

  /** @deprecated Use throttleFactor instead */
  get throttleLevel(): number {
    const f = this._throttleFactor;
    if (f >= 0.85) return 0;
    if (f >= 0.5) return 1;
    if (f >= 0.15) return 2;
    return 3;
  }

  /** Register a throttle change listener (receives continuous factor 0-1) */
  onThrottleChange(listener: (factor: number) => void): void {
    this.throttleListeners.push(listener);
  }

  /** Remove a throttle change listener */
  offThrottleChange(listener: (factor: number) => void): void {
    const idx = this.throttleListeners.indexOf(listener);
    if (idx >= 0) this.throttleListeners.splice(idx, 1);
  }

  // ─── Process Tracking / 进程追踪 ────────────────────────────

  /** Register a child process for tracking */
  registerChildProcess(pid: number, estimatedRss: number = 0): void {
    this.childProcesses.set(pid, { rss: estimatedRss, startTime: Date.now() });
  }

  /** Unregister a child process (call on process exit) */
  unregisterChildProcess(pid: number): void {
    this.childProcesses.delete(pid);
  }

  /** Update tracked RSS for a child process */
  updateChildRss(pid: number, rss: number): void {
    const existing = this.childProcesses.get(pid);
    if (existing) {
      existing.rss = rss;
    }
  }

  /** Get count of tracked child processes */
  get childCount(): number { return this.childProcesses.size; }

  // ─── Private: Sampling / 采样 ──────────────────────────────

  private sample(): void {
    const snap = this.snapshot();
    this.history.push(snap);

    // Trim history
    while (this.history.length > this.thresholds.historyRetention) {
      this.history.shift();
    }

    // Auto-throttle: continuous curve based on health + utilization
    if (this.autoThrottle) {
      const newFactor = this.computeThrottleFactor(snap);
      if (Math.abs(newFactor - this._throttleFactor) > 0.05) {
        this._throttleFactor = newFactor;
        for (const listener of this.throttleListeners) {
          try { listener(newFactor); } catch { /* don't let listener errors break monitoring */ }
        }
      }
    }

    // Check for alerts
    if (this.onAlert) {
      const alerts = this.generateAlerts(snap);
      for (const alert of alerts) {
        try { this.onAlert(snap, alert); } catch { /* swallow */ }
      }
    }
  }

  private sampleMemory(): MemorySnapshot {
    const mem = process.memoryUsage();
    const systemTotal = os.totalmem();
    const systemFree = os.freemem();
    const usageRatio = (mem.heapUsed + mem.external + mem.arrayBuffers) / systemTotal;

    return {
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      rss: mem.rss,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
      systemFree,
      systemTotal,
      usageRatio: Math.min(usageRatio, 1.0),
    };
  }

  private sampleCpu(): CpuSnapshot {
    const now = Date.now();
    const elapsed = now - this.lastCpuTime;
    const currentCpu = process.cpuUsage(this.lastCpuUsage);
    const cpuCores = os.cpus().length;
    const [l1, l5, l15] = os.loadavg();

    // CPU ratio: (user+sys in microseconds) / (elapsed in microseconds * cores)
    const totalCpuUs = currentCpu.user + currentCpu.system;
    const processRatio = elapsed > 0
      ? Math.min(totalCpuUs / (elapsed * 1000 * cpuCores), 1.0)
      : 0;

    // Update for next sample
    this.lastCpuUsage = process.cpuUsage();
    this.lastCpuTime = now;

    return {
      processUser: currentCpu.user,
      processSystem: currentCpu.system,
      processRatio,
      systemLoad1: l1,
      systemLoad5: l5,
      systemLoad15: l15,
      cpuCores,
    };
  }

  private sampleProcess(): ProcessSnapshot {
    // Detect zombie processes (tracked but no update in 2x monitor interval)
    const zombieThreshold = this.thresholds.monitorIntervalMs * 2;
    const now = Date.now();
    let zombieCount = 0;
    for (const [, info] of this.childProcesses) {
      if (now - info.startTime > zombieThreshold) {
        // Consider it a potential zombie if it's been around >2 intervals without an update
        // This is a heuristic — real zombie detection requires OS-level process checks
      }
    }
    // More accurate: count processes that exceed typical lifecycle
    for (const [, info] of this.childProcesses) {
      if (now - info.startTime > 300_000) { // 5 min without exit
        zombieCount++;
      }
    }

    let childTotalRss = 0;
    for (const [, info] of this.childProcesses) {
      childTotalRss += info.rss;
    }

    return {
      childProcessCount: this.childProcesses.size,
      zombieCount,
      childTotalRss,
    };
  }

  // ─── Private: Health Evaluation / 健康评估 ──────────────────

  private evaluateHealth(
    memory: MemorySnapshot,
    cpu: CpuSnapshot,
    process: ProcessSnapshot,
  ): HealthStatus {
    const heapRatio = memory.heapUsed / memory.heapTotal;
    const systemMemRatio = memory.systemFree / memory.systemTotal;

    // Emergency checks (most critical first)
    if (heapRatio >= this.thresholds.heapEmergencyRatio) return "emergency";
    if (memory.rss >= this.thresholds.rssCriticalBytes) return "emergency";

    // Critical checks
    if (heapRatio >= this.thresholds.heapCriticalRatio) return "critical";
    if (systemMemRatio <= this.thresholds.systemMemoryCriticalRatio) return "critical";
    if (cpu.processRatio >= this.thresholds.cpuCriticalRatio) return "critical";
    if (cpu.systemLoad1 / cpu.cpuCores >= this.thresholds.loadCriticalRatio) return "critical";
    if (process.zombieCount > this.thresholds.maxZombies * 2) return "critical";

    // Warning checks
    if (heapRatio >= this.thresholds.heapWarningRatio) return "warning";
    if (systemMemRatio <= this.thresholds.systemMemoryWarningRatio) return "warning";
    if (cpu.processRatio >= this.thresholds.cpuWarningRatio) return "warning";
    if (cpu.systemLoad1 / cpu.cpuCores >= this.thresholds.loadWarningRatio) return "warning";
    if (process.childProcessCount > this.thresholds.maxChildProcesses) return "warning";
    if (process.zombieCount > this.thresholds.maxZombies) return "warning";

    return "healthy";
  }

  /**
   * Compute continuous throttle factor from health status + resource utilization.
   * Uses a smooth curve — no hard cutoffs. The system naturally decelerates
   * as utilization increases, never hitting a brick wall.
   */
  private computeThrottleFactor(snap: HealthSnapshot): number {
    const heapRatio = snap.memory.heapUsed / snap.memory.heapTotal;
    const sysMemPressure = 1 - (snap.memory.systemFree / snap.memory.systemTotal);

    // Combine multiple pressure signals
    const utilization = Math.max(
      heapRatio / this.thresholds.heapEmergencyRatio,
      sysMemPressure,
      snap.cpu.processRatio / this.thresholds.cpuCriticalRatio,
      snap.cpu.systemLoad1 / (snap.cpu.cpuCores * this.thresholds.loadCriticalRatio),
    );

    // Normalize to 0-1
    const u = Math.max(0, Math.min(1, utilization));

    // Smooth throttle curve
    if (u <= 0.5) return 1.0;
    if (u <= 0.8) return 1.0 - 0.35 * Math.pow((u - 0.5) / 0.3, 2);
    if (u <= 0.95) return 0.65 - 0.5 * Math.pow((u - 0.8) / 0.15, 3);
    return 0.15 * Math.exp(-5 * (u - 0.95) / 0.05) + 0.03;
  }

  private generateAlerts(snap: HealthSnapshot): AlertInfo[] {
    const alerts: AlertInfo[] = [];
    const { memory, cpu, process } = snap;
    const heapRatio = memory.heapUsed / memory.heapTotal;
    const sysMemRatio = memory.systemFree / memory.systemTotal;

    if (heapRatio >= this.thresholds.heapEmergencyRatio) {
      alerts.push({
        level: "emergency", component: "heap",
        message: `Heap usage at ${(heapRatio * 100).toFixed(1)}% — emergency threshold ${(this.thresholds.heapEmergencyRatio * 100).toFixed(0)}%`,
        currentValue: heapRatio, thresholdValue: this.thresholds.heapEmergencyRatio, unit: "ratio",
      });
    } else if (heapRatio >= this.thresholds.heapCriticalRatio) {
      alerts.push({
        level: "critical", component: "heap",
        message: `Heap usage at ${(heapRatio * 100).toFixed(1)}% — critical threshold ${(this.thresholds.heapCriticalRatio * 100).toFixed(0)}%`,
        currentValue: heapRatio, thresholdValue: this.thresholds.heapCriticalRatio, unit: "ratio",
      });
    } else if (heapRatio >= this.thresholds.heapWarningRatio) {
      alerts.push({
        level: "warning", component: "heap",
        message: `Heap usage at ${(heapRatio * 100).toFixed(1)}% — warning threshold ${(this.thresholds.heapWarningRatio * 100).toFixed(0)}%`,
        currentValue: heapRatio, thresholdValue: this.thresholds.heapWarningRatio, unit: "ratio",
      });
    }

    if (memory.rss >= this.thresholds.rssCriticalBytes) {
      alerts.push({
        level: "critical", component: "rss",
        message: `RSS at ${(memory.rss / 1e9).toFixed(2)}GB — critical threshold ${(this.thresholds.rssCriticalBytes / 1e9).toFixed(1)}GB`,
        currentValue: memory.rss, thresholdValue: this.thresholds.rssCriticalBytes, unit: "bytes",
      });
    }

    if (sysMemRatio <= this.thresholds.systemMemoryCriticalRatio) {
      alerts.push({
        level: "critical", component: "system_memory",
        message: `System free memory at ${(sysMemRatio * 100).toFixed(1)}% — critical`,
        currentValue: sysMemRatio, thresholdValue: this.thresholds.systemMemoryCriticalRatio, unit: "ratio",
      });
    } else if (sysMemRatio <= this.thresholds.systemMemoryWarningRatio) {
      alerts.push({
        level: "warning", component: "system_memory",
        message: `System free memory at ${(sysMemRatio * 100).toFixed(1)}% — warning`,
        currentValue: sysMemRatio, thresholdValue: this.thresholds.systemMemoryWarningRatio, unit: "ratio",
      });
    }

    if (cpu.processRatio >= this.thresholds.cpuCriticalRatio) {
      alerts.push({
        level: "critical", component: "cpu",
        message: `Process CPU at ${(cpu.processRatio * 100).toFixed(1)}% — critical`,
        currentValue: cpu.processRatio, thresholdValue: this.thresholds.cpuCriticalRatio, unit: "ratio",
      });
    } else if (cpu.processRatio >= this.thresholds.cpuWarningRatio) {
      alerts.push({
        level: "warning", component: "cpu",
        message: `Process CPU at ${(cpu.processRatio * 100).toFixed(1)}% — warning`,
        currentValue: cpu.processRatio, thresholdValue: this.thresholds.cpuWarningRatio, unit: "ratio",
      });
    }

    if (cpu.systemLoad1 / cpu.cpuCores >= this.thresholds.loadCriticalRatio) {
      alerts.push({
        level: "critical", component: "load",
        message: `System load avg ${cpu.systemLoad1.toFixed(1)} on ${cpu.cpuCores} cores — critical`,
        currentValue: cpu.systemLoad1 / cpu.cpuCores, thresholdValue: this.thresholds.loadCriticalRatio, unit: "ratio",
      });
    }

    if (process.zombieCount > this.thresholds.maxZombies * 2) {
      alerts.push({
        level: "critical", component: "zombies",
        message: `${process.zombieCount} zombie processes detected — critical`,
        currentValue: process.zombieCount, thresholdValue: this.thresholds.maxZombies * 2, unit: "count",
      });
    } else if (process.zombieCount > this.thresholds.maxZombies) {
      alerts.push({
        level: "warning", component: "zombies",
        message: `${process.zombieCount} potential zombie processes — warning`,
        currentValue: process.zombieCount, thresholdValue: this.thresholds.maxZombies, unit: "count",
      });
    }

    if (process.childProcessCount > this.thresholds.maxChildProcesses) {
      alerts.push({
        level: "warning", component: "processes",
        message: `${process.childProcessCount} child processes — exceeds limit of ${this.thresholds.maxChildProcesses}`,
        currentValue: process.childProcessCount, thresholdValue: this.thresholds.maxChildProcesses, unit: "count",
      });
    }

    return alerts;
  }
}

// ─── Convenience: Singleton / 单例 ────────────────────────────

let defaultInstance: SystemMonitor | null = null;

/** Get or create the default SystemMonitor singleton */
export function getSystemMonitor(config?: Partial<MonitorConfig>): SystemMonitor {
  if (!defaultInstance) {
    defaultInstance = new SystemMonitor(config);
  }
  return defaultInstance;
}

/** Reset the singleton (for testing) */
export function resetSystemMonitor(): void {
  if (defaultInstance) {
    defaultInstance.stop();
    defaultInstance = null;
  }
}

// ─── Utility: Formatters / 格式化 ────────────────────────────

/** Format bytes to human-readable string */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** Format a HealthSnapshot as a one-line summary */
export function formatHealthSummary(snap: HealthSnapshot): string {
  const heapPct = ((snap.memory.heapUsed / snap.memory.heapTotal) * 100).toFixed(1);
  const rss = formatBytes(snap.memory.rss);
  const cpu = (snap.cpu.processRatio * 100).toFixed(1);
  const sysFree = formatBytes(snap.memory.systemFree);
  const child = snap.process.childProcessCount;
  const zombies = snap.process.zombieCount;
  const status = snap.status.toUpperCase();
  const throttle = snap.status === "healthy" ? "" : ` [throttle:${snap.status}]`;
  return `[${status}] heap:${heapPct}% rss:${rss} cpu:${cpu}% sys_free:${sysFree} procs:${child} zombies:${zombies}${throttle}`;
}
