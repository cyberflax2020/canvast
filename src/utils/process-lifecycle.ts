/**
 * =============================================================================
 * Canvast — Process Lifecycle Manager / 进程生命周期管理
 * =============================================================================
 * @file        src/utils/process-lifecycle.ts
 * @brief       Prevents process and memory leaks through lifecycle management
 * @description Tracks all child processes spawned by the agent harness, enforces
 *              timeouts, detects zombies, provides graceful shutdown, and
 *              accounts for resource usage per process. Prevents the catastrophic
 *              resource exhaustion that occurs when sub-agents leak.
 *              防止进程和内存泄漏的生命周期管理器。
 *
 *              Key features / 核心能力：
 *              - Process registry: every spawned process is tracked by PID
 *              - Timeout enforcement: auto SIGTERM → SIGKILL after deadline
 *              - Graceful shutdown: coordinated teardown of all children
 *              - Zombie detection: polling-based detection of stale processes
 *              - Resource accounting: per-process RSS, CPU time tracking
 *              - Concurrency limits: refuse spawns when at capacity
 *              - Process groups: cleanup related processes together
 *              - Leak detection: alert when process count trends upward
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation
 * =============================================================================
 */

import { spawn } from "node:child_process";

import {
  captureProcessIdentity,
  processExists,
  processTreeGone,
  signalProcessGroupVerified,
  type ProcessStartIdentity,
} from "./bounded-lifecycle.js";
import { type SystemMonitor } from "./system-monitor.js";
import {
  getOwnedHandleRegistry,
  type OwnedHandleLease,
} from "./owned-handle-registry.js";
import { PROCESS_SNAPSHOT_SOURCE } from "../../scripts/process-snapshot-client.mjs";

// ─── Types / 类型定义 ────────────────────────────────────────

/** Process state */
export type ProcessState =
  | "spawning"   // process is starting
  | "running"    // process is active
  | "completing" // received terminate signal, waiting
  | "killing"    // SIGKILL sent, awaiting confirmed disappearance
  | "exited"     // process has ended
  | "killed"     // force-killed due to timeout
  | "cancelled"  // cancellation terminal latched by an owning workflow
  | "timeout"    // timeout terminal latched by an owning workflow
  | "cleanup_failed" // bounded confirmation expired; outcome remains unknown
  | "zombie";    // suspected leaked (no exit event but appears dead)

/** Tracked process entry */
export interface TrackedProcess {
  pid: number;
  groupId: string;          // logical group (e.g., "subagents", "bash", "mcp")
  taskId: string;           // associated task or agent ID
  state: ProcessState;
  spawnedAt: number;        // Date.now()
  timeoutMs: number;        // kill after this duration
  lastHeartbeat: number;    // last time we confirmed it's alive
  exitCode: number | null;
  rssBytes: number;         // last known RSS (0 if unknown)
  cpuUserUs: number;        // CPU user time in microseconds
  signalSent: boolean;      // whether SIGTERM has been sent
  timedOut?: boolean;       // whether the lifecycle timeout fired
  forceKilledAt?: number;   // when SIGKILL was sent
  cleanupFailure?: string;  // explicit failure when disappearance is unconfirmed
  outcomeUnknown: boolean;  // true when bounded OS cleanup could not be confirmed
  startIdentity?: ProcessStartIdentity; // PID/start binding captured at spawn
}

/** Configuration for process lifecycle manager */
export interface ProcessLifecycleConfig {
  /** Default timeout for processes (ms) */
  defaultTimeoutMs: number;
  /** Grace period after SIGTERM before SIGKILL (ms) */
  gracePeriodMs: number;
  /** Bounded wait after SIGKILL for close or PID/PGID disappearance (ms) */
  killConfirmationMs: number;
  /** Max total tracked processes */
  maxTotalProcesses: number;
  /** Max processes per group */
  maxPerGroup: number;
  /** Zombie check interval (ms) */
  zombieCheckIntervalMs: number;
  /** Process considered zombie after no heartbeat for this long (ms) */
  zombieThresholdMs: number;
  /** Whether to force-kill all children on shutdown */
  killAllOnShutdown: boolean;
  /** Verbose logging */
  verbose: boolean;
}

