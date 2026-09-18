/**
 * =============================================================================
 * Canvast — Adaptive Resource Allocator / 自适应资源分配器
 * =============================================================================
 * @file        src/utils/resource-allocator.ts
 * @brief       Hardware-aware dynamic resource budgeting and allocation
 * @description Detects actual hardware on startup, reserves headroom for the OS
 *              and other applications, then dynamically allocates CPU/memory/IO
 *              budgets to agents based on CURRENT free resources. No static
 *              presets — everything is calculated from real hardware state.
 *              基于真实硬件状态的自适应资源分配。
 *
 *              Design Principles / 设计原则：
 *              1. Detect, don't assume. Measure actual hardware at startup.
 *              2. The OS and other apps come first. Always reserve headroom.
 *              3. Budgets are dynamic — recalculated on every allocation, not
 *                 just at startup. Free RAM at 9am ≠ free RAM at 3pm.
 *              4. The user sets policy ("use at most X"), the system sets
 *                 tactics ("right now that means Y agents at Z MB each").
 *              5. Degrade gracefully. When resources are tight, queue work
 *                 and reduce concurrency rather than crashing the machine.
 *              6. Limits are adaptive guardrails, not hard kill switches.
 *                 The system self-regulates to stay under the ceiling, using
 *                 a continuous throttle curve — never a binary on/off.
 *                 上限是自适应护栏，不是硬围栏。系统通过连续调节曲线
 *                 自我调控，永远在触及上限前减速，绝不突然终止。
 *
 *              Resource Categories / 资源类别：
 *              - Memory: per-agent max heap, total process RSS cap
 *              - CPU: max concurrent agents, per-agent CPU time slice
 *              - Process: max child processes, per-group limits
 *              - Storage: disk space budget for cache/artifacts
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial implementation — hardware-adaptive allocation
 *          [2026-08-25] Enforce aggregate RSS and grant reservations
 * =============================================================================
 */

import * as os from "node:os";
import { type SystemMonitor, type HealthSnapshot, formatBytes } from "./system-monitor.js";

// ─── Types / 类型定义 ────────────────────────────────────────

/** Detected hardware profile — measured once at startup */
export interface HardwareProfile {
  cpuCores: number;
  totalRamBytes: number;
  /** CPU model name (e.g., "Apple M3 Pro") */
  cpuModel: string;
  /** Platform (darwin, linux, win32) */
  platform: string;
  /** Rough performance tier derived from hardware */
  tier: "low" | "medium" | "high";
}

/** What the user wants (policy). All fields optional — system fills in rest. */
export interface UserResourcePolicy {
  /**
   * Maximum RAM Canvast is allowed to use, total (RSS).
   * - Absolute: "2GB" | "512MB" → parsed to bytes
   * - Relative: "50%" → percentage of total system RAM
   * - null/undefined → system decides (auto)
   * 最大允许使用的 RAM 总量。
   */
  maxTotalRam?: string;        // e.g. "2GB", "50%", "512MB"

  /**
   * Maximum CPU cores Canvast agents may use concurrently.
   * - Absolute: 4 → use at most 4 cores
   * - Relative: "50%" → half of detected cores
   * - null/undefined → system decides (auto)
   */
  maxCpuCores?: number | string; // e.g. 4 or "50%"

  /**
   * Maximum number of concurrent sub-agents.
   * - Absolute number
   * - null/undefined → derived from CPU/RAM
   */
  maxConcurrentAgents?: number;

  /**
   * Maximum child processes total (includes sub-agents, bash, MCP, etc.).
   */
  maxChildProcesses?: number;

  /**
   * RAM to reserve for OS and other applications.
   * - Absolute: "1GB" → always leave 1GB free
   * - Relative: "20%" → reserve 20% of total RAM
   * - null/undefined → system decides (20% or 512MB, whichever is larger)
   */
  reservedRam?: string;

  /**
   * CPU cores to reserve for OS and other applications.
   * - Absolute number (e.g., 1 → always leave 1 core)
   * - Relative: "25%" → reserve 25% of cores
   * - null/undefined → system decides
   */
  reservedCpuCores?: number | string;

