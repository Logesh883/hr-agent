"use client";

import type { ApprovalDecision, RunQuestion } from "@hr/contracts";
import { ArrowUp, HelpCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useResumeRun } from "@/lib/agent-queries";
import { ApprovalCard } from "./approval-card";

type Answer = string | ApprovalDecision;

function useAnswer(runId: string) {
  const resume = useResumeRun(runId);
  const answer = (value: Answer, onDone?: () => void) =>
    resume.mutate(value, {
      onSuccess: onDone,
      onError: (error) => toast.error(errorMessage(error)),
    });
  return { answer, pending: resume.isPending };
}

/** What the run is waiting for, as a standalone card (the approval inbox). */
export function QuestionPanel({
  runId,
  question,
  compact = false,
}: {
  runId: string;
  question: RunQuestion;
  compact?: boolean;
}) {
  const { answer, pending } = useAnswer(runId);

  if (question.type === "approval") {
    return (
      <ApprovalCard
        key={`${question.step}:${question.error ?? ""}`}
        question={question}
        onDecide={answer}
        pending={pending}
        compact={compact}
      />
    );
  }

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <HelpCircle className="size-4 text-amber-600" />
          {question.question}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <AnswerForm runId={runId} question={question} autoFocus={!compact} />
      </CardContent>
    </Card>
  );
}

/** The reply box for a clarification, a missing value or a choice. */
export function AnswerForm({
  runId,
  question,
  autoFocus = true,
  placeholder = "Type your answer",
}: {
  runId: string;
  question: Exclude<RunQuestion, { type: "approval" }>;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const { answer, pending } = useAnswer(runId);
  const [text, setText] = useState("");

  return (
    <div className="space-y-3">
      {question.type === "value" && question.error && (
        <Alert variant="destructive">
          <AlertDescription>{question.error}</AlertDescription>
        </Alert>
      )}
      {question.type === "choice" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {question.options.map((option) => (
            <Button
              key={option}
              variant="outline"
              className="h-auto justify-start py-2.5 text-left whitespace-normal hover:border-primary/50"
              disabled={pending}
              onClick={() => answer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <form
          className="flex items-center gap-2 rounded-xl border bg-background p-1.5 pl-3 shadow-xs focus-within:ring-2 focus-within:ring-ring/40"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) answer(text.trim(), () => setText(""));
          }}
        >
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            maxLength={2000}
            autoFocus={autoFocus}
            aria-label="Your answer"
            className="h-8 border-0 px-0 shadow-none focus-visible:ring-0"
          />
          <Button type="submit" size="icon" className="size-8 shrink-0 rounded-lg" disabled={pending || !text.trim()}>
            <ArrowUp />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      )}
    </div>
  );
}
