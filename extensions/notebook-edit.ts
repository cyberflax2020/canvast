/**
 * =============================================================================
 * Canvast — Notebook Edit / Jupyter笔记本编辑
 * =============================================================================
 * @file        extensions/notebook-edit.ts
 * @brief       Edit Jupyter notebooks (.ipynb)
 * @author      Canvast Contributors  @license Apache-2.0  @copyright (c) 2026
 * Changes: [2026-08-08] Initial — JSON-based .ipynb manipulation
 * =============================================================================
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
  type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { isPathInside, isProtectedPath, resolveSandboxConfig } from "../src/harness/sandbox.js";

function failure(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }], details: undefined };
}

function fallbackAllowsWrite(requestedPath: string, targetPath: string): boolean {
  if (isProtectedPath(requestedPath) || isProtectedPath(targetPath)) return false;
  const workingDir = process.env.CANVAST_WORKING_DIR || process.cwd();
  const config = resolveSandboxConfig({
    env: process.env,
    workingDir,
    projectRoot: process.env.CANVAST_PROJECT_ROOT || workingDir,
  });
  return config.writableRoots.some(root => isPathInside(targetPath, root));
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function writeDescriptor(fd: number, content: string): void {
  const bytes = Buffer.from(content, "utf-8");
  ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < bytes.length) {
    offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  }
  fsyncSync(fd);
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "notebook_edit",
    label: "Notebook Edit / 笔记本编辑",
    description: "Edit Jupyter notebook (.ipynb) cells. Supports replace, insert, delete.",
    parameters: Type.Object({
      notebook_path: Type.String({ description: "Path to .ipynb file" }),
      cell_id: Type.Optional(Type.String({ description: "Cell ID for replace/delete" })),
      new_source: Type.Optional(Type.String({ description: "New cell source" })),
      cell_type: Type.Optional(Type.Union([Type.Literal("code"), Type.Literal("markdown")])),
      edit_mode: Type.Optional(Type.Union([Type.Literal("replace"), Type.Literal("insert"), Type.Literal("delete")])),
    }),
    async execute(_id: string, params: any) {
      const { notebook_path, cell_id, new_source, cell_type, edit_mode = "replace" } = params;
      const workingDir = process.env.CANVAST_WORKING_DIR || process.cwd();
      const requestedPath = resolve(workingDir, notebook_path);

      if (!existsSync(requestedPath)) return failure(`Notebook not found: ${requestedPath}`);

      let descriptor: number | undefined;
      try {
        const targetPath = realpathSync.native(requestedPath);
        const validatedIdentity = lstatSync(targetPath);
        if (!validatedIdentity.isFile()) {
          return failure(`Notebook edit blocked because the validated target is not a regular file: ${targetPath}`);
        }
        const sandbox = (pi as any).__canvast_sandbox;
        const onceApprovals: WeakMap<object, string> | undefined = (pi as any).__canvast_notebook_once_approvals;
        const approvedOnceTarget = onceApprovals?.get(params);
        if (approvedOnceTarget !== undefined) onceApprovals?.delete(params);
        if (isProtectedPath(requestedPath) || isProtectedPath(targetPath)) {
          return failure(`Notebook edit blocked for a protected path: ${requestedPath}`);
        }
        if (sandbox) {
          const decision = sandbox.decideFileAccess("notebook_edit", requestedPath, workingDir);
          if (decision.action !== "allow" && approvedOnceTarget !== targetPath) {
            return failure(`Notebook edit blocked by sandbox policy: ${decision.reason}`);
          }
        } else {
          if (!fallbackAllowsWrite(requestedPath, targetPath)) {
            return failure(`Notebook edit blocked outside the workspace or for a protected path: ${targetPath}`);
          }
        }

        descriptor = openSync(targetPath, constants.O_RDWR | constants.O_NOFOLLOW);
        const openedIdentity = fstatSync(descriptor);
        if (!openedIdentity.isFile() || !sameIdentity(validatedIdentity, openedIdentity)) {
          return failure("Notebook edit blocked because the target identity changed before open.");
        }

        const nb = JSON.parse(readFileSync(descriptor, "utf-8"));
        if (!Array.isArray(nb.cells)) return failure("Not a valid Jupyter notebook.");

        let result = "";

        if (edit_mode === "delete" && cell_id) {
          const idx = nb.cells.findIndex((c: any) => c.id === cell_id);
          if (idx === -1) return failure(`Cell ${cell_id} not found.`);
          nb.cells.splice(idx, 1);
          result = `Deleted cell ${cell_id}`;
        } else if (edit_mode === "insert") {
          if (new_source === undefined || !cell_type) return failure("new_source and cell_type required for insert.");
          const newCell = { cell_type, source: new_source.split("\n"), metadata: {}, id: `cell_${Date.now()}` };
          if (cell_id) {
            const idx = nb.cells.findIndex((c: any) => c.id === cell_id);
            if (idx === -1) return failure(`Cell ${cell_id} not found.`);
            nb.cells.splice(idx + 1, 0, newCell);
          } else {
            nb.cells.push(newCell);
          }
          result = `Inserted ${cell_type} cell after ${cell_id || "end"}`;
        } else if (edit_mode === "replace" && cell_id && new_source !== undefined) {
          const cell = nb.cells.find((c: any) => c.id === cell_id);
          if (!cell) return failure(`Cell ${cell_id} not found.`);
          cell.source = new_source.split("\n");
          if (cell_type) cell.cell_type = cell_type;
          result = `Replaced cell ${cell_id}`;
        } else {
          return failure(`Invalid ${edit_mode} request: required cell parameters are missing.`);
        }

        const writeTarget = realpathSync.native(requestedPath);
        const writeIdentity = lstatSync(writeTarget);
        if (writeTarget !== targetPath || !sameIdentity(writeIdentity, openedIdentity)) {
          return failure("Notebook edit blocked because the target changed before write.");
        }
        if (sandbox) {
          const decision = sandbox.decideFileAccess("notebook_edit", requestedPath, workingDir);
          if (decision.action !== "allow" && approvedOnceTarget !== writeTarget) {
            return failure(`Notebook edit blocked by sandbox policy before write: ${decision.reason}`);
          }
        } else if (!fallbackAllowsWrite(requestedPath, writeTarget)) {
          return failure(`Notebook edit blocked outside the workspace or for a protected path: ${writeTarget}`);
        }
        writeDescriptor(descriptor, JSON.stringify(nb, null, 1));
        return { content: [{ type: "text" as const, text: `✅ ${result}\nNotebook: ${targetPath} (${nb.cells.length} cells)` }], details: undefined };
      } catch (err: any) {
        return failure(`Notebook edit failed: ${err.message}`);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
  });
}
