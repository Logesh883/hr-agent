"use client";

import type { AttendanceDay, DayStatus } from "@hr/contracts";
import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import { QueryError } from "@/components/query-error";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useMonthlyAttendance } from "@/lib/attendance-queries";
import { formatDate, todayIso } from "@/lib/format";
import { useCan } from "@/lib/session";
import { cn } from "@/lib/utils";
import { ProposeCorrectionDialog, type CorrectionTarget } from "./propose-correction-dialog";

const cellStyles: Record<DayStatus, string> = {
  PRESENT: "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  HALF_DAY: "bg-sky-500/10 text-sky-800 dark:text-sky-300",
  ABSENT: "bg-red-500/10 text-red-800 dark:text-red-300",
  ON_LEAVE: "bg-sky-500/10 text-sky-800 dark:text-sky-300",
  HOLIDAY: "bg-muted text-muted-foreground",
  WEEKEND: "bg-muted/50 text-muted-foreground",
  MISSING: "bg-amber-500/10 text-amber-800 dark:text-amber-300",
  NOT_EMPLOYED: "text-muted-foreground/50",
  UPCOMING: "text-muted-foreground/60",
};

const shortLabels: Partial<Record<DayStatus, string>> = {
  HALF_DAY: "Half day",
  ABSENT: "Absent",
  ON_LEAVE: "Leave",
  HOLIDAY: "Holiday",
  MISSING: "No record",
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One employee's month, day by day, with anomalies and correction shortcuts. */
export function AttendanceCalendar({ employeeId }: { employeeId: string }) {
  const can = useCan();
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const monthly = useMonthlyAttendance(month, { employeeId });
  const [target, setTarget] = useState<CorrectionTarget | null>(null);
  const canPropose = can("attendance:propose");

  const days = monthly.data?.days ?? [];
  const leadingBlanks = days.length ? (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const row = monthly.data?.rows[0];

  function propose(day: AttendanceDay) {
    setTarget({
      employee: day.employee,
      date: day.date,
      current: day.record ? { status: day.record.status, checkIn: day.record.checkIn, checkOut: day.record.checkOut } : null,
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attendance</CardTitle>
        <CardAction>
          <Input
            type="month"
            value={month}
            max={todayIso().slice(0, 7)}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="Month"
            className="w-40"
          />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        {monthly.error && <QueryError error={monthly.error} />}
        {!monthly.data && !monthly.error && <Skeleton className="h-72 w-full" />}
        {row && (
          <p className="text-sm text-muted-foreground">
            {row.present} present · {row.halfDays} half days · {row.onLeave} on leave · {row.absent} absent ·{" "}
            {row.missing} missing · {row.anomalies} anomalies
          </p>
        )}
        {days.length > 0 && (
          <div className="grid grid-cols-7 gap-1 text-xs">
            {WEEKDAYS.map((d) => (
              <div key={d} className="px-1 pb-1 font-medium text-muted-foreground">
                {d}
              </div>
            ))}
            {Array.from({ length: leadingBlanks }, (_, i) => (
              <div key={`blank-${i}`} />
            ))}
            {days.map((day) => {
              const clickable = canPropose && ["PRESENT", "HALF_DAY", "ABSENT", "MISSING"].includes(day.dayStatus) && day.date <= todayIso() && !day.pendingCorrection;
              return (
                <button
                  key={day.date}
                  type="button"
                  disabled={!clickable}
                  onClick={() => propose(day)}
                  title={[formatDate(day.date), day.holiday, ...day.anomalies.map((a) => a.message), day.pendingCorrection ? "Correction pending approval" : null].filter(Boolean).join("\n")}
                  className={cn(
                    "flex min-h-16 flex-col items-start gap-0.5 rounded-md p-1.5 text-left",
                    cellStyles[day.dayStatus],
                    day.anomalies.length > 0 && "ring-1 ring-amber-500/60",
                    clickable && "cursor-pointer hover:ring-2 hover:ring-ring",
                  )}
                >
                  <span className="flex w-full items-center justify-between font-medium">
                    {Number(day.date.slice(8))}
                    {day.anomalies.length > 0 && <AlertTriangle className="size-3 text-amber-600" />}
                  </span>
                  {day.record?.checkIn && day.dayStatus !== "WEEKEND" && (
                    <span className="tabular-nums">
                      {day.record.checkIn}–{day.record.checkOut ?? "?"}
                    </span>
                  )}
                  {shortLabels[day.dayStatus] && <span>{shortLabels[day.dayStatus]}</span>}
                  {day.pendingCorrection && <span className="italic">Correction pending</span>}
                </button>
              );
            })}
          </div>
        )}
        {monthly.data && monthly.data.anomalies.length > 0 && (
          <ul className="space-y-1 text-sm">
            {monthly.data.anomalies.map((a) => (
              <li key={`${a.date}:${a.code}`} className="flex gap-2">
                <span className="w-24 shrink-0 text-muted-foreground">{formatDate(a.date)}</span>
                {a.message}
              </li>
            ))}
          </ul>
        )}
        {canPropose && days.length > 0 && (
          <p className="text-xs text-muted-foreground">Select a working day to propose a correction.</p>
        )}
      </CardContent>
      <ProposeCorrectionDialog target={target} onClose={() => setTarget(null)} />
    </Card>
  );
}
