"use client";

import type { AttendanceDay, CorrectionStatus } from "@hr/contracts";
import { AlertTriangle, PencilLine } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { AttendanceCalendar } from "@/components/attendance/attendance-calendar";
import { CorrectionsTable } from "@/components/attendance/corrections-table";
import {
  ProposeCorrectionDialog,
  type CorrectionTarget,
} from "@/components/attendance/propose-correction-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCorrections, useDailyAttendance, useMonthlyAttendance } from "@/lib/attendance-queries";
import { formatDate, formatMinutes, fullName, previousWorkday, todayIso } from "@/lib/format";
import { useDepartments } from "@/lib/queries";
import { useCan, useCurrentUser } from "@/lib/session";

const ALL = "all";

export default function AttendancePage() {
  return (
    <Suspense>
      <AttendanceView />
    </Suspense>
  );
}

function AttendanceView() {
  const can = useCan();
  const user = useCurrentUser();

  // Employees only see their own month.
  if (!can("employee:read")) {
    return (
      <>
        <PageHeader title="My attendance" description="Check-ins, leave and anything that needs fixing." />
        {user?.employeeId ? (
          <AttendanceCalendar employeeId={user.employeeId} />
        ) : (
          <p className="text-sm text-muted-foreground">Your account isn&apos;t linked to an employee record.</p>
        )}
      </>
    );
  }
  return <TeamAttendance />;
}

