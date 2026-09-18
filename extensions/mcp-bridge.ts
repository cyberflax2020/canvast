/**
 * =============================================================================
 * Canvast — MCP Bridge / MCP 协议桥接
 * =============================================================================
 * @file        extensions/mcp-bridge.ts
 * @brief       MCP (Model Context Protocol) server REGISTRY for pi agent
 * @description Adapts opencode's MCP tool handling patterns (MIT) and Tallow's
 *              mcp-adapter-tool (MIT).
 *
 *              HONEST STATUS (2026-08-15): this extension is a CONFIG REGISTRY
 *              ONLY. mcp_connect records a server definition; it does NOT
 *              spawn the server, speak stdio MCP, or expose server tools.
 *              The previous description claimed connected tools "become
 *              available to the agent" — that was false and is corrected here.
 *              Implementing the stdio transport (or removing this extension)
 *              is an explicit remaining task in the handover TOR.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — opencode MCP patterns + Tallow mcp-adapter
 *          [2026-08-15] Honest capability labeling (registry-only, no transport)
 * =============================================================================
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface MCPRegistryEntry {
  config: MCPServerConfig;
  configBytes: number;
}

interface ValidationViolation {
  field: string;
  code: string;
  message: string;
  actual?: number;
  limit?: number;
}

interface RegistryErrorDetails {
  code: string;
  violations: ValidationViolation[];
  registry: {
    registeredServers: number;
    totalConfigBytes: number;
  };
}

interface RegistryStateDetails {
  registeredServers: number;
  totalConfigBytes: number;
}

interface RegisterSuccessDetails extends RegistryErrorDetails {
  configBytes: number;
  updatedExisting: boolean;
}

interface ListItemDetails {
  name: string;
  command: string;
  argsCount: number;
  envKeys: string[];
  configBytes: number;
}

interface ListSuccessDetails extends RegistryErrorDetails {
  items: ListItemDetails[];
  offset: number;
  limit: number;
  nextOffset?: number;
  responseBytes: number;
  responseByteCap: number;
  truncatedByByteCap: boolean;
}

interface ResetSuccessDetails extends RegistryStateDetails {
  clearedServers: number;
  releasedBytes: number;
}

type RegisterToolDetails = RegistryErrorDetails | RegisterSuccessDetails;
type ListToolDetails = RegistryErrorDetails | ListSuccessDetails;
type ResetToolDetails = ResetSuccessDetails;

export const MCP_BRIDGE_LIMITS = Object.freeze({
  maxRegisteredServers: 32,
  maxNameBytes: 64,
  maxCommandBytes: 512,
  maxArgBytes: 512,
  maxEnvKeyBytes: 128,
  maxEnvValueBytes: 1024,
  maxConfigBytesPerServer: 8 * 1024,
  maxConfigBytesTotal: 64 * 1024,
  defaultListLimit: 20,
  maxListLimit: 50,
  listResponseByteCap: 4 * 1024,
});

function stringByteSize(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function jsonByteSize(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isAsciiLetterOrDigit(code: number): boolean {
  return (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);
}

function isAllowedNameCode(code: number): boolean {
  return isAsciiLetterOrDigit(code) || code === 45 || code === 46 || code === 95;
}

function validateServerName(name: string): ValidationViolation | undefined {
  if (name.length === 0) {
    return { field: "name", code: "empty", message: "Name must not be empty." };
  }
  for (let index = 0; index < name.length; index++) {
    const code = name.charCodeAt(index);
    if (code > 0x7f) {
      return {
        field: "name",
        code: "non_ascii",
        message: "Name must use ASCII letters, digits, '.', '_' or '-'.",
      };
    }
    if (index === 0 && !isAsciiLetterOrDigit(code)) {
      return {
        field: "name",
        code: "leading_character",
        message: "Name must start with an ASCII letter or digit.",
      };
    }
    if (index > 0 && !isAllowedNameCode(code)) {
      return {
        field: "name",
        code: "invalid_character",
        message: "Name must use ASCII letters, digits, '.', '_' or '-'.",
      };
    }
  }
  return undefined;
}

function validateStringField(
  field: string,
  value: string,
  limit: number,
  required: boolean,
): ValidationViolation[] {
  const violations: ValidationViolation[] = [];
  if (required && value.length === 0) {
    violations.push({ field, code: "empty", message: `${field} must not be empty.` });
    return violations;
  }
  const bytes = stringByteSize(value);
  if (bytes > limit) {
    violations.push({
      field,
      code: "field_too_large",
      message: `${field} exceeds the byte limit.`,
      actual: bytes,
      limit,
    });
  }
  return violations;
}

function registryError(
  message: string,
  details: RegistryErrorDetails,
): { isError: true; content: Array<{ type: "text"; text: string }>; details: RegistryErrorDetails } {
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    details,
  };
}

function currentRegistryState(
  registeredServers: number,
  totalBytes: number,
): RegistryErrorDetails["registry"] {
  return {
    registeredServers,
    totalConfigBytes: totalBytes,
  };
}

function summarizeEntry(entry: MCPRegistryEntry): {
  name: string;
  command: string;
  argsCount: number;
  envKeys: string[];
  configBytes: number;
} {
  return {
    name: entry.config.name,
    command: entry.config.command,
    argsCount: entry.config.args.length,
    envKeys: Object.keys(entry.config.env || {}).sort(),
    configBytes: entry.configBytes,
  };
}

function renderEntryLine(entry: MCPRegistryEntry): string {
  const argsText = entry.config.args.length > 0 ? ` ${entry.config.args.join(" ")}` : "";
  return `- **${entry.config.name}**: \`${entry.config.command}${argsText}\` (${entry.configBytes} bytes)`;
}

function validateRegisterParams(
  params: unknown,
): { config?: MCPServerConfig; configBytes?: number; violations: ValidationViolation[] } {
  const violations: ValidationViolation[] = [];
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return {
      violations: [{ field: "params", code: "invalid_type", message: "Parameters must be an object." }],
    };
  }

  const record = params as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : "";
  const command = typeof record.command === "string" ? record.command : "";
  const argsValue = record.args;
  const envValue = record.env;

  if (typeof record.name !== "string") {
    violations.push({ field: "name", code: "invalid_type", message: "name must be a string." });
  }
  if (typeof record.command !== "string") {
    violations.push({ field: "command", code: "invalid_type", message: "command must be a string." });
  }

  if (argsValue !== undefined && !Array.isArray(argsValue)) {
    violations.push({ field: "args", code: "invalid_type", message: "args must be an array of strings." });
  }
  if (
    envValue !== undefined &&
    (typeof envValue !== "object" || envValue === null || Array.isArray(envValue))
  ) {
    violations.push({ field: "env", code: "invalid_type", message: "env must be an object of string values." });
  }

  violations.push(...validateStringField("name", name, MCP_BRIDGE_LIMITS.maxNameBytes, true));
  violations.push(...validateStringField("command", command, MCP_BRIDGE_LIMITS.maxCommandBytes, true));
  const nameViolation = validateServerName(name);
  if (nameViolation) violations.push(nameViolation);

  const args: string[] = [];
  if (Array.isArray(argsValue)) {
    for (let index = 0; index < argsValue.length; index++) {
      const value = argsValue[index];
      if (typeof value !== "string") {
        violations.push({
          field: `args[${index}]`,
          code: "invalid_type",
          message: "Each arg must be a string.",
        });
        continue;
      }
      violations.push(...validateStringField(`args[${index}]`, value, MCP_BRIDGE_LIMITS.maxArgBytes, false));
      args.push(value);
    }
  }

  let env: Record<string, string> | undefined;
  if (envValue && typeof envValue === "object" && !Array.isArray(envValue)) {
    env = {};
    for (const [key, rawValue] of Object.entries(envValue)) {
      violations.push(...validateStringField(`env.${key}.key`, key, MCP_BRIDGE_LIMITS.maxEnvKeyBytes, true));
      const keyViolation = validateServerName(key);
      if (keyViolation) {
        violations.push({
          ...keyViolation,
          field: `env.${key}.key`,
        });
      }
      if (typeof rawValue !== "string") {
        violations.push({
          field: `env.${key}.value`,
          code: "invalid_type",
          message: "Each env value must be a string.",
        });
        continue;
      }
      violations.push(...validateStringField(`env.${key}.value`, rawValue, MCP_BRIDGE_LIMITS.maxEnvValueBytes, false));
      env[key] = rawValue;
    }
  }

  if (violations.length > 0) return { violations };

  const config: MCPServerConfig = { name, command, args, env };
  const configBytes = jsonByteSize(config);
  if (configBytes > MCP_BRIDGE_LIMITS.maxConfigBytesPerServer) {
    return {
      violations: [{
        field: "config",
        code: "config_too_large",
        message: "MCP server config exceeds the per-server byte limit.",
        actual: configBytes,
        limit: MCP_BRIDGE_LIMITS.maxConfigBytesPerServer,
      }],
    };
  }

  return { config, configBytes, violations: [] };
}

function validateListParams(
  params: unknown,
): { offset: number; limit: number; violations: ValidationViolation[] } {
  const violations: ValidationViolation[] = [];
  let offset = 0;
  let limit: number = MCP_BRIDGE_LIMITS.defaultListLimit;

  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
    return {
      offset,
      limit,
      violations: [{ field: "params", code: "invalid_type", message: "Parameters must be an object." }],
    };
  }

  const record = (params || {}) as Record<string, unknown>;
  if (record.offset !== undefined) {
    if (!Number.isInteger(record.offset) || Number(record.offset) < 0) {
      violations.push({
        field: "offset",
        code: "invalid_value",
        message: "offset must be a non-negative integer.",
      });
    } else {
      offset = Number(record.offset);
    }
  }
  if (record.limit !== undefined) {
    if (!Number.isInteger(record.limit) || Number(record.limit) < 1) {
      violations.push({
        field: "limit",
        code: "invalid_value",
        message: "limit must be a positive integer.",
      });
    } else if (Number(record.limit) > MCP_BRIDGE_LIMITS.maxListLimit) {
      violations.push({
        field: "limit",
        code: "limit_too_large",
        message: "limit exceeds the maximum page size.",
        actual: Number(record.limit),
        limit: MCP_BRIDGE_LIMITS.maxListLimit,
      });
    } else {
      limit = Number(record.limit);
    }
  }
  return { offset, limit, violations };
}

/**
 * MCP Bridge Extension.
 * Registers MCP servers defined in settings and exposes tools via pi tool registry.
 *
 * Pattern adapted from:
 * - opencode/packages/llm/src/tool.ts (MIT) — MCP tool type system
 * - Tallow/mcp-adapter-tool (MIT) — pi extension MCP integration
 */
