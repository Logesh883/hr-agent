"use client";

import { EMPLOYEE_STATUSES, type EmployeeSearchParams, type EmployeeStatus } from "@hr/contracts";
import { ChevronLeft, ChevronRight, Plus, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, fullName } from "@/lib/format";
import { useDepartments, useEmployee, useEmployees } from "@/lib/queries";
import { useCan } from "@/lib/session";

const PAGE_SIZE = 15;
const ALL = "all";

export default function EmployeesPage() {
  return (
    <Suspense>
      <EmployeesView />
    </Suspense>
  );
}

function EmployeesView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const can = useCan();

  const filters: EmployeeSearchParams = {
    q: searchParams.get("q") ?? undefined,
    departmentId: searchParams.get("departmentId") ?? undefined,
    managerId: searchParams.get("managerId") ?? undefined,
    location: searchParams.get("location") ?? undefined,
    status: (searchParams.get("status") as EmployeeStatus | null) ?? undefined,
    page: Number(searchParams.get("page") ?? 1),
    pageSize: PAGE_SIZE,
  };

  /** Writes filters to the URL; any filter change returns to page 1. */
  function setParams(updates: Record<string, string | undefined>) {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if (!("page" in updates)) next.delete("page");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  // Debounce the search box into the URL.
  const [search, setSearch] = useState(filters.q ?? "");
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((filters.q ?? "") !== search.trim()) setParams({ q: search.trim() || undefined });
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to typing
  }, [search]);

  const employees = useEmployees(filters);
  const departments = useDepartments();
  const manager = useEmployee(filters.managerId ?? "");
  const data = employees.data;
  const page = filters.page ?? 1;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const hasFilters = !!(filters.q || filters.departmentId || filters.managerId || filters.location || filters.status);

  return (
    <>
      <PageHeader
        title="Employees"
        description={data ? `${data.total} ${data.total === 1 ? "employee" : "employees"}` : " "}
        actions={
          can("employee:create") && (
            <Button asChild>
              <Link href="/employees/new">
                <Plus />
                Add employee
              </Link>
            </Button>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, email, code, title…"
            className="pl-8"
            aria-label="Search employees"
          />
        </div>
        <Select
          value={filters.departmentId ?? ALL}
          onValueChange={(v) => setParams({ departmentId: v === ALL ? undefined : v })}
        >
          <SelectTrigger className="w-full sm:w-48" aria-label="Department">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All departments</SelectItem>
            {departments.data?.map((d) => (
              <SelectItem key={d.id} value={d.id}>
                {d.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filters.status ?? ALL}
          onValueChange={(v) => setParams({ status: v === ALL ? undefined : v })}
        >
          <SelectTrigger className="w-full sm:w-44" aria-label="Status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Current staff</SelectItem>
            {EMPLOYEE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s === "ACTIVE" ? "Active" : s === "PROBATION" ? "On probation" : "Archived"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          defaultValue={filters.location ?? ""}
          key={filters.location ?? ""}
          onBlur={(e) => setParams({ location: e.target.value.trim() || undefined })}
          onKeyDown={(e) => {
            if (e.key === "Enter") setParams({ location: e.currentTarget.value.trim() || undefined });
          }}
          placeholder="Location"
          className="w-full sm:w-36"
          aria-label="Location"
        />
        {filters.managerId && (
          <Button variant="secondary" size="sm" onClick={() => setParams({ managerId: undefined })}>
            Reports to {manager.data ? fullName(manager.data) : "…"}
            <X />
          </Button>
        )}
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              router.replace(pathname, { scroll: false });
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {employees.error ? (
        <QueryError error={employees.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Job title</TableHead>
                <TableHead className="hidden md:table-cell">Department</TableHead>
                <TableHead className="hidden lg:table-cell">Manager</TableHead>
                <TableHead className="hidden lg:table-cell">Location</TableHead>
                <TableHead className="hidden xl:table-cell">Joined</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data &&
                Array.from({ length: 6 }, (_, i) => (
                  <TableRow key={i}>
                    <TableCell colSpan={7}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                ))}
              {data?.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                    No employees match these filters.
                  </TableCell>
                </TableRow>
              )}
              {data?.items.map((e) => (
                <TableRow
                  key={e.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/employees/${e.id}`)}
                >
                  <TableCell>
                    <Link
                      href={`/employees/${e.id}`}
                      className="font-medium hover:underline"
                      onClick={(ev) => ev.stopPropagation()}
                    >
                      {fullName(e)}
                    </Link>
                    <div className="text-xs text-muted-foreground">{e.employeeCode}</div>
                  </TableCell>
                  <TableCell>{e.jobTitle}</TableCell>
                  <TableCell className="hidden md:table-cell">{e.department?.name}</TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {e.manager ? fullName(e.manager) : "—"}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">{e.location}</TableCell>
                  <TableCell className="hidden xl:table-cell">{formatDate(e.joiningDate)}</TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, data.total)} of {data.total}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParams({ page: String(page - 1) })}
            >
              <ChevronLeft />
              Previous
            </Button>
            <span>
              Page {page} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount}
              onClick={() => setParams({ page: String(page + 1) })}
            >
              Next
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
