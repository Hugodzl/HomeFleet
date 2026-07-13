/**
 * Toolset composition for the agent executors: the one place that imports
 * BOTH the read-only tools (tools.ts) and the write tools (write-tools.ts),
 * so neither of those modules needs to import the other (write-tools.ts
 * already imports makeTool/containment helpers from tools.ts; composing
 * here keeps the graph acyclic).
 */
import type { CommandAllowlist } from "../spawn.js";
import {
  type AgentTool,
  globTool,
  grepTool,
  listDirTool,
  readFileTool,
  runCommandTool,
} from "./tools.js";
import { editFileTool, writeFileTool } from "./write-tools.js";

export interface BuildToolsetOptions {
  /**
   * Advertise write_file/edit_file (v0.2 code-writing delegation). Off by
   * default: read-only jobs must never hand the model a write surface.
   */
  includeWriteTools?: boolean;
}

/**
 * The advertised toolset. run_command is present only when the allowlist
 * has entries — an empty allowlist disables the tool AND omits it from the
 * definitions sent to the model. The write tools appear only when opted in
 * via {@link BuildToolsetOptions.includeWriteTools}.
 */
export function buildToolset(
  commandAllowlist: CommandAllowlist,
  options: BuildToolsetOptions = {},
): AgentTool[] {
  const tools = [readFileTool, listDirTool, grepTool, globTool];
  if (options.includeWriteTools === true) {
    tools.push(writeFileTool, editFileTool);
  }
  if (Object.keys(commandAllowlist).length > 0) {
    tools.push(runCommandTool(commandAllowlist));
  }
  return tools;
}
