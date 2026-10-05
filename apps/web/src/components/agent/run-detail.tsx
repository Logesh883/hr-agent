"use client";

import type { RunProgress, RunQuestion, RunView } from "@hr/contracts";
import {
  AlertTriangle,
  Ban,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  CircleDashed,
  ListChecks,
  Loader2,
  Play,
  ScrollText,
  Sparkles,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { StreamedEvent } from "@/lib/ai";
import { errorMessage } from "@/lib/api";
import { useResumeRun, useRunTimeline } from "@/lib/agent-queries";
import { formatDate, formatDateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { RiskBadge, RunStatusBadge, ToneBadge } from "./badges";
import { describeEvent, humanize, stepTone } from "./labels";
import { Markdown } from "./markdown";
import { AnswerForm, QuestionPanel } from "./question-panel";
import { RunTimeline } from "./run-timeline";

/** T4.6: one agent run in the Command Center, read as a conversation. */
export function RunDetail({ run }: { run: RunView }) {
  const timeline = useRunTimeline(run.id, run.status);
  const progress = run.progress;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0 space-y-6">
        <Header run={run} />
        {run.status === "interrupted" && <Interrupted runId={run.id} />}
        <Conversation run={run} events={timeline.events} />
        {run.status === "waiting" && run.question?.type === "approval" && (
          <QuestionPanel runId={run.id} question={run.question} />
        )}
        {progress?.verification && <Verification verification={progress.verification} />}
        {progress?.plan && progress.plan.steps.length > 0 && <Plan progress={progress} />}
        {progress && progress.passages.length > 0 && <Evidence progress={progress} />}
      </div>

      <aside className="space-y-4 lg:sticky lg:top-6 lg:self-start">
        {progress && <Understanding progress={progress} waiting={run.status === "waiting"} />}
        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="text-sm">Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {timeline.error ? (
              <p className="text-sm text-muted-foreground">{errorMessage(timeline.error)}</p>
            ) : (
              <RunTimeline events={timeline.events} live={run.status === "running"} />
            )}
          </CardContent>
        </Card>
        <TraceCard run={run} />
      </aside>
    </div>
  );
}

function Header({ run }: { run: RunView }) {
  const intent = run.progress?.intent;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <RunStatusBadge status={run.status} />
        {intent && intent !== "unknown" && (
          <>
            <span>{humanize(intent)}</span>
            <span aria-hidden>·</span>
          </>
        )}
        <span>{formatDateTime(run.started_at)}</span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight text-balance">{run.request}</h1>
    </div>
  );
}

// ---- the conversation ---------------------------------------------------------------------

function Conversation({ run, events }: { run: RunView; events: StreamedEvent[] }) {
  const progress = run.progress;
  const question = run.status === "waiting" ? run.question : null;
  const outcome = outcomeOf(run);

  return (
    <Card className="gap-0 py-0">
      <CardContent className="space-y-5 p-5">
        <YouSay>{run.request}</YouSay>
        {progress?.clarifications.map((c, i) => (
          <div key={i} className="space-y-5">
            <AgentSays>{c.question}</AgentSays>
            <YouSay>{c.answer}</YouSay>
          </div>
        ))}

        {question && question.type !== "approval" && (
          <AgentSays highlight>
            <p className="font-medium">{question.question}</p>
            {progress && <StillNeeded progress={progress} />}
            <div className="mt-3">
              <AnswerForm runId={run.id} question={question as Exclude<RunQuestion, { type: "approval" }>} />
            </div>
          </AgentSays>
        )}
        {question?.type === "approval" && (
          <AgentSays>
            <p>
              Before I go ahead, I need your approval for{" "}
              <span className="font-medium">{question.summary ?? humanize(question.tool)}</span>. Review it below.
            </p>
          </AgentSays>
        )}

        {run.status === "running" && <Working events={events} />}

        {outcome && (
          <AgentSays tone={outcome.tone}>
            {outcome.title && (
              <p className={cn("mb-2 flex items-center gap-1.5 text-sm font-medium", outcomeText[outcome.tone])}>
                <outcome.icon className="size-4" />
                {outcome.title}
              </p>
            )}
            {outcome.body ? <Markdown text={outcome.body} /> : null}
          </AgentSays>
        )}
      </CardContent>
    </Card>
  );
}

type OutcomeTone = "ok" | "warn" | "bad";
const outcomeText: Record<OutcomeTone, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  warn: "text-amber-700 dark:text-amber-400",
  bad: "text-red-700 dark:text-red-400",
};

function outcomeOf(run: RunView) {
  if (run.status === "failed" && !run.answer) {
    return { tone: "bad" as const, icon: XCircle, title: "The run failed", body: run.error ?? "Something went wrong." };
  }
  if (!run.answer) return null;
  const progress = run.progress;
  if (progress?.refusal) {
    return { tone: "warn" as const, icon: AlertTriangle, title: "Nothing was changed", body: run.answer };
  }
  if (run.status === "failed" || progress?.stopped) {
    return {
      tone: "warn" as const,
      icon: AlertTriangle,
      title: progress?.stopped ? `Stopped early: ${progress.stopped}` : "Finished with problems",
      body: run.answer,
    };
  }
  return { tone: "ok" as const, icon: CheckCircle2, title: null, body: run.answer };
}

