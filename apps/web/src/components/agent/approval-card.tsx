"use client";

import type { ApprovalDecision, ApprovalQuestion } from "@hr/contracts";
import { AlertTriangle, Check, Pencil, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RiskBadge } from "./badges";
import { BeforeAfter } from "./before-after";
import { humanize } from "./labels";

type Mode = "view" | "reject" | "edit";

/**
 * T4.4: an action the agent is holding for a person. It shows exactly what would change
 * (before → after, with names), why, the risk, and anything the rules already object to.
 * Approve runs exactly these arguments; reject stops this step and every later one.
 */
export function ApprovalCard({
  question,
  onDecide,
  pending,
  compact = false,
}: {
  question: ApprovalQuestion;
  onDecide: (decision: ApprovalDecision) => void;
  pending: boolean;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("view");
  const [reason, setReason] = useState("");
  const editable = Object.entries(question.arguments).filter(
    ([, value]) => value === null || ["string", "number"].includes(typeof value),
  );
  const [edits, setEdits] = useState<Record<string, string>>(() =>
    Object.fromEntries(editable.map(([key, value]) => [key, value === null ? "" : String(value)])),
  );
  const changed = Object.fromEntries(
    editable
      .filter(([key, value]) => edits[key] !== (value === null ? "" : String(value)))
      .map(([key, value]) => [key, typeof value === "number" ? Number(edits[key]) : edits[key] || null]),
  );

  return (
    <Card className="border-amber-500/40">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ShieldAlert className="size-4 text-amber-600" />
          <CardTitle className="text-base">{question.summary ?? question.question}</CardTitle>
          <RiskBadge risk={question.risk} />
        </div>
        <CardDescription>
          Step {question.step}: {humanize(question.tool)}
          {question.reason && <> · {question.reason}</>}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {question.problems.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>The rules object to this</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {question.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
        {question.error && (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertDescription>{question.error}</AlertDescription>
          </Alert>
        )}
        <BeforeAfter before={question.before} after={question.after} />
        {!compact && question.policy.length > 0 && (
          <p className="text-xs text-muted-foreground">Policy relied on: {question.policy.join(" · ")}</p>
        )}

        {mode === "reject" && (
          <div className="space-y-1.5">
            <Label htmlFor={`reason-${question.step}`}>Why are you rejecting it?</Label>
            <Textarea
              id={`reason-${question.step}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="The agent reports this, and nothing after this step runs."
              maxLength={500}
            />
          </div>
        )}
        {mode === "edit" && (
          <div className="grid gap-3 sm:grid-cols-2">
            {editable.map(([key]) => (
              <div key={key} className="space-y-1.5">
                <Label htmlFor={`edit-${question.step}-${key}`}>{humanize(key)}</Label>
                <Input
                  id={`edit-${question.step}-${key}`}
                  value={edits[key]}
                  onChange={(e) => setEdits((all) => ({ ...all, [key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        {mode === "view" && (
          <>
            <Button disabled={pending} onClick={() => onDecide({ decision: "approve" })}>
              <Check />
              Approve
            </Button>
            <Button variant="outline" disabled={pending} onClick={() => setMode("reject")}>
              <X />
              Reject
            </Button>
            {editable.length > 0 && (
              <Button variant="ghost" disabled={pending} onClick={() => setMode("edit")}>
                <Pencil />
                Edit
              </Button>
            )}
          </>
        )}
        {mode === "reject" && (
          <>
            <Button
              variant="destructive"
              disabled={pending || !reason.trim()}
              onClick={() => onDecide({ decision: "reject", comment: reason.trim() })}
            >
              Reject with reason
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Back
            </Button>
          </>
        )}
        {mode === "edit" && (
          <>
            <Button
              disabled={pending || Object.keys(changed).length === 0}
              onClick={() => onDecide({ decision: "edit", arguments: changed })}
            >
              Approve with changes
            </Button>
            <Button variant="ghost" onClick={() => setMode("view")}>
              Back
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