export const DEFAULT_PROCESS_CONFIG: ProcessLifecycleConfig = {
  defaultTimeoutMs: 300_000,  // 5 minutes
  gracePeriodMs: 10_000,      // 10 seconds grace
  killConfirmationMs: 1_000,
  maxTotalProcesses: 50,
  maxPerGroup: 25,
  zombieCheckIntervalMs: 30_000,
  zombieThresholdMs: 120_000, // 2 min without heartbeat
  killAllOnShutdown: true,
  verbose: false,
};

/** Events emitted by process lifecycle manager */
export interface ProcessLifecycleEvents {
  onSpawn?: (proc: TrackedProcess) => void;
  onExit?: (proc: TrackedProcess) => void;
  onTimeout?: (proc: TrackedProcess) => void;
  onForceKill?: (proc: TrackedProcess) => void;
  onCleanupFailure?: (proc: TrackedProcess) => void;
  onZombie?: (proc: TrackedProcess) => void;
  onLimitReached?: (group: string, current: number, max: number) => void;
}

/** Statistics */
export interface ProcessLifecycleStats {
  totalSpawned: number;
  totalExited: number;
  totalTimedOut: number;
  totalKilled: number;
  totalZombiesDetected: number;
  currentAlive: number;
  peakAlive: number;
}

// ─── ProcessLifecycleManager ──────────────────────────────────

export class ProcessLifecycleManager {
  private config: ProcessLifecycleConfig;
  private processes = new Map<number, TrackedProcess>();
  private events: ProcessLifecycleEvents;
  private zombieInterval: ReturnType<typeof setInterval> | null = null;
  private timeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private terminationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private killConfirmationTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private terminationPromises = new Map<number, Promise<void>>();
  private terminationResolvers = new Map<number, () => void>();
  private terminalListeners = new Map<number, Set<(proc: TrackedProcess) => void>>();
  private ownedHandles = new Map<TrackedProcess, OwnedHandleLease>();
  private monitor: SystemMonitor | null = null;
  private isShuttingDown = false;

  // Statistics
  private statsData: ProcessLifecycleStats = {
    totalSpawned: 0, totalExited: 0, totalTimedOut: 0,
    totalKilled: 0, totalZombiesDetected: 0,
    currentAlive: 0, peakAlive: 0,
  };

  constructor(config?: Partial<ProcessLifecycleConfig>, events?: ProcessLifecycleEvents) {
    this.config = { ...DEFAULT_PROCESS_CONFIG, ...config };
    this.events = events ?? {};
  }

  // ─── Lifecycle / 生命周期 ──────────────────────────────────

  /** Start zombie detection loop */
  start(): void {
    if (this.zombieInterval !== null) return;
    this.isShuttingDown = false;
    if (this.config.zombieCheckIntervalMs <= 0) return;
    this.zombieInterval = setInterval(
      () => this.detectZombies(),
      this.config.zombieCheckIntervalMs,
    );
    if ("unref" in this.zombieInterval) {
      (this.zombieInterval as any).unref();
    }
  }

  /** Stop zombie detection loop without killing processes */
  stop(): void {
    if (this.zombieInterval !== null) {
      clearInterval(this.zombieInterval);
      this.zombieInterval = null;
    }
  }

  /** Stop zombie detection and optionally kill all children */
  async shutdown(killAll: boolean = this.config.killAllOnShutdown): Promise<void> {
    this.isShuttingDown = true;
    const ownership = killAll
      ? Array.from(this.processes.entries())
          .filter(([, proc]) => !isTerminal(proc.state))
          .map(([pid]) => new Promise<void>((resolve) => { this.onTerminal(pid, () => resolve()); }))
      : [];

    if (this.zombieInterval !== null) {
      clearInterval(this.zombieInterval);
      this.zombieInterval = null;
    }

    // Clear all timeout timers
    for (const [pid, timer] of this.timeoutTimers) {
      clearTimeout(timer);
      this.timeoutTimers.delete(pid);
    }

    if (killAll) {
      await this.killAll("SIGTERM", "shutdown");
      await Promise.allSettled(ownership);
    }

    // shutdown(false) stops manager-owned timers only. Live children remain
    // tracked until their real close event so spawnTracked callers keep their
    // streams and never observe a synthetic terminal result.
  }