function YouSay({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm whitespace-pre-wrap text-primary-foreground">
        {children}
      </div>
    </div>
  );
}

const agentBorders: Record<OutcomeTone | "highlight" | "plain", string> = {
  plain: "border-transparent bg-muted/60",
  highlight: "border-amber-500/40 bg-amber-500/5",
  ok: "border-transparent bg-muted/60",
  warn: "border-amber-500/40 bg-amber-500/5",
  bad: "border-red-500/40 bg-red-500/5",
};

function AgentSays({
  children,
  highlight = false,
  tone,
}: {
  children: React.ReactNode;
  highlight?: boolean;
  tone?: OutcomeTone;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Sparkles className="size-3.5" />
      </span>
      <div
        className={cn(
          "min-w-0 flex-1 rounded-2xl rounded-tl-md border px-4 py-3 text-sm",
          agentBorders[tone ?? (highlight ? "highlight" : "plain")],
        )}
      >
        {children}
      </div>
    </div>
  );
}

const QUIET = new Set(["node_finished", "run_started", "run_resumed"]);

function Working({ events }: { events: StreamedEvent[] }) {
  const last = [...events].reverse().find((e) => !QUIET.has(e.event.event));
  return (
    <AgentSays>
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {last ? describeEvent(last.event).text : "Reading your request"}…
      </p>
    </AgentSays>
  );
}

/** Under a question: what the agent already has and what it still needs. */
function StillNeeded({ progress }: { progress: RunProgress }) {
  const facts = factsOf(progress);
  if (facts.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {facts.map((fact) =>
        fact.value === null ? (
          <span
            key={fact.key}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-500/60 px-2.5 py-0.5 text-xs text-amber-800 dark:text-amber-300"
          >
            <CircleDashed className="size-3" />
            {fact.label} needed
          </span>
        ) : (
          <span
            key={fact.key}
            className="inline-flex items-center gap-1 rounded-full bg-background px-2.5 py-0.5 text-xs ring-1 ring-border"
          >
            <Check className="size-3 text-emerald-600" />
            <span className="text-muted-foreground">{fact.label}:</span> {fact.value}
          </span>
        ),
      )}
    </div>
  );
}

// ---- what the agent understood ------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  people: "Employee",
  job_title: "Job title",
  department: "Department",
  manager: "Manager",
  location: "Location",
  leave_type: "Leave type",
  document_type: "Document",
  joining_date: "Joining date",
  start_date: "From",
  end_date: "To",
};
const DATE_FIELDS = new Set(["joining_date", "start_date", "end_date"]);

type Fact = { key: string; label: string; value: string | null };

function factsOf(progress: RunProgress): Fact[] {
  const onboarding = progress.intent === "onboard_employee";
  const label = (key: string) => (key === "people" && onboarding ? "Name" : (FIELD_LABELS[key] ?? humanize(key)));
  const known: Fact[] = Object.entries(progress.entities)
    .filter(([key, value]) => value !== null && value !== "" && !(Array.isArray(value) && value.length === 0) && !progress.missing_fields.includes(key))
    .map(([key, value]) => ({
      key,
      label: label(key),
      value: Array.isArray(value)
        ? value.join(", ")
        : DATE_FIELDS.has(key)
          ? formatDate(String(value))
          : key.endsWith("_type")
            ? humanize(String(value).toLowerCase())
            : String(value),
    }));
  const missing: Fact[] = progress.missing_fields.map((key) => ({ key, label: label(key), value: null }));
  return [...known, ...missing];
}

