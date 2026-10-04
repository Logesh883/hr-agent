import type { RiskLevel, RunStatus } from "@hr/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { humanize, runStatusLabels, type Tone } from "./labels";

export const toneClasses: Record<Tone, string> = {
  positive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  negative: "bg-red-500/10 text-red-700 dark:text-red-400",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  neutral: "bg-muted text-muted-foreground",
};

const runTones: Record<RunStatus, Tone> = {
  running: "info",
  waiting: "warning",
  completed: "positive",
  failed: "negative",
  interrupted: "warning",
};

export function ToneBadge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <Badge variant="secondary" className={cn("font-medium", toneClasses[tone])}>
      {children}
    </Badge>
  );
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <ToneBadge tone={runTones[status]}>{runStatusLabels[status]}</ToneBadge>;
}

const riskTones: Record<RiskLevel, Tone> = { low: "neutral", medium: "warning", high: "negative" };

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <ToneBadge tone={riskTones[risk]}>{humanize(risk)} risk</ToneBadge>;
}