  /**
   * Per-agent memory budget. Individual agents exceeding this
   * will be throttled or killed.
   * - Absolute: "512MB"
   * - null/undefined → derived from available resources / concurrency
   */
  perAgentMaxRam?: string;

  /**
   * Default agent timeout. Agents running longer will be killed.
   */
  agentTimeoutMs?: number;

  /**
   * How aggressively to reclaim resources.
   * - "gentle": only collect when pressure is high
   * - "balanced": moderate collection frequency
   * - "aggressive": frequent GC, tight limits
   */
  gcAggressiveness?: "gentle" | "balanced" | "aggressive";
}

/** Computed resource budgets — the tactical allocation derived from policy + hardware */
export interface ResourceBudget {
  /** Total RAM Canvast is allowed to use (bytes) */
  maxTotalRam: number;
  /** RAM reserved for OS + other apps (bytes) */
  reservedRam: number;
  /** Currently free RAM on the system (bytes) */
  systemFreeRam: number;
  /** RAM Canvast can actually use right now (bytes) */
  availableRam: number;
  /** RAM currently in use by Canvast (bytes) */
  currentRamUsage: number;
  /** RAM headroom before hitting the cap (bytes) */
  ramHeadroom: number;
  /** Utilization ratio: currentRamUsage / availableRam */
  ramUtilization: number;

  /** Max CPU cores for Canvast */
  maxCpuCores: number;
  /** Reserved CPU cores */
  reservedCpuCores: number;
  /** Current system load ratio */
  currentLoadRatio: number;

  /** Max concurrent sub-agents */
  maxConcurrentAgents: number;
  /** Max child processes total */
  maxChildProcesses: number;
  /** Per-agent RAM budget (bytes) */
  perAgentMaxRam: number;
  /** Agent timeout (ms) */
  agentTimeoutMs: number;

  /** GC aggressiveness setting */
  gcAggressiveness: "gentle" | "balanced" | "aggressive";

  /** When this budget was computed */
  computedAt: number;
  /** The hardware profile this is based on */
  hardware: HardwareProfile;
}

/** Result of a resource allocation request */
export interface AllocationResult {
  granted: boolean;
  /** If denied, why */
  reason?: string;
  /** If granted, the resource grant details */
  grant?: ResourceGrant;
  /** If granted, idempotently release this exact allocation */
  release?: () => void;
  /** If denied but possible later, estimated wait time (ms) */
  retryAfterMs?: number;
}

export interface ResourceGrant {
  /** Opaque identity used to release this exact allocation / 用于释放此分配的不透明标识 */
  id: string;
  /** Granted memory budget (bytes) */
  memoryBudget: number;
  /** Allocated CPU share (0-1 relative to one core) */
  cpuShare: number;
  /** Max runtime before forced termination (ms) */
  maxRuntimeMs: number;
  /** Whether this grant is reduced (below default) due to resource pressure */
  reduced: boolean;
  /** Depletion warning: grant will be revoked if headroom drops below this */
  revokeAtRamHeadroom: number;
}

// ─── Parsing Helpers / 解析工具 ──────────────────────────────

const MEMORY_UNITS: Record<string, number> = {
  b: 1,
  kb: 1024,
  mb: 1024 * 1024,
  gb: 1024 * 1024 * 1024,
  tb: 1024 * 1024 * 1024 * 1024,
};

/** Parse human-readable memory string to bytes */
function parseMemoryString(input: string, totalRam: number): number {
  const trimmed = input.trim().toLowerCase();

  // Percentage
  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed.slice(0, -1)) / 100;
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      throw new Error(`Invalid memory percentage: ${input}`);
    }
    return Math.floor(totalRam * pct);
  }

  // Absolute with unit
  const match = trimmed.match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) throw new Error(`Invalid memory string: ${input}`);

  const value = parseFloat(match[1]);
  const unit = (match[2] || "b") as string;
  if (!(unit in MEMORY_UNITS)) throw new Error(`Unknown memory unit: ${unit}`);

  return Math.floor(value * MEMORY_UNITS[unit]);
}

