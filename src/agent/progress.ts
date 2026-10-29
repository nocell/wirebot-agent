import { basename } from "node:path";
import type { ProgressAction, ProgressPlanStep } from "../core/channel.js";
import { compactTruncate } from "../shared/text.js";

/** One progress line for a tool call the agent started. */
export function toolActionLabel(name: string, input: unknown): ProgressAction {
  const fields = isRecord(input) ? input : {};
  const text = (key: string): string | undefined => {
    const value = fields[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };
  const file = (key: string): string => basename(text(key) ?? "file");
  switch (name) {
    case "Bash":
      return { label: `Running   ${compactTruncate(text("command") ?? "a command", 120)}` };
    case "Read":
      return { label: `Reading   ${file("file_path")}` };
    case "Write":
      return { label: `Writing   ${file("file_path")}` };
    case "Edit":
    case "MultiEdit":
      return { label: `Editing   ${file("file_path")}` };
    case "NotebookEdit":
      return { label: `Editing   ${file("notebook_path")}` };
    case "Glob":
      return { label: `Listing   ${compactTruncate(text("pattern") ?? "files", 80)}` };
    case "Grep":
      return { label: `Searching ${compactTruncate(text("pattern") ?? "files", 80)}` };
    case "WebSearch":
      return { label: `Searching ${compactTruncate(text("query") ?? "the web", 80)}` };
    case "WebFetch":
      return { label: `Fetching  ${compactTruncate(text("url") ?? "a page", 80)}` };
    case "Task":
    case "Agent":
      return { label: `Delegating ${compactTruncate(text("description") ?? "a subtask", 80)}` };
    case "AskUserQuestion":
      return { label: "Asking    a question" };
    case "Skill":
      return { label: `Using skill ${text("skill") ?? text("command") ?? ""}`.trimEnd() };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
      return { label: mcp === null ? `Using     ${name}` : `Calling   ${mcp[1]}.${mcp[2]}` };
    }
  }
}

/** The agent's TodoWrite list rendered as a progress plan; undefined for other tools. */
export function todoPlan(name: string, input: unknown): readonly ProgressPlanStep[] | undefined {
  if (name !== "TodoWrite" || !isRecord(input) || !Array.isArray(input.todos)) return undefined;
  return input.todos.flatMap((todo): ProgressPlanStep[] => {
    if (!isRecord(todo) || typeof todo.content !== "string") return [];
    const status =
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "inProgress"
          : "pending";
    return [{ step: todo.content, status }];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