  // ─── Process Registration / 进程注册 ─────────────────────────

  /**
   * Register a new child process for tracking.
   * @returns the TrackedProcess entry, or null if at capacity
   */
  register(
    pid: number,
    groupId: string,
    taskId: string,
    timeoutMs?: number,
  ): TrackedProcess | null {
    const existing = this.processes.get(pid);
    if (existing && !isTerminal(existing.state)) return null;
    if (!this.hasCapacity(groupId)) {
      // Refuse new processes during shutdown
      return null;
    }

    const now = Date.now();
    const proc: TrackedProcess = {
      pid,
      groupId,
      taskId,
      state: "spawning",
      spawnedAt: now,
      timeoutMs: timeoutMs ?? this.config.defaultTimeoutMs,
      lastHeartbeat: now,
      exitCode: null,
      rssBytes: 0,
      cpuUserUs: 0,
      signalSent: false,
      timedOut: false,
      outcomeUnknown: false,
      startIdentity: captureProcessIdentity(pid),
    };

    this.processes.set(pid, proc);
    this.registerOwnedProcess(proc);
    this.statsData.totalSpawned++;
    this.statsData.currentAlive = this.countAlive();
    this.statsData.peakAlive = Math.max(this.statsData.peakAlive, this.statsData.currentAlive);

    // Register with system monitor
    if (this.monitor) {
      this.monitor.registerChildProcess(pid, 0);
    }

    // Set timeout
    const timer = setTimeout(() => this.handleTimeout(pid, proc), proc.timeoutMs);
    if ("unref" in timer) (timer as any).unref();
    this.timeoutTimers.set(pid, timer);

    this.emitSafely("onSpawn", proc);
    if (this.config.verbose) {
      console.error(`[proc-lifecycle] registered pid=${pid} group=${groupId} task=${taskId}`);
    }

    return proc;
  }

  /** Mark a process as running (call after successful spawn confirmation) */
  markRunning(pid: number): void {
    const proc = this.processes.get(pid);
    if (proc && proc.state === "spawning") {
      proc.state = "running";
      proc.lastHeartbeat = Date.now();
      proc.startIdentity ??= captureProcessIdentity(pid);
      this.registerOwnedProcess(proc);
    }
  }

  /** Update heartbeat for a live process */
  heartbeat(pid: number, rssBytes?: number): void {
    const proc = this.processes.get(pid);
    if (proc) {
      proc.lastHeartbeat = Date.now();
      if (rssBytes !== undefined) {
        proc.rssBytes = rssBytes;
        if (this.monitor) this.monitor.updateChildRss(pid, rssBytes);
      }
    }
  }

  /** Mark a process as exited normally */
  markExited(pid: number, exitCode: number | null, expected?: TrackedProcess): void {
    const proc = this.processes.get(pid);
    if (expected && proc !== expected) return;
    if (!proc || isTerminal(proc.state)) return;

    proc.state = "exited";
    proc.exitCode = exitCode;
    proc.outcomeUnknown = false;
    proc.lastHeartbeat = Date.now();

    // Cleanup
    this.cleanup(pid, proc);
    this.emitSafely("onExit", proc);
  }

  /** Mark a process as completing (signal sent, awaiting exit) */
  markCompleting(pid: number): void {
    const proc = this.processes.get(pid);
    if (proc && !isTerminal(proc.state)) {
      proc.state = "completing";
      proc.signalSent = true;
      proc.lastHeartbeat = Date.now();
      this.ownedHandles.get(proc)?.markSettling();
    }
  }

  // ─── Timeout & Kill / 超时和终止 ────────────────────────────

