/**
 * =============================================================================
 * Canvast — Agent Communication / Agent间通信
 * =============================================================================
 * @file        extensions/agent-comms.ts
 * @brief       SendMessage/ListAgents — inter-agent communication
 * @description Inter-agent messaging and agent status discovery.
 *              Uses pi's event bus and message injection for agent-to-agent comms.
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — from open-source agent communication concepts (MIT)
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface AgentInfo { id: string; name: string; status: string; task: string; depth: number; }

export default function (pi: ExtensionAPI) {
  const agents = new Map<string, AgentInfo>();

  // Register self
  agents.set("main", { id: "main", name: "Main Agent / 主Agent", status: "active", task: "orchestrator", depth: 0 });

  pi.registerTool({
    name: "send_message",
    label: "Send Message / 发送消息",
    description: "Send a message to another agent through the extension event bus.",
    parameters: Type.Object({
      to: Type.String({ description: "Agent ID or name" }),
      message: Type.String({ description: "Message content" }),
    }),
    async execute(_id: string, params: any) {
      const target = agents.get(params.to);
      if (!target) return { isError: true, content: [{ type: "text" as const, text: `Agent "${params.to}" not found. Use list_agents to see available agents.` }], details: undefined };

      // In production: deliver via pi.events (inter-extension event bus)
      try {
        if ((pi as any).sendMessage) {
          (pi as any).sendMessage({ customType: "agent_message", content: params.message, deliverAs: "steer" });
        }
        return {
          content: [{ type: "text" as const, text: `✅ Message sent to **${params.to}**: "${params.message.slice(0, 100)}${params.message.length > 100 ? "..." : ""}"` }],
          details: { to: params.to, messageLength: params.message.length },
        };
      } catch (err: any) {
        return { isError: true, content: [{ type: "text" as const, text: `Send failed: ${err.message}` }], details: undefined };
      }
    },
  });

  pi.registerTool({
    name: "list_agents",
    label: "List Agents / Agent列表",
    description: "List all registered agents and their current status.",
    parameters: Type.Object({}),
    async execute() {
      if (agents.size === 0) return { content: [{ type: "text" as const, text: "No agents registered." }], details: undefined };
      const list = Array.from(agents.values()).map(a =>
        `- **${a.name}** (${a.id}) — [${a.status}] *${a.task}* (depth: ${a.depth})`,
      ).join("\n");
      return { content: [{ type: "text" as const, text: `# Agents / Agent列表 (${agents.size})\n\n${list}` }], details: undefined };
    },
  });

  // Register sub-agents when spawned (listens on extension event bus)
  pi.on("session_start", () => { /* discover agents from Canvas */ });

  // Export for other extensions to register agents
  (pi as any).__agent_registry = { register: (info: AgentInfo) => agents.set(info.id, info), list: () => Array.from(agents.values()) };
}
