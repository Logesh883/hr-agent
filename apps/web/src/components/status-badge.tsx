import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const tones = {
  positive: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  negative: "bg-red-500/10 text-red-700 dark:text-red-400",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-400",
  neutral: "bg-muted text-muted-foreground",
} as const;

const statuses = {
  ACTIVE: { label: "Active", tone: "positive" },
  PROBATION: { label: "Probation", tone: "warning" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
  PENDING: { label: "Pending", tone: "warning" },
  APPROVED: { label: "Approved", tone: "positive" },
  REJECTED: { label: "Rejected", tone: "negative" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  VERIFIED: { label: "Verified", tone: "positive" },
  FLAGGED: { label: "Flagged", tone: "negative" },
  MISSING: { label: "Missing", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: keyof typeof tones }>;

export type BadgeStatus = keyof typeof statuses;

export function StatusBadge({ status }: { status: BadgeStatus }) {
  const { label, tone } = statuses[status];
  return (
    <Badge variant="secondary" className={cn("font-medium", tones[tone])}>
      {label}
    </Badge>
  );
}