  /**
   * Send SIGTERM to a process, then SIGKILL after grace period.
   */
  async terminate(pid: number): Promise<void> {
    const proc = this.processes.get(pid);
    if (!proc || isTerminal(proc.state)) return;
    const pending = this.terminationPromises.get(pid);
    if (pending) return pending;

    let resolveTermination!: () => void;
    const termination = new Promise<void>((resolve) => { resolveTermination = resolve; });
    this.terminationPromises.set(pid, termination);
    this.terminationResolvers.set(pid, resolveTermination);

    proc.signalSent = true;
    proc.state = "completing";
    this.ownedHandles.get(proc)?.markSettling();
    proc.cleanupFailure = undefined;
    proc.outcomeUnknown = false;

    const signalResult = this.signalTrackedProcess(proc, "SIGTERM");
    if (signalResult === "gone") {
      proc.state = "exited";
      proc.exitCode = -1;
      proc.outcomeUnknown = false;
      this.cleanup(pid, proc);
      this.emitSafely("onExit", proc);
      return termination;
    }
    if (signalResult !== "sent") {
      this.recordLocalCleanupFailure(
        pid,
        proc,
        `SIGTERM fail-closed for PID/PGID ${pid}: ${describeSignalFailure(signalResult)}`,
      );
      return termination;
    }

    // Wait grace period, then SIGKILL
    const timer = setTimeout(() => void this.forceKill(pid), this.config.gracePeriodMs);
    timer.unref?.();
    this.terminationTimers.set(pid, timer);
    return termination;
  }