function Understanding({ progress, waiting }: { progress: RunProgress; waiting: boolean }) {
  const facts = factsOf(progress);
  const confidence = progress.confidence != null ? Math.round(progress.confidence * 100) : null;
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="text-sm">What I understood</CardTitle>
        <CardDescription className="flex items-center gap-2">
          {humanize(progress.intent)}
          {confidence != null && (
            <span className="ml-auto flex items-center gap-1.5 text-xs" title="How sure the agent is of the intent">
              <span className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
                <span
                  className={cn("block h-full rounded-full", confidence >= 80 ? "bg-emerald-500" : confidence >= 60 ? "bg-amber-500" : "bg-red-500")}
                  style={{ width: `${confidence}%` }}
                />
              </span>
              {confidence}%
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {facts.length > 0 && (
          <ul className="space-y-1.5">
            {facts.map((fact) => (
              <li key={fact.key} className="flex items-start gap-2">
                {fact.value === null ? (
                  <CircleDashed className="mt-0.5 size-4 shrink-0 text-amber-600" />
                ) : (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                )}
                <span className="w-24 shrink-0 text-muted-foreground">{fact.label}</span>
                <span className={cn("min-w-0 break-words", fact.value === null && "text-amber-700 dark:text-amber-400")}>
                  {fact.value ?? (waiting ? "asking you" : "missing")}
                </span>
              </li>
            ))}
          </ul>
        )}
        {progress.policy.length > 0 && (
          <div className="border-t pt-3">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Policies consulted</p>
            <div className="flex flex-wrap gap-1">
              {[...new Set(progress.policy.map((p) => p.split(" §")[0]))].map((name) => (
                <span key={name} className="rounded border bg-muted/60 px-1.5 text-[11px] leading-5 text-muted-foreground">
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---- plan, evidence, verification ----------------------------------------------------------

function StepIcon({ status }: { status: string }) {
  const tone = stepTone(status);
  if (tone === "positive") return <CheckCircle2 className="size-5 text-emerald-600" />;
  if (tone === "negative") return status === "rejected" ? <Ban className="size-5 text-red-600" /> : <XCircle className="size-5 text-red-600" />;
  if (tone === "warning") return <AlertTriangle className="size-5 text-amber-600" />;
  return <Circle className="size-5 text-muted-foreground/50" />;
}

function Plan({ progress }: { progress: RunProgress }) {
  const plan = progress.plan!;
  const done = plan.steps.filter((s) => stepTone(s.status) === "positive").length;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4" />
          Plan
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {done} of {plan.steps.length} done
          </span>
        </CardTitle>
        {plan.goal && <CardDescription>{plan.goal}</CardDescription>}
      </CardHeader>
      <CardContent>
        <ol>
          {plan.steps.map((step, i) => (
            <li key={step.id} className="relative flex gap-3 pb-5 last:pb-0">
              {i < plan.steps.length - 1 && (
                <span className="absolute top-6 bottom-0 left-[9.5px] w-px bg-border" aria-hidden />
              )}
              <span className="relative bg-card">
                <StepIcon status={step.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{humanize(step.tool)}</span>
                  {step.risk && step.risk !== "low" && <RiskBadge risk={step.risk} />}
                  <span className="ml-auto">
                    <ToneBadge tone={stepTone(step.status)}>{humanize(step.status)}</ToneBadge>
                  </span>
                </div>
                {step.reason && <p className="mt-0.5 text-sm text-muted-foreground">{step.reason}</p>}
                {step.error && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{step.error}</p>}
                {step.result && (
                  <details className="group mt-1.5">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      <ChevronRight className="size-3 transition-transform group-open:rotate-90" />
                      Result
                    </summary>
                    <pre className="mt-1.5 max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
                      {pretty(step.result)}
                    </pre>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function Evidence({ progress }: { progress: RunProgress }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="size-4" />
          Policy evidence
        </CardTitle>
        <CardDescription>The passages the agent relied on, as it saw them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {progress.passages.map((passage) => (
          <details key={passage.citation} className="group rounded-lg border px-3 py-2">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium">
              <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
              {passage.citation}
            </summary>
            {passage.warning && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{passage.warning}</p>}
            <p className="mt-2 pl-6 text-sm whitespace-pre-wrap text-muted-foreground">{passage.text}</p>
          </details>
        ))}
      </CardContent>
    </Card>
  );
}

function Verification({ verification }: { verification: NonNullable<RunProgress["verification"]> }) {
  return (
    <Alert variant={verification.ok ? "default" : "destructive"} className={cn(verification.ok && "border-emerald-500/40 bg-emerald-500/5")}>
      {verification.ok ? <CheckCircle2 className="text-emerald-600" /> : <AlertTriangle />}
      <AlertTitle>{verification.ok ? "Verified: the records say what was intended" : "Verification found problems"}</AlertTitle>
      {verification.problems.length + verification.findings.length > 0 && (
        <AlertDescription>
          <ul className="list-disc pl-4">
            {[...verification.problems, ...verification.findings].map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}

function Interrupted({ runId }: { runId: string }) {
  const resume = useResumeRun(runId);
  return (
    <Alert>
      <AlertTriangle />
      <AlertTitle>This run was interrupted</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        The service restarted while it was running. Finished steps won&apos;t run again.
        <Button
          size="sm"
          disabled={resume.isPending}
          onClick={() => resume.mutate(null, { onError: (e) => toast.error(errorMessage(e)) })}
        >
          <Play />
          Continue
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function TraceCard({ run }: { run: RunView }) {
  const can = useCan();
  const usage = run.progress?.usage ?? {};
  const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <ScrollText className="size-4" />
          Audit and trace
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs text-muted-foreground">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt>Run</dt>
          <dd className="truncate font-mono" title={run.id}>{run.id}</dd>
          {tokens > 0 && (
            <>
              <dt>Tokens</dt>
              <dd>{tokens.toLocaleString("en-IN")}</dd>
            </>
          )}
          {run.trace_ids.length > 0 && (
            <>
              <dt>Traces</dt>
              <dd className="space-y-0.5 font-mono">
                {run.trace_ids.map((id) => (
                  <span key={id} className="block truncate" title={id}>{id}</span>
                ))}
              </dd>
            </>
          )}
        </dl>
        {can("audit:read") && (
          <Button asChild variant="outline" size="sm" className="w-full">
            <Link href={`/audit?agentRunId=${run.id}`}>Changes this run made</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
