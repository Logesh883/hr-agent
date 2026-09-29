import type { DepartmentStatus, EmployeeStatus } from "@hr/contracts";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const styles: Record<EmployeeStatus | DepartmentStatus, string> = {
  ACTIVE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  PROBATION: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  ARCHIVED: "bg-muted text-muted-foreground",
};

const labels: Record<EmployeeStatus | DepartmentStatus, string> = {
  ACTIVE: "Active",
  PROBATION: "Probation",
  ARCHIVED: "Archived",
};

export function StatusBadge({ status }: { status: EmployeeStatus | DepartmentStatus }) {
  return (
    <Badge variant="secondary" className={cn("font-medium", styles[status])}>
      {labels[status]}
    </Badge>
  );
}