export default function (pi: ExtensionAPI) {
  const registry = new Map<string, MCPRegistryEntry>();
  let totalConfigBytes = 0;
  const registerParams = Type.Object({
    command: Type.String({ description: "MCP server command" }),
    args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments" })),
    env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment variables" })),
    name: Type.String({ description: "Server name for reference" }),
  });
  const listParams = Type.Object({
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based page offset" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum entries to return on this page" })),
  });
  const resetParams = Type.Object({});

  // Load MCP server configs from pi settings or defaults
  function loadServers(): void {
    // In production: read from settings.json mcpServers field
    // For now: discover from common paths
    const defaultServers: MCPServerConfig[] = [
      // Example: filesystem MCP server
      // { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/"] },
    ];
    for (const config of defaultServers) {
      const configBytes = jsonByteSize(config);
      registry.set(config.name, { config, configBytes });
      totalConfigBytes += configBytes;
    }
  }

  loadServers();

  // Registry tool. Named mcp_register (not mcp_connect): nothing is connected.
  const registerTool = defineTool<typeof registerParams, RegisterToolDetails>({
    name: "mcp_register",
    label: "MCP Register / MCP登记",
    description: `Register or update an MCP server definition (REGISTRY ONLY — transport NOT implemented).
This records the server config for later use; it does NOT connect, does NOT spawn the server,
and does NOT expose the server's tools in this session. Use pi's native MCP support for real connections.`,
    parameters: registerParams,
    async execute(_id: string, params: Static<typeof registerParams>) {
      const validated = validateRegisterParams(params);
      if (!validated.config || validated.configBytes === undefined) {
        return registryError("MCP registry validation failed.", {
          code: "mcp_registry_validation_failed",
          violations: validated.violations,
          registry: currentRegistryState(registry.size, totalConfigBytes),
        });
      }

      const existing = registry.get(validated.config.name);
      const projectedRegisteredServers = existing ? registry.size : registry.size + 1;
      if (projectedRegisteredServers > MCP_BRIDGE_LIMITS.maxRegisteredServers) {
        return registryError("MCP registry capacity exceeded.", {
          code: "mcp_registry_limit_exceeded",
          violations: [{
            field: "registry",
            code: "max_registered_servers",
            message: "Registering this server would exceed the registry count limit.",
            actual: projectedRegisteredServers,
            limit: MCP_BRIDGE_LIMITS.maxRegisteredServers,
          }],
          registry: currentRegistryState(registry.size, totalConfigBytes),
        });
      }

      const projectedTotalConfigBytes =
        totalConfigBytes - (existing?.configBytes || 0) + validated.configBytes;
      if (projectedTotalConfigBytes > MCP_BRIDGE_LIMITS.maxConfigBytesTotal) {
        return registryError("MCP registry capacity exceeded.", {
          code: "mcp_registry_limit_exceeded",
          violations: [{
            field: "registry",
            code: "max_total_config_bytes",
            message: "Registering this server would exceed the total registry byte limit.",
            actual: projectedTotalConfigBytes,
            limit: MCP_BRIDGE_LIMITS.maxConfigBytesTotal,
          }],
          registry: currentRegistryState(registry.size, totalConfigBytes),
        });
      }

      registry.set(validated.config.name, {
        config: validated.config,
        configBytes: validated.configBytes,
      });
      totalConfigBytes = projectedTotalConfigBytes;

      return {
        content: [{
          type: "text" as const,
          text: `✅ MCP server "${validated.config.name}" recorded in the registry.\nCommand: ${validated.config.command}${validated.config.args.length ? ` ${validated.config.args.join(" ")}` : ""}\n⚠️ NOT connected: stdio transport is not implemented, so no tools from this server are available in this session. This entry is metadata for a future transport implementation.`,
        }],
        details: {
          code: "ok",
          violations: [],
          registry: currentRegistryState(registry.size, totalConfigBytes),
          registeredServers: registry.size,
          totalConfigBytes,
          configBytes: validated.configBytes,
          updatedExisting: Boolean(existing),
        } as RegisterSuccessDetails,
      };
    },
  });
  pi.registerTool?.(registerTool);

  // Register mcp_list tool
  const listTool = defineTool<typeof listParams, ListToolDetails>({
    name: "mcp_list",
    label: "MCP List / MCP列表",
    description: "List registered MCP servers with pagination and response byte caps.",
    parameters: listParams,
    async execute(_id: string, params: Static<typeof listParams>) {
      const validated = validateListParams(params);
      if (validated.violations.length > 0) {
        return registryError("MCP list validation failed.", {
          code: "mcp_list_validation_failed",
          violations: validated.violations,
          registry: currentRegistryState(registry.size, totalConfigBytes),
        });
      }

      const entries = Array.from(registry.values());
      if (entries.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No MCP servers registered. Use mcp_register to record one (registry only — no live connections).",
          }],
          details: {
            code: "ok",
            violations: [],
            registry: currentRegistryState(0, 0),
            items: [],
            offset: validated.offset,
            limit: validated.limit,
            nextOffset: undefined,
            registeredServers: 0,
            totalConfigBytes: 0,
            responseBytes: 0,
            responseByteCap: MCP_BRIDGE_LIMITS.listResponseByteCap,
            truncatedByByteCap: false,
          } as ListSuccessDetails,
        };
      }

      const offset = Math.min(validated.offset, entries.length);
      const requestedEntries = entries.slice(offset, offset + validated.limit);
      const lines: string[] = [];
      const includedEntries: MCPRegistryEntry[] = [];
      const header = `# MCP Servers / MCP服务器 (${entries.length})`;
      let truncatedByByteCap = false;
      for (const entry of requestedEntries) {
        const nextLines = [...lines, renderEntryLine(entry)];
        const nextText = `${header}\n\n${nextLines.join("\n")}`;
        if (stringByteSize(nextText) > MCP_BRIDGE_LIMITS.listResponseByteCap) {
          truncatedByByteCap = true;
          break;
        }
        lines.push(renderEntryLine(entry));
        includedEntries.push(entry);
      }

      const text = lines.length > 0 ? `${header}\n\n${lines.join("\n")}` : header;
      const consumedEntries = includedEntries.length;
      const nextOffset =
        truncatedByByteCap ? offset + consumedEntries :
          offset + requestedEntries.length < entries.length ? offset + requestedEntries.length : undefined;

      return {
        content: [{ type: "text" as const, text }],
        details: {
          code: "ok",
          violations: [],
          registry: currentRegistryState(entries.length, totalConfigBytes),
          items: includedEntries.map(summarizeEntry),
          offset,
          limit: validated.limit,
          nextOffset,
          registeredServers: entries.length,
          totalConfigBytes,
          responseBytes: stringByteSize(text),
          responseByteCap: MCP_BRIDGE_LIMITS.listResponseByteCap,
          truncatedByByteCap,
        } as ListSuccessDetails,
      };
    },
  });
  pi.registerTool?.(listTool);

  const resetTool = defineTool<typeof resetParams, ResetToolDetails>({
    name: "mcp_reset",
    label: "MCP Reset / MCP重置",
    description: "Clear all session-local MCP registry entries and release their reserved capacity.",
    parameters: resetParams,
    async execute() {
      const clearedServers = registry.size;
      const releasedBytes = totalConfigBytes;
      registry.clear();
      totalConfigBytes = 0;
      return {
        content: [{
          type: "text" as const,
          text: `Cleared ${clearedServers} MCP registry entr${clearedServers === 1 ? "y" : "ies"} and released ${releasedBytes} bytes.`,
        }],
        details: {
          clearedServers,
          releasedBytes,
          registeredServers: registry.size,
          totalConfigBytes,
        } as ResetSuccessDetails,
      };
    },
  });
  pi.registerTool?.(resetTool);
}
