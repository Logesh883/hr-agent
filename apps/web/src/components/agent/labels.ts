import type { RunEvent, RunStatus } from "@hr/contracts";

/** "create_employee" → "Create employee". */
export function humanize(name: string | null | undefined): string {
  if (!name) return "—";
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const runStatusLabels: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Needs you",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

/** Graph nodes, as people would say them. */
const nodeLabels: Record<string, string> = {
  understand: "Understanding the request",
  route: "Choosing how to handle it",
  retrieve_policy: "Looking up policy",
  plan: "Planning",
  validate_plan: "Checking the plan",
  route_next: "Next step",
  ask_value: "Asking for a missing value",
  approve: "Waiting for approval",
  execute_step: "Running a step",
  verify: "Verifying the result",
  respond: "Writing the answer",
  answer: "Answering",
  clarify: "Asking a question",
  refuse: "Declining",
};

export type Tone = "positive" | "warning" | "negative" | "info" | "neutral";

/** One line of the execution timeline for an event. */
export function describeEvent(event: RunEvent): { text: string; tone: Tone; detail?: string } {
  switch (event.event) {
    case "run_started":
      return { text: "Run started", tone: "info" };
    case "run_resumed":
      return {
        text: "Continued with your answer",
        tone: "info",
        detail:
          typeof event.answer === "string"
            ? event.answer
            : event.answer && typeof event.answer === "object" && "decision" in event.answer
              ? String((event.answer as { decision: unknown }).decision)
              : undefined,
      };
    case "node_started":
      return { text: nodeLabels[event.node] ?? humanize(event.node), tone: "neutral" };
    case "node_finished":
      return { text: `${nodeLabels[event.node] ?? humanize(event.node)}: done`, tone: "neutral" };
    case "tool_started":
      return {
        text: `${event.step}: ${humanize(event.tool)}`,
        tone: "info",
        detail: event.attempt && event.attempt > 1 ? `attempt ${event.attempt}` : undefined,
      };
    case "tool_finished":
      return {
        text: `${event.step}: ${humanize(event.tool)} ${event.ok ? "finished" : "failed"}`,
        tone: event.ok ? "positive" : "negative",
      };
    case "tool_retry":
      return {
        text: `${event.step}: retrying in ${event.after_s.toFixed(1)} s`,
        tone: "warning",
        detail: event.error ?? undefined,
      };
    case "verified":
      return {
        text: `${event.step}: ${event.ok ? "verified" : "didn't check out"}`,
        tone: event.ok ? "positive" : "negative",
        detail: event.mismatches.join("; ") || undefined,
      };
    case "compensated":
      return { text: `${event.step}: undone`, tone: "warning", detail: event.note };
    case "approval_decided":
      return {
        text: `${event.step}: ${humanize(event.tool)} ${event.decision}`,
        tone: event.decision === "rejected" ? "negative" : "positive",
      };
    case "waiting":
      return { text: event.type === "approval" ? "Waiting for approval" : "Waiting for an answer", tone: "warning", detail: event.question };
    case "budget_exceeded":
      return { text: "Stopped: over budget", tone: "negative", detail: event.reason };
    case "finished":
      return {
        text: event.status === "failed" ? "Finished with a failure" : "Finished",
        tone: event.status === "failed" ? "negative" : "positive",
      };
    case "failed":
      return { text: "Run failed", tone: "negative", detail: event.error };
  }
}

/** Step statuses from the run's progress. */
export function stepTone(status: string): Tone {
  if (["verified", "done"].includes(status)) return "positive";
  if (["failed", "mismatch", "rejected"].includes(status)) return "negative";
  if (["compensated", "skipped", "not run"].includes(status)) return "warning";
  return "neutral";
}