/** Parse CPU cores (absolute number or percentage) */
function parseCpuCores(input: number | string, totalCores: number): number {
  if (typeof input === "number") return Math.max(1, Math.floor(input));

  const trimmed = input.trim();
  if (trimmed.endsWith("%")) {
    const pct = parseFloat(trimmed.slice(0, -1)) / 100;
    if (isNaN(pct) || pct <= 0 || pct > 100) {
      throw new Error(`Invalid CPU percentage: ${input}`);
    }
    return Math.max(1, Math.floor(totalCores * pct));
  }

  const num = parseInt(trimmed, 10);
  if (isNaN(num)) throw new Error(`Invalid CPU cores: ${input}`);
  return Math.max(1, num);
}

// ─── Hardware Detection / 硬件检测 ────────────────────────────

/** Detect the hardware profile of the current machine */
export function detectHardware(): HardwareProfile {
  const cpuCores = os.cpus().length;
  const totalRamBytes = os.totalmem();
  const cpuModel = os.cpus()[0]?.model || "Unknown CPU";
  const platform = os.platform();

  // Rough performance tiering
  let tier: "low" | "medium" | "high";
  if (cpuCores <= 4 || totalRamBytes <= 4 * 1024 * 1024 * 1024) {
    tier = "low";    // ≤4 cores or ≤4GB RAM
  } else if (cpuCores <= 8 || totalRamBytes <= 16 * 1024 * 1024 * 1024) {
    tier = "medium"; // ≤8 cores or ≤16GB RAM
  } else {
    tier = "high";   // >8 cores and >16GB RAM
  }

  return { cpuCores, totalRamBytes, cpuModel, platform, tier };
}

// ─── Adaptive Throttle Curve / 自适应调节曲线 ───────────────

/**
 * The throttle curve maps resource utilization (0-1) to a throttle factor
 * (1 = full speed, 0 = fully stopped). The curve is designed so that:
 *
 * - 0%–50% utilization: no throttling (factor stays at 1.0)
 *   系统有余量，全速运行
 * - 50%–80%: gentle deceleration (1.0 → 0.7)
 *   开始轻度减速，用户几乎无感知
 * - 80%–95%: significant deceleration (0.7 → 0.3)
 *   明显减速，但所有在途任务继续运行
 * - 95%–99%: aggressive deceleration (0.3 → 0.1)
 *   只允许关键操作，新任务几乎全部排队
 * - 99%–100%: the system NEVER reaches this because the curve
 *   is asymptotic — throttle approaches 0 but allocation never
 *   stops completely. Emergency reserve is always maintained.
 *   理论上永远不会触及 100%，因为曲线渐近地趋近于 0
 *
 * This is a sigmoid-like curve: flat at low utilization, steep near the limit,
 * asymptotic at 100%. It's the resource equivalent of a PID controller's
 * proportional term — smooth, predictable, and self-correcting.
 *
 * 类似 PID 控制器的 P 项：平滑、可预测、自我修正。
 */
export function throttleCurve(utilization: number): number {
  // Clamp to valid range
  const u = Math.max(0, Math.min(1, utilization));

  if (u <= 0.5) return 1.0;

  // Smooth transition zone: 0.5–0.8
  if (u <= 0.8) {
    // Quadratic ease-out from 1.0 to 0.7
    const t = (u - 0.5) / 0.3; // normalize to 0-1
    return 1.0 - 0.3 * t * t;
  }

  // Steep zone: 0.8–0.95
  if (u <= 0.95) {
    const t = (u - 0.8) / 0.15; // normalize to 0-1
    // Cubic curve from 0.7 to 0.3
    return 0.7 - 0.4 * t * t * t;
  }

  // Critical zone: 0.95–1.0
  // Asymptotic approach to 0.05 (never zero — keep minimal operations alive)
  const t = (u - 0.95) / 0.05;
  return 0.3 * Math.exp(-4 * t) + 0.05;
}

/**
 * Inverse: given a desired throttle factor, what's the max utilization?
 * Used to determine "at what utilization should we start worrying?"
 */
