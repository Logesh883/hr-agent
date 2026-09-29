import { LEAVE_POLICY, type EmployeeRef, type EmploymentType, type LeaveType, type Role } from "@hr/contracts";

export const fullName = (e: Pick<EmployeeRef, "firstName" | "lastName">) =>
  `${e.firstName} ${e.lastName}`;

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** "2026-10-12" → "12 Oct 2026" (dates are calendar dates; no timezone shift). */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  return new Date(`${isoDate.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const employmentTypeLabels: Record<EmploymentType, string> = {
  FULL_TIME: "Full-time",
  PART_TIME: "Part-time",
  CONTRACT: "Contract",
  INTERN: "Intern",
};

export const roleLabels: Record<Role, string> = {
  ADMIN: "Admin",
  HR_OPS: "HR Operations",
  MANAGER: "Manager",
  EMPLOYEE: "Employee",
};

export const leaveTypeLabels = Object.fromEntries(
  Object.entries(LEAVE_POLICY).map(([type, policy]) => [type, policy.label]),
) as Record<LeaveType, string>;

/** "12 Oct 2026" or "12 Oct – 16 Oct 2026". */
export function formatDateRange(start: string, end: string): string {
  if (start === end) return formatDate(start);
  const sameYear = start.slice(0, 4) === end.slice(0, 4);
  const first = new Date(`${start}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
  return `${first} – ${formatDate(end)}`;
}

/** Today's date in the company time zone, "YYYY-MM-DD". */
export function todayIso(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
