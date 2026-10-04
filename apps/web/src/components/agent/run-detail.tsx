"use client";

import type { RunProgress, RunView } from "@hr/contracts";
import { AlertTriangle, BookOpen, CheckCircle2, ListChecks, Play, ScrollText, XCircle } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorMessage } from "@/lib/api";
import { useResumeRun, useRunTimeline } from "@/lib/agent-queries";
import { formatDateTime } from "@/lib/format";
import { useCan } from "@/lib/session";
import { RiskBadge, RunStatusBadge, ToneBadge } from "./badges";
import { humanize, stepTone } from "./labels";
import { Markdown } from "./markdown";
import { QuestionPanel } from "./question-panel";
import { RunTimeline } from "./run-timeline";

/** T4.6: one agent run in the Command Center. */
export function RunDetail({ run }: { run: RunView }) {
  const timeline = useRunTimeline(run.id, run.status);
  const progress = run.progress;

  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <RunStatusBadge status={run.status} />
            <span className="text-xs text-muted-foreground">Started {formatDateTime(run.started_at)}</span>
          </div>
          <p className="text-lg leading-snug">“{run.request}”</p>
        </div>

        {run.status === "waiting" && run.question && <QuestionPanel runId={run.id} question={run.question} />}
        {run.status === "interrupted" && <Interrupted runId={run.id} />}
        <Outcome run={run} />
        {progress?.plan && <Plan progress={progress} />}
        {progress && <Evidence progress={progress} />}
        {progress?.verification && <Verification verification={progress.verification} />}
      </div>

      <div className="space-y-6">
        {progress && <Understanding progress={progress} />}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timeline</CardTitle>
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
      </div>
    </div>
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

function Outcome({ run }: { run: RunView }) {
  if (run.status === "failed" && !run.answer) {
    return (
      <Alert variant="destructive">
        <XCircle />
        <AlertTitle>The run failed</AlertTitle>
        <AlertDescription>{run.error ?? "Something went wrong."}</AlertDescription>
      </Alert>
    );
  }
  if (!run.answer) return null;
  const stopped = run.progress?.stopped;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {run.status === "failed" || stopped ? (
            <AlertTriangle className="size-4 text-amber-600" />
          ) : (
            <CheckCircle2 className="size-4 text-emerald-600" />
          )}
          Answer
        </CardTitle>
        {stopped && <CardDescription>Stopped early: {stopped}</CardDescription>}
      </CardHeader>
      <CardContent>
        <Markdown text={run.answer} />
      </CardContent>
    </Card>
  );
}

function Plan({ progress }: { progress: RunProgress }) {
  const plan = progress.plan!;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4" />
          Plan
        </CardTitle>
        {plan.goal && <CardDescription>{plan.goal}</CardDescription>}
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {plan.steps.map((step) => (
            <li key={step.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{step.id}</span>
                <span className="font-medium">{humanize(step.tool)}</span>
                {step.risk && <RiskBadge risk={step.risk} />}
                <span className="ml-auto">
                  <ToneBadge tone={stepTone(step.status)}>{humanize(step.status)}</ToneBadge>
                </span>
              </div>
              {step.reason && <p className="mt-1 text-sm text-muted-foreground">{step.reason}</p>}
              {step.error && <p className="mt-1 text-sm text-red-700 dark:text-red-400">{step.error}</p>}
              {step.result && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">Result</summary>
                  <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
                    {pretty(step.result)}
                  </pre>
                </details>
              )}
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
  if (progress.passages.length === 0 && progress.clarifications.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="size-4" />
          Evidence
        </CardTitle>
        <CardDescription>What the agent relied on, as it saw it.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {progress.passages.map((passage) => (
          <blockquote key={passage.citation} className="border-l-2 pl-3 text-sm">
            <p className="font-medium">{passage.citation}</p>
            {passage.warning && (
              <p className="text-xs text-amber-700 dark:text-amber-400">{passage.warning}</p>
            )}
            <p className="mt-1 line-clamp-6 whitespace-pre-wrap text-muted-foreground">{passage.text}</p>
          </blockquote>
        ))}
        {progress.clarifications.length > 0 && (
          <div className="space-y-1 text-sm">
            <p className="font-medium">Your answers</p>
            {progress.clarifications.map((c, i) => (
              <p key={i} className="text-muted-foreground">
                {c.question} → <span className="text-foreground">{c.answer}</span>
              </p>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Verification({ verification }: { verification: NonNullable<RunProgress["verification"]> }) {
  return (
    <Alert variant={verification.ok ? "default" : "destructive"}>
      {verification.ok ? <CheckCircle2 /> : <AlertTriangle />}
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

function Understanding({ progress }: { progress: RunProgress }) {
  const entities = Object.entries(progress.entities);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Understood as</CardTitle>
        <CardDescription>
          {humanize(progress.intent)}
          {progress.confidence != null && ` · ${Math.round(progress.confidence * 100)}% sure`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {entities.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {entities.map(([key, value]) => (
              <div key={key} className="contents">
                <dt className="text-muted-foreground">{humanize(key)}</dt>
                <dd className="break-words">{Array.isArray(value) ? value.join(", ") : String(value)}</dd>
              </div>
            ))}
          </dl>
        )}
        {progress.missing_fields.length > 0 && (
          <p className="text-amber-700 dark:text-amber-400">
            Missing: {progress.missing_fields.map(humanize).join(", ")}
          </p>
        )}
        {progress.refusal && <p className="text-red-700 dark:text-red-400">{progress.refusal}</p>}
        {progress.policy.length > 0 && (
          <p className="text-xs text-muted-foreground">Policy: {progress.policy.join(" · ")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function TraceCard({ run }: { run: RunView }) {
  const can = useCan();
  const usage = run.progress?.usage ?? {};
  const tokens = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScrollText className="size-4" />
          Audit and trace
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Run <span className="font-mono text-xs">{run.id}</span>
        </p>
        {tokens > 0 && <p className="text-muted-foreground">{tokens.toLocaleString("en-IN")} tokens</p>}
        {run.trace_ids.length > 0 && (
          <p className="text-muted-foreground">
            Traces: <span className="font-mono text-xs break-all">{run.trace_ids.join(", ")}</span>
          </p>
        )}
        {can("audit:read") && (
          <Button asChild variant="outline" size="sm">
            <Link href={`/audit?agentRunId=${run.id}`}>Changes this run made</Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