export function throttleInverse(factor: number): number {
  if (factor >= 1.0) return 0.5;
  if (factor <= 0.1) return 0.98;
  // Binary search approximation
  let lo = 0.5, hi = 1.0;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (throttleCurve(mid) > factor) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Get a human-readable description of the current throttle state.
 */
export function describeThrottle(utilization: number): {
  factor: number;
  label: string;
  description: string;
} {
  const factor = throttleCurve(utilization);
  let label: string;
  let description: string;

  if (utilization <= 0.5) {
    label = "normal / 正常";
    description = "Full speed. Resources are abundant. 资源充裕，全速运行。";
  } else if (utilization <= 0.8) {
    label = "gentle / 轻度调节";
    description = "Slight slowdown, barely noticeable. New tasks still accepted freely. 轻微减速，几乎无感知。继续接受新任务。";
  } else if (utilization <= 0.95) {
    label = "moderate / 中度调节";
    description = "Noticeable slowdown. New tasks are queued. Running tasks continue unimpeded. 明显减速。新任务排队，运行中任务不受影响。";
  } else if (utilization <= 0.99) {
    label = "tight / 紧张";
    description = "Significant slowdown. Only critical operations proceed. System self-preserving. 大幅减速。仅关键操作继续。系统自我保护中。";
  } else {
    label = "critical / 临界";
    description = "Minimal operations only. System has not crashed — it's self-regulating at the absolute limit. 仅最小操作。系统未崩溃，正在极限处自我调节。";
  }

  return { factor, label, description };
}

// ─── Resource Allocator / 资源分配器 ──────────────────────────

export class ResourceAllocator {
  private hardware: HardwareProfile;
  private policy: UserResourcePolicy;
  private monitor: SystemMonitor | null = null;
  private lastBudget: ResourceBudget | null = null;
  private activeGrants = new Map<string, ResourceGrant>();
  private grantCounter = 0;

  constructor(policy?: UserResourcePolicy, monitor?: SystemMonitor) {
    this.hardware = detectHardware();
    this.policy = policy ?? {};
    this.monitor = monitor ?? null;
  }

  // ─── Hardware Info ───────────────────────────────────────

  /** Get the detected hardware profile */
  get hardwareProfile(): HardwareProfile { return { ...this.hardware }; }

  /** Get the user's resource policy */
  get userPolicy(): UserResourcePolicy { return { ...this.policy }; }

  // ─── Budget Computation / 预算计算 ────────────────────────

  /**
   * Compute the current resource budget based on:
   * 1. Hardware profile (fixed)
   * 2. User policy (fixed, but user can change at runtime)
   * 3. Current system state (dynamic — changes every call)
   *
   * Call this before each major allocation decision.
   */
  computeBudget(): ResourceBudget {
    const { cpuCores, totalRamBytes } = this.hardware;
    const monitorSnapshot = this.monitor?.snapshot();
    const currentRss = monitorSnapshot?.memory.rss ?? process.memoryUsage().rss;
    const childRss = monitorSnapshot?.process.childTotalRss ?? 0;
    const grantReservations = Array.from(this.activeGrants.values())
      .reduce((total, grant) => total + grant.memoryBudget, 0);
    const currentRamUsage = currentRss + childRss;
    const committedRam = currentRamUsage + grantReservations;
    const systemFreeRam = monitorSnapshot?.memory.systemFree ?? os.freemem();
    const load1 = monitorSnapshot?.cpu.systemLoad1 ?? os.loadavg()[0];

    // ── RAM Budget ─────────────────────────────────────────

    // 1. Reserved RAM: user override or system default
    let reservedRam: number;
    if (this.policy.reservedRam) {
      reservedRam = parseMemoryString(this.policy.reservedRam, totalRamBytes);
    } else {
      // Default: 20% of total RAM or 512MB, whichever is larger
      reservedRam = Math.max(
        Math.floor(totalRamBytes * 0.20),
        512 * 1024 * 1024, // 512 MB minimum headroom
      );
    }

    // 2. User max cap
    let userMaxRam = Infinity;
    if (this.policy.maxTotalRam) {
      userMaxRam = parseMemoryString(this.policy.maxTotalRam, totalRamBytes);
    }

    // 3. Available = physical free RAM after OS headroom and outstanding grant
    // reservations, capped by the aggregate Canvast limit. Parent and child
    // RSS are already absent from systemFreeRam; grant reservations are not.
    const availableFromSystem = Math.max(0, systemFreeRam - reservedRam - grantReservations);
    const availableRam = Math.min(
      availableFromSystem,
      Math.max(0, userMaxRam - committedRam),
    );

    const ramUtilization = availableRam > 0
      ? committedRam / (committedRam + availableRam)
      : 1.0;
    const ramHeadroom = Math.max(0, availableRam);

    // ── CPU Budget ─────────────────────────────────────────

    let reservedCpuCores: number;
    if (this.policy.reservedCpuCores !== undefined) {
      reservedCpuCores = parseCpuCores(this.policy.reservedCpuCores, cpuCores);
    } else {
      // Default: 1 core or 20% of cores, whichever is larger
      reservedCpuCores = Math.max(1, Math.ceil(cpuCores * 0.20));
    }

    let maxCpuCores: number;
    if (this.policy.maxCpuCores !== undefined) {
      maxCpuCores = parseCpuCores(this.policy.maxCpuCores, cpuCores);
    } else {
      maxCpuCores = cpuCores - reservedCpuCores;
    }
    maxCpuCores = Math.max(1, Math.min(maxCpuCores, cpuCores - reservedCpuCores));

    const currentLoadRatio = cpuCores > 0 ? load1 / cpuCores : 0;

    // ── Concurrency Budget ─────────────────────────────────

    let maxConcurrentAgents: number;
    if (this.policy.maxConcurrentAgents !== undefined) {
      maxConcurrentAgents = Math.max(1, this.policy.maxConcurrentAgents); // never below 1
    } else {
      // Derive from CPU + RAM
      // Rough heuristic: 2 agents per available core, but memory-constrained
      const cpuBased = Math.max(1, maxCpuCores * 2);
      const ramBased = Math.max(1, Math.floor(availableRam / (256 * 1024 * 1024))); // 256MB per agent minimum
      maxConcurrentAgents = Math.max(1, Math.min(cpuBased, ramBased));
    }

    // ── Process Budget ─────────────────────────────────────

    let maxChildProcesses: number;
    if (this.policy.maxChildProcesses !== undefined) {
      maxChildProcesses = this.policy.maxChildProcesses;
    } else {
      // Derive: 2-3 processes per agent + some headroom
      maxChildProcesses = maxConcurrentAgents * 3 + 5;
    }

    // ── Per-Agent Budget ───────────────────────────────────

    let perAgentMaxRam: number;
    if (this.policy.perAgentMaxRam) {
      perAgentMaxRam = parseMemoryString(this.policy.perAgentMaxRam, totalRamBytes);
    } else {
      // Derive: divide available RAM by max agents, with a floor
      perAgentMaxRam = Math.max(
        128 * 1024 * 1024, // 128MB minimum per agent
        Math.floor(availableRam / Math.max(1, maxConcurrentAgents)),
      );
    }
    // Cap per-agent at total available
    perAgentMaxRam = Math.min(perAgentMaxRam, availableRam);

    // ── Timeout ────────────────────────────────────────────

    const agentTimeoutMs = this.policy.agentTimeoutMs ?? 300_000; // default 5 min

    // ── GC ─────────────────────────────────────────────────

    const gcAggressiveness = this.policy.gcAggressiveness ?? "balanced";

    const budget: ResourceBudget = {
      maxTotalRam: userMaxRam === Infinity ? totalRamBytes - reservedRam : userMaxRam,
      reservedRam,
      systemFreeRam,
      availableRam,
      currentRamUsage,
      ramHeadroom,
      ramUtilization,
      maxCpuCores,
      reservedCpuCores,
      currentLoadRatio,
      maxConcurrentAgents,
      maxChildProcesses,
      perAgentMaxRam,
      agentTimeoutMs,
      gcAggressiveness,
      computedAt: Date.now(),
      hardware: { ...this.hardware },
    };

    this.lastBudget = budget;
    return budget;
  }

  /** Get the most recently computed budget (without recomputing) */
  get currentBudget(): ResourceBudget {
    return this.lastBudget ?? this.computeBudget();
  }

  // ─── Allocation / 分配 ──────────────────────────────────

  /**
   * Request a resource grant for a new agent.
   * Checks current headroom and either grants (possibly reduced) or denies.
   */
  requestAllocation(
    taskId: string,
    estimatedMemoryBytes?: number,
    estimatedCpuShare?: number,
  ): AllocationResult {
    const budget = this.computeBudget();

    // Get throttle factor from the continuous curve
    const throttle = throttleCurve(budget.ramUtilization);

    // At very high utilization (>99%), only allow minimal operations
    // This is the softest possible gate — almost everything passes through
    if (throttle <= 0.06) {
      return {
        granted: false,
        reason: `Resource ceiling approached: utilization ${(budget.ramUtilization * 100).toFixed(1)}%, throttle factor ${throttle.toFixed(3)}. 资源接近上限，暂停新分配。`,
        retryAfterMs: Math.max(30000, budget.agentTimeoutMs / 2),
      };
    }

    const requestedMemory = estimatedMemoryBytes ?? budget.perAgentMaxRam;

    // Adaptive concurrency: the effective max scales with the throttle curve
    const effectiveMaxAgents = Math.max(1, Math.floor(budget.maxConcurrentAgents * throttle));

    if (this.activeGrants.size >= effectiveMaxAgents) {
      return {
        granted: false,
        reason: `Effective concurrency limit reached (${effectiveMaxAgents}/${budget.maxConcurrentAgents}) at throttle factor ${throttle.toFixed(2)}. 当前自适应并发上限已满。`,
        retryAfterMs: 5000,
      };
    }

    // Grant size scales with throttle factor — under pressure, give smaller budgets
    const grantSize = Math.floor(budget.perAgentMaxRam * throttle);
    const memoryBudget = Math.min(requestedMemory, grantSize);
    const reduced = throttle < 0.7;

    const cpuShare = estimatedCpuShare ?? (1 / Math.max(1, effectiveMaxAgents));
    const revokeAt = Math.floor(budget.perAgentMaxRam * 0.05 * throttle);

    const finalMemoryBudget = Math.max(64 * 1024 * 1024, memoryBudget);
    if (finalMemoryBudget > budget.ramHeadroom) {
      return {
        granted: false,
        reason: `Insufficient RAM headroom: requested ${formatBytes(finalMemoryBudget)}, available ${formatBytes(budget.ramHeadroom)}. RAM 余量不足。`,
        retryAfterMs: 5000,
      };
    }

    const grantId = `grant_${++this.grantCounter}_${taskId}`;
    const grant: ResourceGrant = {
      id: grantId,
      memoryBudget: finalMemoryBudget, // never below 64MB
      cpuShare,
      maxRuntimeMs: budget.agentTimeoutMs,
      reduced,
      revokeAtRamHeadroom: revokeAt,
    };

    this.activeGrants.set(grantId, grant);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseAllocation(grantId);
    };

    return { granted: true, grant, release };
  }

  /**
   * Release a previously granted resource allocation.
   */
  releaseAllocation(grantId: string): void {
    this.activeGrants.delete(grantId);
  }

  /**
   * Check if existing grants need to be revoked due to resource pressure.
   * Returns list of grant IDs that should be revoked.
   */
  checkRevocations(): string[] {
    const budget = this.computeBudget();
    const toRevoke: string[] = [];

    for (const [id, grant] of this.activeGrants) {
      if (budget.ramHeadroom < grant.revokeAtRamHeadroom) {
        toRevoke.push(id);
      }
    }

    return toRevoke;
  }

  /**
   * Get a recommended concurrency level based on current resource state.
   * This is the primary number sub-agent systems should use.
   */
  /**
   * Get the recommended concurrency based on the adaptive throttle curve.
   * This is the primary number sub-agent systems should consult before spawning.
   *
   * Unlike the old hard-switch approach, this produces smooth transitions:
   * - At 50% util: full concurrency
   * - At 75% util: ~85% concurrency
   * - At 90% util: ~50% concurrency
   * - At 97% util: ~15% concurrency
   * - Never reaches zero (floor is 1 at minimum viable throttle)
   */
  getRecommendedConcurrency(): number {
    const budget = this.computeBudget();

    // Combine RAM and CPU utilization for a holistic throttle
    const combinedUtil = Math.max(budget.ramUtilization, budget.currentLoadRatio);
    const throttle = throttleCurve(combinedUtil);

    return Math.max(1, Math.floor(budget.maxConcurrentAgents * throttle));
  }

  /**
   * Get the current throttle state for monitoring/display.
   * Returns the continuous throttle factor and human-readable description.
   */
  getThrottleState(): ReturnType<typeof describeThrottle> {
    const budget = this.computeBudget();
    const combinedUtil = Math.max(budget.ramUtilization, budget.currentLoadRatio);
    return describeThrottle(combinedUtil);
  }

  // ─── Status & Reporting / 状态报告 ────────────────────────

  /** Get a human-readable summary of the current resource state */
  getStatusSummary(): string {
    const budget = this.currentBudget;
    const hw = this.hardware;

    const lines = [
      `## Resource Status / 资源状态`,
      ``,
      `**Hardware / 硬件**: ${hw.cpuModel}, ${hw.cpuCores} cores, ${formatBytes(hw.totalRamBytes)} RAM (tier: ${hw.tier})`,
      `**Policy / 策略**: max RAM=${this.policy.maxTotalRam ?? "auto"}, max cores=${this.policy.maxCpuCores ?? "auto"}, reserved=${formatBytes(budget.reservedRam)} RAM + ${budget.reservedCpuCores} CPU cores`,
      ``,
      `**Current / 当前**:`,
      `- Canvast RSS: ${formatBytes(budget.currentRamUsage)}`,
      `- System free: ${formatBytes(budget.systemFreeRam)}`,
      `- Available to Canvast: ${formatBytes(budget.availableRam)}`,
      `- Headroom: ${formatBytes(budget.ramHeadroom)} (${(budget.ramUtilization * 100).toFixed(0)}% utilized)`,
      `- CPU load: ${(budget.currentLoadRatio * 100).toFixed(0)}% (${budget.maxCpuCores} cores available)`,
      ``,
      `**Limits / 限制**:`,
      `- Max concurrent agents: ${budget.maxConcurrentAgents}`,
      `- Per-agent RAM: ${formatBytes(budget.perAgentMaxRam)}`,
      `- Agent timeout: ${budget.agentTimeoutMs / 1000}s`,
      `- Max child processes: ${budget.maxChildProcesses}`,
      `- Active grants: ${this.activeGrants.size}`,
      `- Recommended concurrency: ${this.getRecommendedConcurrency()}`,
    ];

    return lines.join("\n");
  }

  /** Get a one-line summary for logs */
  getOneLineStatus(): string {
    const b = this.currentBudget;
    return [
      `[RAM ${formatBytes(b.currentRamUsage)}/${formatBytes(b.availableRam)} (${(b.ramUtilization * 100).toFixed(0)}%)]`,
      `[CPU ${(b.currentLoadRatio * 100).toFixed(0)}% load, ${b.maxCpuCores} cores]`,
      `[Agents ${this.activeGrants.size}/${b.maxConcurrentAgents}, rec=${this.getRecommendedConcurrency()}]`,
      `[Free ${formatBytes(b.systemFreeRam)}]`,
    ].join(" ");
  }
}

// ─── Convenience: Singleton ──────────────────────────────────

let defaultAllocator: ResourceAllocator | null = null;

export function getResourceAllocator(
  policy?: UserResourcePolicy,
  monitor?: SystemMonitor,
): ResourceAllocator {
  if (!defaultAllocator) {
    defaultAllocator = new ResourceAllocator(policy, monitor);
  }
  return defaultAllocator;
}

export function resetResourceAllocator(): void {
  defaultAllocator = null;
}