  /** Force-kill a process with SIGKILL */
  forceKill(pid: number): Promise<void> {
    const proc = this.processes.get(pid);
    if (!proc || isTerminal(proc.state)) return Promise.resolve();
    const pending = this.terminationPromises.get(pid);
    if (proc.state === "killing" && pending) return pending;

    let termination = pending;
    if (!termination) {
      let resolveTermination!: () => void;
      termination = new Promise<void>((resolve) => { resolveTermination = resolve; });
      this.terminationPromises.set(pid, termination);
      this.terminationResolvers.set(pid, resolveTermination);
    }

    const signalResult = this.signalTrackedProcess(proc, "SIGKILL");
    if (signalResult !== "sent" && signalResult !== "gone") {
      this.recordLocalCleanupFailure(
        pid,
        proc,
        `SIGKILL fail-closed for PID/PGID ${pid}: ${describeSignalFailure(signalResult)}`,
      );
      return termination;
    }

    proc.state = "killing";
    this.ownedHandles.get(proc)?.markSettling();
    proc.cleanupFailure = undefined;
    proc.outcomeUnknown = false;
    if (proc.forceKilledAt === undefined) {
      proc.forceKilledAt = Date.now();
      this.statsData.totalKilled++;
      this.emitSafely("onForceKill", proc);
    }
    if (this.processes.get(pid) !== proc || proc.state !== "killing") return termination;
    if (signalResult === "gone" || processTreeGone(pid)) {
      this.confirmKilled(pid, proc);
      return termination;
    }

    const previous = this.killConfirmationTimers.get(pid);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => this.confirmKillOrRecordFailure(pid, proc),
      this.config.killConfirmationMs,
    );
    timer.unref?.();
    this.killConfirmationTimers.set(pid, timer);
    return termination;
  }

  /** Kill all tracked processes in a group */
  async killGroup(groupId: string, signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [pid, proc] of this.processes) {
      if (proc.groupId === groupId && !isTerminal(proc.state)) {
        if (signal === "SIGKILL") {
          promises.push(this.forceKill(pid));
        } else {
          promises.push(this.terminate(pid));
        }
      }
    }
    await Promise.allSettled(promises);
  }

  /** Kill all tracked processes */
  async killAll(signal: NodeJS.Signals = "SIGTERM", reason: string = "shutdown"): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [pid, proc] of this.processes) {
      if (!isTerminal(proc.state)) {
        if (signal === "SIGKILL") {
          promises.push(this.forceKill(pid));
        } else {
          promises.push(this.terminate(pid));
        }
      }
    }
    await Promise.allSettled(promises);

    if (this.config.verbose) {
      console.error(`[proc-lifecycle] killAll(${signal}, ${reason}): ${this.countAlive()} remaining`);
    }
  }

  // ─── Queries / 查询 ────────────────────────────────────────

  /** Get a tracked process by PID */
  get(pid: number): TrackedProcess | undefined {
    return this.processes.get(pid);
  }

  /** Get all tracked processes */
  getAll(): TrackedProcess[] {
    return Array.from(this.processes.values());
  }

  /** Get all processes in a group */
  getByGroup(groupId: string): TrackedProcess[] {
    return Array.from(this.processes.values())
      .filter(p => p.groupId === groupId);
  }

  /** Get all processes for a task */
  getByTask(taskId: string): TrackedProcess[] {
    return Array.from(this.processes.values())
      .filter(p => p.taskId === taskId);
  }

  /** Count alive processes */
  countAlive(): number {
    let count = 0;
    for (const p of this.processes.values()) {
      if (!isTerminal(p.state)) {
        count++;
      }
    }
    return count;
  }

  /** Count processes in a group */
  countByGroup(groupId: string): number {
    let count = 0;
    for (const p of this.processes.values()) {
      if (!isTerminal(p.state) &&
          p.groupId === groupId) {
        count++;
      }
    }
    return count;
  }

  /** Count processes by state */
  countByState(state: ProcessState): number {
    let count = 0;
    for (const p of this.processes.values()) {
      if (p.state === state) count++;
    }
    return count;
  }

  /** Get lifecycle statistics */
  get stats(): ProcessLifecycleStats { return { ...this.statsData }; }

  /** Get total tracked processes (including exited) */
  get totalTracked(): number { return this.processes.size; }

  /** Check if at capacity */
  get atCapacity(): boolean {
    return this.countAlive() >= this.config.maxTotalProcesses;
  }

  /** Get capacity utilization ratio (0-1) */
  get capacityUtilization(): number {
    return this.countAlive() / this.config.maxTotalProcesses;
  }

  /** Whether a process can be spawned and registered without creating it first. */
  hasCapacity(groupId: string): boolean {
    if (this.isShuttingDown || !getOwnedHandleRegistry().accepting("process-lifecycle")) return false;
    const alive = this.countAlive();
    if (alive >= this.config.maxTotalProcesses) {
      this.emitLimitSafely("_total", alive, this.config.maxTotalProcesses);
      return false;
    }
    const groupCount = this.countByGroup(groupId);
    if (groupCount >= this.config.maxPerGroup) {
      this.emitLimitSafely(groupId, groupCount, this.config.maxPerGroup);
      return false;
    }
    return true;
  }

  /** Register a one-shot listener for process terminal cleanup. */
  onTerminal(pid: number, listener: (proc: TrackedProcess) => void): () => void {
    const listeners = this.terminalListeners.get(pid) ?? new Set();
    listeners.add(listener);
    this.terminalListeners.set(pid, listeners);
    return () => {
      const current = this.terminalListeners.get(pid);
      current?.delete(listener);
      if (current?.size === 0) this.terminalListeners.delete(pid);
    };
  }

  // ─── Monitor Integration ───────────────────────────────────

  /** Attach a SystemMonitor for resource tracking */
  attachMonitor(monitor: SystemMonitor): void {
    if (this.monitor === monitor) return;
    const previous = this.monitor;
    for (const proc of this.processes.values()) {
      if (isTerminal(proc.state)) continue;
      previous?.unregisterChildProcess(proc.pid);
      monitor.registerChildProcess(proc.pid, proc.rssBytes);
    }
    this.monitor = monitor;
  }

  // ─── Leak Detection / 泄漏检测 ──────────────────────────────

  /**
   * Run leak detection analysis.
   * Returns suspected leaked processes. Silence alone is not evidence of a
   * zombie; output is not a process-liveness protocol.
   */
  detectLeaks(): TrackedProcess[] {
    const now = Date.now();
    const leaks: TrackedProcess[] = [];

    for (const [, proc] of this.processes) {
      if (isTerminal(proc.state) || proc.state === "zombie") continue;
      const totalRuntime = now - proc.spawnedAt;

      // Long-running: running for more than 10x timeout
      if (totalRuntime > proc.timeoutMs * 10 && proc.state === "running") {
        leaks.push(proc);
      }
    }

    return leaks;
  }

  // ─── Private ──────────────────────────────────────────────

  private handleTimeout(pid: number, expected?: TrackedProcess): void {
    const proc = this.processes.get(pid);
    if (!proc) return;
    if (expected && proc !== expected) return;
    if (isTerminal(proc.state)) return;

    proc.timedOut = true;
    this.statsData.totalTimedOut++;
    this.emitSafely("onTimeout", proc);

    if (this.config.verbose) {
      console.error(
        `[proc-lifecycle] timeout pid=${pid} group=${proc.groupId} ` +
        `runtime=${Date.now() - proc.spawnedAt}ms`,
      );
    }

    // Terminate (grace period then kill)
    this.terminate(pid).catch(() => {
      // If terminate fails, force kill
      this.forceKill(pid);
    });
  }

  private detectZombies(): void {
    const now = Date.now();
    for (const [pid, proc] of this.processes) {
      if (isTerminal(proc.state) || proc.state === "zombie" ||
          proc.state === "killing") continue;

      const timeSinceHeartbeat = now - proc.lastHeartbeat;

      // Check if process is still alive via OS
      if (timeSinceHeartbeat > this.config.zombieThresholdMs) {
        if (processExists(pid)) {
          // A silent process is still healthy when the OS confirms it exists.
          proc.lastHeartbeat = now;
        } else if (processExists(-pid)) {
          // The direct child disappeared but descendants remain in its group.
          proc.state = "zombie";
          this.statsData.totalZombiesDetected++;
          this.emitSafely("onZombie", proc);
          void this.forceKill(pid);
        } else {
          proc.state = "exited";
          proc.exitCode = -1;
          this.cleanup(pid, proc);
          this.emitSafely("onExit", proc);
        }
      }
    }
  }

  private confirmKillOrRecordFailure(pid: number, expected: TrackedProcess): void {
    this.killConfirmationTimers.delete(pid);
    if (this.processes.get(pid) !== expected) return;
    const status = this.inspectTrackedProcess(expected);
    if (status === "gone") {
      this.confirmKilled(pid, expected);
      return;
    }
    const reason = status === "identity_mismatch"
      ? `SIGKILL cleanup identity changed before final confirmation for PID/PGID ${pid}`
      : status === "unverifiable"
        ? `SIGKILL cleanup identity could not be verified for PID/PGID ${pid}`
        : `SIGKILL cleanup not confirmed for PID/PGID ${pid}`;
    this.recordLocalCleanupFailure(pid, expected, reason);
  }

  private confirmKilled(pid: number, expected: TrackedProcess): void {
    if (this.processes.get(pid) !== expected) return;
    expected.state = "killed";
    expected.cleanupFailure = undefined;
    expected.outcomeUnknown = false;
    this.cleanup(pid, expected);
  }

  private inspectTrackedProcess(
    expected: TrackedProcess,
  ): "gone" | "same_identity_alive" | "identity_mismatch" | "unverifiable" {
    if (processTreeGone(expected.pid)) return "gone";
    if (!expected.startIdentity) return "unverifiable";
    const currentIdentity = captureProcessIdentity(expected.pid);
    if (!currentIdentity) return processTreeGone(expected.pid) ? "gone" : "unverifiable";
    if (currentIdentity.startKey !== expected.startIdentity.startKey) return "identity_mismatch";
    return processTreeGone(expected.pid) ? "gone" : "same_identity_alive";
  }

  private cleanup(pid: number, expected: TrackedProcess): void {
    if (this.processes.get(pid) !== expected) return;

    // Clear timeout timer
    const timer = this.timeoutTimers.get(pid);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(pid);
    }

    // Unregister from system monitor
    if (this.monitor) {
      this.monitor.unregisterChildProcess(pid);
    }

    // Update stats
    this.finishTermination(pid);
    this.settleOwnedProcess(expected);

    if (expected.state === "exited") {
      this.statsData.totalExited++;
    } else if (expected.state === "killing") {
      expected.state = "killed";
      expected.cleanupFailure = undefined;
    }
    this.statsData.currentAlive = this.countAlive();

    // Preserve synchronous state inspection while releasing the registry before
    // the next task turn. Identity checking prevents stale PID cleanup races.
    queueMicrotask(() => {
      if (this.processes.get(pid) === expected) this.processes.delete(pid);
    });
    this.notifyTerminal(pid, expected);
  }

  private finishTermination(pid: number): void {
    const timer = this.terminationTimers.get(pid);
    if (timer) clearTimeout(timer);
    this.terminationTimers.delete(pid);
    const confirmation = this.killConfirmationTimers.get(pid);
    if (confirmation) clearTimeout(confirmation);
    this.killConfirmationTimers.delete(pid);
    const resolve = this.terminationResolvers.get(pid);
    this.terminationResolvers.delete(pid);
    this.terminationPromises.delete(pid);
    resolve?.();
  }

  private recordLocalCleanupFailure(pid: number, expected: TrackedProcess, reason: string): void {
    if (this.processes.get(pid) !== expected) return;
    expected.state = "cleanup_failed";
    expected.cleanupFailure = reason;
    expected.outcomeUnknown = true;
    this.cleanup(pid, expected);
    this.emitSafely("onCleanupFailure", expected);
  }

  private registerOwnedProcess(proc: TrackedProcess): void {
    if (this.ownedHandles.has(proc)) return;
    const identity = proc.startIdentity;
    if (!identity || identity.pgid <= 0 || !identity.birth) return;
    try {
      this.ownedHandles.set(proc, getOwnedHandleRegistry().register({
        type: "os-process",
        owner: "process-lifecycle",
        source: PROCESS_SNAPSHOT_SOURCE,
        scope: "process-lifecycle",
        pid: proc.pid,
        pgid: identity.pgid,
        birth: identity.birth,
        metadata: { groupId: proc.groupId, taskId: proc.taskId },
      }));
    } catch { /* legacy direct registrations may not represent a live OS PID */ }
  }

  private settleOwnedProcess(proc: TrackedProcess): void {
    const lease = this.ownedHandles.get(proc);
    if (!lease) return;
    this.ownedHandles.delete(proc);
    if (proc.outcomeUnknown || proc.state === "cleanup_failed") {
      lease.markUnconfirmed(proc.cleanupFailure || `Cleanup outcome unknown for PID ${proc.pid}`);
      return;
    }
    lease.release();
  }

  private signalTrackedProcess(
    proc: TrackedProcess,
    signal: NodeJS.Signals,
  ): "sent" | "gone" | "identity_mismatch" | "unverifiable" | "failed" {
    return signalProcessGroupVerified(proc.pid, proc.startIdentity, signal);
  }

  private emitSafely(
    event: "onSpawn" | "onExit" | "onTimeout" | "onForceKill" | "onCleanupFailure" | "onZombie",
    proc: TrackedProcess,
  ): void {
    try { this.events[event]?.(proc); } catch { /* observers cannot break cleanup */ }
  }

  private emitLimitSafely(group: string, current: number, max: number): void {
    try { this.events.onLimitReached?.(group, current, max); } catch { /* observer only */ }
  }

  private notifyTerminal(pid: number, proc: TrackedProcess): void {
    const listeners = this.terminalListeners.get(pid);
    this.terminalListeners.delete(pid);
    if (!listeners) return;
    for (const listener of listeners) {
      try { listener(proc); } catch { /* cleanup observers cannot break teardown */ }
    }
  }
}

