"use client";

import type { ApprovalDecision, RunQuestion } from "@hr/contracts";
import { HelpCircle, Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api";
import { useResumeRun } from "@/lib/agent-queries";
import { ApprovalCard } from "./approval-card";

/** What the run is waiting for: an approval, a missing value, a clarification, or a choice. */
export function QuestionPanel({
  runId,
  question,
  compact = false,
}: {
  runId: string;
  question: RunQuestion;
  compact?: boolean;
}) {
  const resume = useResumeRun(runId);
  const [text, setText] = useState("");

  function answer(value: string | ApprovalDecision) {
    resume.mutate(value, {
      onSuccess: () => setText(""),
      onError: (error) => toast.error(errorMessage(error)),
    });
  }

  if (question.type === "approval") {
    return (
      <ApprovalCard
        key={`${question.step}:${question.error ?? ""}`}
        question={question}
        onDecide={answer}
        pending={resume.isPending}
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
      <CardContent className="space-y-3">
        {question.type === "value" && question.error && (
          <Alert variant="destructive">
            <AlertDescription>{question.error}</AlertDescription>
          </Alert>
        )}
        {question.type === "choice" ? (
          <div className="flex flex-col gap-2">
            {question.options.map((option) => (
              <Button
                key={option}
                variant="outline"
                className="h-auto justify-start py-2 text-left whitespace-normal"
                disabled={resume.isPending}
                onClick={() => answer(option)}
              >
                {option}
              </Button>
            ))}
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) answer(text.trim());
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Your answer"
              maxLength={2000}
              autoFocus={!compact}
            />
            <Button type="submit" disabled={resume.isPending || !text.trim()}>
              <Send />
              Answer
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
