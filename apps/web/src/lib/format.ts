import type { EmployeeRef, EmploymentType, Role } from "@hr/contracts";

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
