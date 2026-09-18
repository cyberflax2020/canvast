/**
 * =============================================================================
 * Canvast — Canvast Mode / Canvast 源文件
 * =============================================================================
 * @file        src/harness/canvast-mode.ts
 * @brief       Canvast-owned source file.
 * @description Part of the Canvast product codebase. Keep provenance and
 *              license headers explicit for commercial redistribution.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * =============================================================================
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type CanvastRuntimeMode = "parity" | "enhanced";
export type CanvastModeSource = "default" | "persisted" | "env" | "argv" | "command" | "prompt" | "tool";
export type CanvastModeScope = "session" | "turn";

export interface CanvastModeState {
  mode: CanvastRuntimeMode;
  source: CanvastModeSource;
  updatedAt: string;
  revision: number;
  reason?: string;
}

export interface CanvastModeDirective {
  action: "set" | "status";
  mode?: CanvastRuntimeMode;
  scope: CanvastModeScope;
  reason: string;
  source: CanvastModeSource;
}

export interface CanvastModeController {
  beginTurn(prompt: string, now?: string): CanvastModeDirective | undefined;
  getState(): CanvastModeState;
  getEffectiveMode(): CanvastRuntimeMode;
  isEnhanced(): boolean;
  setMode(mode: CanvastRuntimeMode, source: CanvastModeSource, reason?: string, now?: string): CanvastModeState;
  setTurnMode(mode: CanvastRuntimeMode, reason?: string): CanvastModeState;
  clearTurnMode(): void;
  renderStatus(): string;
}

export const DEFAULT_CANVAST_MODE: CanvastRuntimeMode = "enhanced";

function persistenceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CANVAST_PERSISTENCE_MODE === "ephemeral" ||
    /^(1|true|yes|on)$/i.test(String(env.CANVAST_NO_SESSION_PERSISTENCE ?? "")) ||
    /^(1|true|yes|on)$/i.test(String(env.CANVAST_EPHEMERAL ?? ""));
}

export function normalizeCanvastMode(value: unknown): CanvastRuntimeMode | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (["enhanced", "on", "true", "1", "plus", "canvast", "canvest", "super"].includes(text)) return "enhanced";
  if (["parity", "off", "false", "0", "baseline", "compat", "compatible"].includes(text)) return "parity";
  return undefined;
}

export function modeFile(agentDir: string): string {
  return path.join(agentDir, "canvast-mode.json");
}

export function readCanvastModeState(agentDir: string): CanvastModeState | undefined {
  const file = modeFile(agentDir);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const mode = normalizeCanvastMode(raw?.mode);
    if (!mode) return undefined;
    return {
      mode,
      source: raw?.source || "persisted",
      updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      revision: Number.isFinite(Number(raw?.revision)) ? Number(raw.revision) : 0,
      reason: typeof raw?.reason === "string" ? raw.reason : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeCanvastModeState(agentDir: string, state: CanvastModeState): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(modeFile(agentDir), JSON.stringify(state, null, 2));
}

function fromEnv(env: NodeJS.ProcessEnv): { mode?: CanvastRuntimeMode; source: CanvastModeSource } {
  const mode = normalizeCanvastMode(env.CANVAST_MODE);
  const source = env.CANVAST_MODE_SOURCE === "argv" ? "argv" : "env";
  return { mode, source };
}

export function splitCanvastModeArgs(args: string[]): {
  forwardedArgs: string[];
  mode?: CanvastRuntimeMode;
  source?: CanvastModeSource;
  errors: string[];
} {
  const forwardedArgs: string[] = [];
  const errors: string[] = [];
  let mode: CanvastRuntimeMode | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextValue = (flag: string): string | undefined => {
      if (i + 1 >= args.length) {
        errors.push(`${flag} requires parity or enhanced`);
        return undefined;
      }
      i += 1;
      return args[i];
    };

    if (arg === "--canvast-mode" || arg === "--canvest-mode") {
      const parsed = normalizeCanvastMode(nextValue(arg));
      if (parsed) mode = parsed;
      else errors.push(`${arg} must be parity or enhanced`);
      continue;
    }
    if (arg.startsWith("--canvast-mode=") || arg.startsWith("--canvest-mode=")) {
      const raw = arg.slice(arg.indexOf("=") + 1);
      const parsed = normalizeCanvastMode(raw);
      if (parsed) mode = parsed;
      else errors.push(`${arg.split("=")[0]} must be parity or enhanced`);
      continue;
    }
    if (arg === "--canvast-enhanced" || arg === "--canvest-enhanced") {
      mode = "enhanced";
      continue;
    }
    if (arg === "--no-canvast-enhanced" || arg === "--no-canvest-enhanced" || arg === "--canvast-parity" || arg === "--canvest-parity") {
      mode = "parity";
      continue;
    }
    forwardedArgs.push(arg);
  }

  return { forwardedArgs, mode, source: mode ? "argv" : undefined, errors };
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

export function detectCanvastModeDirective(prompt: string): CanvastModeDirective | undefined {
  const text = prompt.toLowerCase();
  const mentionsCanvast = /canv[ae]st|canvast|canvest/.test(text);
  const mentionsMode = /enhanced|parity|baseline|compat|compatible|模式|增强|超越版|基线|兼容|关闭特色|关闭增强|开启增强|启用增强|禁用增强/.test(text);
  const scope: CanvastModeScope = /本轮|这一轮|当前轮|仅本次|临时|temporar|this turn|current turn|one turn/.test(text)
    ? "turn"
    : "session";

  if (mentionsCanvast && hasAny(text, [
    /关闭.*(增强|特色|超越|enhanced)/,
    /禁用.*(增强|特色|超越|enhanced)/,
    /disable.*(enhanced|canv[ae]st)/,
    /turn\s+off.*(enhanced|canv[ae]st)/,
    /canv[ae]st.*(parity|baseline|compat|compatible|基线|兼容版)/,
  ])) {
    return {
      action: "set",
      mode: "parity",
      scope,
      reason: "User requested baseline mode / disabled Canvast enhanced controls.",
      source: "prompt",
    };
  }

  if (mentionsCanvast && hasAny(text, [
    /开启.*(增强|特色|超越|enhanced)/,
    /启用.*(增强|特色|超越|enhanced)/,
    /打开.*(增强|特色|超越|enhanced)/,
    /enable.*(enhanced|canv[ae]st)/,
    /turn\s+on.*(enhanced|canv[ae]st)/,
    /canv[ae]st.*(enhanced|超越版|增强版)/,
  ])) {
    return {
      action: "set",
      mode: "enhanced",
      scope,
      reason: "User requested Canvast enhanced controls.",
      source: "prompt",
    };
  }

  if (mentionsCanvast && mentionsMode && /status|当前|状态|模式|what.*mode|which.*mode/.test(text)) {
    return {
      action: "status",
      scope,
      reason: "User requested Canvast mode status.",
      source: "prompt",
    };
  }

  return undefined;
}

export function createCanvastModeController(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
  now = new Date().toISOString(),
): CanvastModeController {
  const canPersist = !persistenceDisabled(env);
  const persisted = canPersist ? readCanvastModeState(agentDir) : undefined;
  const envMode = fromEnv(env);
  let state: CanvastModeState = persisted || {
    mode: DEFAULT_CANVAST_MODE,
    source: "default",
    updatedAt: now,
    revision: 0,
    reason: "Default Canvast enhanced mode.",
  };
  let turnMode: CanvastRuntimeMode | undefined;
  let turnReason: string | undefined;

  const persist = (next: CanvastModeState) => {
    state = next;
    if (canPersist) writeCanvastModeState(agentDir, state);
    return state;
  };

  if (envMode.mode) {
    persist({
      mode: envMode.mode,
      source: envMode.source,
      updatedAt: now,
      revision: (persisted?.revision || 0) + 1,
      reason: envMode.source === "argv" ? "Startup --canvast-mode override." : "Startup CANVAST_MODE override.",
    });
  } else if (!persisted && canPersist) {
    writeCanvastModeState(agentDir, state);
  }

  const controller: CanvastModeController = {
    beginTurn(prompt: string, turnNow = new Date().toISOString()) {
      turnMode = undefined;
      turnReason = undefined;
      const directive = detectCanvastModeDirective(prompt);
      if (!directive) return undefined;
      if (directive.action === "status") return directive;
      if (!directive.mode) return directive;
      if (directive.scope === "turn") {
        turnMode = directive.mode;
        turnReason = directive.reason;
        return directive;
      }
      controller.setMode(directive.mode, directive.source, directive.reason, turnNow);
      return directive;
    },
    getState() {
      return state;
    },
    getEffectiveMode() {
      return turnMode || state.mode;
    },
    isEnhanced() {
      return controller.getEffectiveMode() === "enhanced";
    },
    setMode(mode: CanvastRuntimeMode, source: CanvastModeSource, reason?: string, setNow = new Date().toISOString()) {
      turnMode = undefined;
      turnReason = undefined;
      return persist({
        mode,
        source,
        updatedAt: setNow,
        revision: state.revision + 1,
        reason,
      });
    },
    setTurnMode(mode: CanvastRuntimeMode, reason?: string) {
      turnMode = mode;
      turnReason = reason;
      return { ...state, mode, source: "prompt", reason: reason || state.reason };
    },
    clearTurnMode() {
      turnMode = undefined;
      turnReason = undefined;
    },
    renderStatus() {
      const effective = controller.getEffectiveMode();
      const turn = turnMode ? `\nturn_override=${turnMode}${turnReason ? ` (${turnReason})` : ""}` : "";
      return [
        `Canvast mode: ${effective}`,
        `persisted=${state.mode}`,
        `source=${state.source}`,
        `revision=${state.revision}`,
        `updated_at=${state.updatedAt}`,
        state.reason ? `reason=${state.reason}` : "",
        turn,
        effective === "enhanced"
          ? "Enhanced controls are active: Canvas scoping, automatic orchestration, task tree, sub-agent/workflow governance."
          : "Baseline controls are active: Canvast enhanced harness injection and gates are disabled; baseline safety wrappers remain available.",
      ].filter(Boolean).join("\n");
    },
  };

  return controller;
}