function isTerminal(state: ProcessState): boolean {
  return state === "exited" || state === "killed" || state === "cancelled" ||
    state === "timeout" || state === "cleanup_failed";
}

// ─── Convenience: Singleton ──────────────────────────────────

let defaultLifecycleInstance: ProcessLifecycleManager | null = null;

/** Get or create the default ProcessLifecycleManager singleton */
export function getProcessLifecycle(
  config?: Partial<ProcessLifecycleConfig>,
  events?: ProcessLifecycleEvents,
): ProcessLifecycleManager {
  if (!defaultLifecycleInstance) {
    defaultLifecycleInstance = new ProcessLifecycleManager(config, events);
  }
  return defaultLifecycleInstance;
}

/** Reset the singleton (for testing) */
export function resetProcessLifecycle(): void {
  if (defaultLifecycleInstance) {
    const previous = defaultLifecycleInstance;
    defaultLifecycleInstance = null;
    previous.stop();
    // SIGKILL makes reset synchronous at the signalling boundary, avoiding an
    // old singleton's grace timer racing a freshly-created instance.
    void previous.killAll("SIGKILL", "reset").finally(() => previous.shutdown(false));
  }
}

// ─── Utility: Safe process spawn wrapper ─────────────────────

/**
 * Spawn a child process with automatic lifecycle tracking.
 * Returns the child process and automatically handles cleanup on exit.
 */