function TeamAttendance() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const can = useCan();
  const tabs = ["daily", "monthly", "anomalies", "corrections"];
  const tab = tabs.includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "daily";

  const departments = useDepartments();
  const [departmentId, setDepartmentId] = useState<string>(ALL);
  const [target, setTarget] = useState<CorrectionTarget | null>(null);
  const pending = useCorrections({ status: "PENDING", pageSize: 100 });
  const dept = departmentId === ALL ? undefined : departmentId;

  function propose(day: AttendanceDay) {
    setTarget({
      employee: day.employee,
      date: day.date,
      current: day.record ? { status: day.record.status, checkIn: day.record.checkIn, checkOut: day.record.checkOut } : null,
    });
  }
  const canProposeFor = (day: AttendanceDay) =>
    can("attendance:propose") &&
    !day.pendingCorrection &&
    day.date <= todayIso() &&
    ["PRESENT", "HALF_DAY", "ABSENT", "MISSING"].includes(day.dayStatus);

  return (
    <>
      <PageHeader
        title="Attendance"
        description="Daily and monthly views, cross-checked with approved leave. Changes to past records need HR approval."
        actions={
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger className="w-48" aria-label="Department">
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
        }
      />
      <Tabs value={tab} onValueChange={(next) => router.replace(`${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList className="mb-4">
          <TabsTrigger value="daily">Daily</TabsTrigger>
          <TabsTrigger value="monthly">Monthly</TabsTrigger>
          <TabsTrigger value="anomalies">Anomalies</TabsTrigger>
          <TabsTrigger value="corrections">
            Corrections
            {!!pending.data?.total && (
              <Badge className="ml-1.5 h-5 min-w-5 px-1.5 tabular-nums">{pending.data.total}</Badge>
            )}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="daily">
          <Daily departmentId={dept} onPropose={propose} canProposeFor={canProposeFor} />
        </TabsContent>
        <TabsContent value="monthly">
          <Monthly departmentId={dept} />
        </TabsContent>
        <TabsContent value="anomalies">
          <Anomalies departmentId={dept} />
        </TabsContent>
        <TabsContent value="corrections">
          <Corrections />
        </TabsContent>
      </Tabs>
      <ProposeCorrectionDialog target={target} onClose={() => setTarget(null)} />
    </>
  );
}

function Daily({
  departmentId,
  onPropose,
  canProposeFor,
}: {
  departmentId?: string;
  onPropose: (day: AttendanceDay) => void;
  canProposeFor: (day: AttendanceDay) => boolean;
}) {
  const [date, setDate] = useState(previousWorkday());
  const daily = useDailyAttendance(date, departmentId);
  const data = daily.data;
  const isToday = date === todayIso();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="date"
          value={date}
          max={todayIso()}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="w-44"
          aria-label="Date"
        />
        {data && (
          <p className="text-sm text-muted-foreground">
            {data.isWorkingDay
              ? `${data.summary.present} present · ${data.summary.halfDay} half day · ${data.summary.onLeave} on leave · ${data.summary.absent} absent · ${data.summary.missing} ${isToday ? "not in yet" : "missing"}`
              : `${data.holiday ?? "Weekend"}: not a working day`}
          </p>
        )}
      </div>
      {daily.error ? (
        <QueryError error={daily.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>In</TableHead>
                <TableHead>Out</TableHead>
                <TableHead className="hidden md:table-cell">Worked</TableHead>
                <TableHead>Flags</TableHead>
                <TableHead className="w-0" />
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
              {data?.rows.map((day) => (
                <TableRow key={day.employee.id}>
                  <TableCell>
                    <Link href={`/employees/${day.employee.id}?tab=attendance`} className="font-medium hover:underline">
                      {fullName(day.employee)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={day.dayStatus} />
                    {day.record?.source === "CORRECTION" && (
                      <span className="ml-1.5 text-xs text-muted-foreground">corrected</span>
                    )}
                  </TableCell>
                  <TableCell className="tabular-nums">{day.record?.checkIn ?? "—"}</TableCell>
                  <TableCell className="tabular-nums">{day.record?.checkOut ?? "—"}</TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">{formatMinutes(day.workedMinutes)}</TableCell>
                  <TableCell className="max-w-xs">
                    <div className="flex flex-col gap-0.5 text-xs">
                      {day.anomalies.map((a) => (
                        <span key={a.code} className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                          {a.message}
                        </span>
                      ))}
                      {day.pendingCorrection && <span className="text-muted-foreground italic">Correction pending approval</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    {canProposeFor(day) && (
                      <Button size="sm" variant="ghost" onClick={() => onPropose(day)}>
                        <PencilLine />
                        Correct
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function MonthPicker({ month, onChange }: { month: string; onChange: (m: string) => void }) {
  return (
    <Input
      type="month"
      value={month}
      max={todayIso().slice(0, 7)}
      onChange={(e) => e.target.value && onChange(e.target.value)}
      className="w-44"
      aria-label="Month"
    />
  );
}

function Monthly({ departmentId }: { departmentId?: string }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const monthly = useMonthlyAttendance(month, { departmentId });
  const data = monthly.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <MonthPicker month={month} onChange={setMonth} />
        {data && <p className="text-sm text-muted-foreground">{data.workingDays} working days so far</p>}
      </div>
      {monthly.error ? (
        <QueryError error={monthly.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead className="text-right">Present</TableHead>
                <TableHead className="text-right">Half days</TableHead>
                <TableHead className="text-right">On leave</TableHead>
                <TableHead className="text-right">Absent</TableHead>
                <TableHead className="text-right">Missing</TableHead>
                <TableHead className="text-right">Anomalies</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!data && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {data?.rows.map((r) => (
                <TableRow key={r.employee.id}>
                  <TableCell>
                    <Link href={`/employees/${r.employee.id}?tab=attendance`} className="font-medium hover:underline">
                      {fullName(r.employee)}
                    </Link>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.present}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.halfDays}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.onLeave}</TableCell>
                  <TableCell className={r.absent ? "text-right text-destructive tabular-nums" : "text-right tabular-nums"}>{r.absent}</TableCell>
                  <TableCell className={r.missing ? "text-right text-destructive tabular-nums" : "text-right tabular-nums"}>{r.missing}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.anomalies}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Anomalies({ departmentId }: { departmentId?: string }) {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const monthly = useMonthlyAttendance(month, { departmentId });
  const anomalies = monthly.data?.anomalies;

  return (
    <div className="space-y-4">
      <MonthPicker month={month} onChange={setMonth} />
      {monthly.error ? (
        <QueryError error={monthly.error} />
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Day</TableHead>
                <TableHead>Employee</TableHead>
                <TableHead>What&apos;s off</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!anomalies && (
                <TableRow>
                  <TableCell colSpan={3}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              )}
              {anomalies?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="h-20 text-center text-muted-foreground">
                    No anomalies this month.
                  </TableCell>
                </TableRow>
              )}
              {anomalies?.map((a) => (
                <TableRow key={`${a.employee.id}:${a.date}:${a.code}`}>
                  <TableCell className="whitespace-nowrap">{formatDate(a.date)}</TableCell>
                  <TableCell>
                    <Link href={`/employees/${a.employee.id}?tab=attendance`} className="font-medium hover:underline">
                      {fullName(a.employee)}
                    </Link>
                  </TableCell>
                  <TableCell>{a.message}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

function Corrections() {
  const [status, setStatus] = useState<CorrectionStatus | typeof ALL>("PENDING");
  const corrections = useCorrections({ status: status === ALL ? undefined : status, pageSize: 100 });

  return (
    <div className="space-y-4">
      <Select value={status} onValueChange={(v) => setStatus(v as CorrectionStatus | typeof ALL)}>
        <SelectTrigger className="w-44" aria-label="Correction status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="PENDING">Waiting for approval</SelectItem>
          <SelectItem value="APPROVED">Approved</SelectItem>
          <SelectItem value="REJECTED">Rejected</SelectItem>
          <SelectItem value={ALL}>All</SelectItem>
        </SelectContent>
      </Select>
      {corrections.error ? (
        <QueryError error={corrections.error} />
      ) : (
        <CorrectionsTable
          corrections={corrections.data?.items}
          emptyMessage={status === "PENDING" ? "Nothing waiting for approval." : "No corrections."}
        />
      )}
    </div>
  );
}