export function spawnTracked(
  lifecycle: ProcessLifecycleManager,
  command: string,
  args: string[],
  options: {
    groupId?: string;
    taskId?: string;
    timeoutMs?: number;
    cwd?: string;
    env?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<{
  pid: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}> {
  const groupId = options.groupId ?? "default";
  const taskId = options.taskId ?? `spawn_${Date.now()}`;
  const timeoutMs = options.timeoutMs;
  if (!lifecycle.hasCapacity(groupId)) {
    return Promise.reject(new Error(`Process capacity exceeded — cannot spawn ${command}`));
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    return Promise.reject(error);
  }

  let stdout = "";
  let stderr = "";
  const pid = child.pid;

  return new Promise((resolve, reject) => {
    let settled = false;
    let proc: TrackedProcess | null = null;
    let observedExitCode: number | null | undefined;
    let unsubscribeTerminal = () => {};
    const onStdout = (data: Buffer) => {
      stdout = appendBoundedOutput(stdout, data.toString());
      if (pid !== undefined) lifecycle.heartbeat(pid);
    };
    const onStderr = (data: Buffer) => {
      stderr = appendBoundedOutput(stderr, data.toString());
      if (pid !== undefined) lifecycle.heartbeat(pid);
    };
    const releaseChild = () => {
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      options.signal?.removeEventListener("abort", onAbort);
      unsubscribeTerminal();
    };
    const onExit = (code: number | null) => {
      observedExitCode = code;
    };
    const onClose = (code: number | null) => {
      if (settled) return;
      const finalCode = code ?? observedExitCode ?? null;
      if (pid !== undefined) lifecycle.markExited(pid, finalCode, proc ?? undefined);
      if (!settled) finishResolved(finalCode, proc ?? undefined);
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) {
        const identity = captureProcessIdentity(pid);
        signalProcessGroupVerified(pid, identity, "SIGKILL");
      }
      releaseChild();
      if (pid !== undefined && proc) lifecycle.markExited(pid, -1, proc);
      reject(err);
    };
    const onAbort = () => {
      if (pid !== undefined) void lifecycle.terminate(pid);
    };
    const finishResolved = (code: number | null, tracked?: TrackedProcess) => {
      if (settled) return;
      settled = true;
      releaseChild();
      resolve({
        pid: pid ?? -1,
        exitCode: code,
        stdout,
        stderr,
        timedOut: tracked?.timedOut ?? false,
      });
    };

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);

    if (pid === undefined) return;
    proc = lifecycle.register(pid, groupId, taskId, timeoutMs);
    if (!proc) {
      const identity = captureProcessIdentity(pid);
      signalProcessGroupVerified(pid, identity, "SIGKILL");
      onError(new Error(`Process capacity exceeded — cannot track ${command}`));
      return;
    }
    unsubscribeTerminal = lifecycle.onTerminal(pid, (tracked) => {
      finishResolved(tracked.exitCode, tracked);
    });
    lifecycle.markRunning(pid);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const CAPTURE_LIMIT = 512 * 1024;
const CAPTURE_HALF = CAPTURE_LIMIT / 2;

function appendBoundedOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  if (combined.length <= CAPTURE_LIMIT) return combined;
  return combined.slice(0, CAPTURE_HALF) + combined.slice(-CAPTURE_HALF);
}

function describeSignalFailure(
  result: "identity_mismatch" | "unverifiable" | "failed",
): string {
  switch (result) {
    case "identity_mismatch":
      return "process identity changed before signalling";
    case "unverifiable":
      return "process identity could not be verified";
    case "failed":
      return "signal delivery failed";
  }
}
