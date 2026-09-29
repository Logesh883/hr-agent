"use client";

import type { PayrollChange } from "@hr/contracts";
import { AlertTriangle, Download, Info, Loader2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { errorMessage } from "@/lib/api";
import { formatDate, fullName, todayIso } from "@/lib/format";
import { useDownloadFile } from "@/lib/open-file";
import { usePayrollReport } from "@/lib/payroll-policy-queries";

const changeLabels: Record<PayrollChange["kind"], string> = {
  JOINED: "Joined",
  EXITED: "Exited",
  CHANGED: "Changed",
};

export default function PayrollPage() {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const report = usePayrollReport(month);
  const download = useDownloadFile();
  const data = report.data;
  const rows = data?.rows.filter((r) => !flaggedOnly || r.flags.length > 0);

  async function exportCsv() {
    setExporting(true);
    try {
      await download(`/payroll/preparation.csv?month=${month}`, `payroll-preparation-${month}.csv`);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setExporting(false);
    }
  }

  const stats = data
    ? [
        { label: "Headcount", value: data.summary.headcount },
        { label: "New joiners", value: data.summary.newJoiners },
        { label: "Exits", value: data.summary.exits },
        { label: "Need attention", value: data.summary.employeesWithFlags },
        { label: "Loss-of-pay days", value: data.summary.lopDays },
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Payroll preparation"
        description="Inputs for the payroll run: payable days, leave, loss of pay and anything that blocks it."
        actions={
          <>
            <Input
              type="month"
              value={month}
              max={todayIso().slice(0, 7)}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="w-44"
              aria-label="Month"
            />
            <Button variant="outline" onClick={exportCsv} disabled={!data || exporting}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              Export CSV
            </Button>
          </>
        }
      />

      <Alert className="mb-4">
        <Info />
        <AlertDescription>
          Salary calculation is out of scope for this release; this report prepares and checks the inputs.
          {data && !data.complete && ` The current month is counted up to ${formatDate(data.through)}.`}
        </AlertDescription>
      </Alert>

      {report.error ? (
        <QueryError error={report.error} />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {data
              ? stats.map((s) => (
                  <Card key={s.label} size="sm">
                    <CardHeader>
                      <CardDescription>{s.label}</CardDescription>
                      <CardTitle className="text-2xl tabular-nums">{s.value}</CardTitle>
                    </CardHeader>
                  </Card>
                ))
              : Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-20" />)}
          </div>

          <div className="mb-3 flex items-center gap-2">
            <Checkbox id="flagged-only" checked={flaggedOnly} onCheckedChange={(v) => setFlaggedOnly(v === true)} />
            <Label htmlFor="flagged-only">Only employees that need attention</Label>
          </div>

          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead className="text-right">Working</TableHead>
                  <TableHead className="text-right">Worked</TableHead>
                  <TableHead className="text-right">Paid leave</TableHead>
                  <TableHead className="text-right">Unpaid</TableHead>
                  <TableHead className="text-right">Unexplained</TableHead>
                  <TableHead className="text-right">LOP</TableHead>
                  <TableHead className="text-right">Payable</TableHead>
                  <TableHead>Needs attention</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!rows && (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <Skeleton className="h-5 w-full" />
                    </TableCell>
                  </TableRow>
                )}
                {rows?.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="h-20 text-center text-muted-foreground">
                      Nothing needs attention this month.
                    </TableCell>
                  </TableRow>
                )}
                {rows?.map((r) => (
                  <TableRow key={r.employee.id}>
                    <TableCell>
                      <Link href={`/employees/${r.employee.id}`} className="font-medium hover:underline">
                        {fullName(r.employee)}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {r.employee.employeeCode} · {r.department}
                        {r.newJoiner && (
                          <Badge variant="secondary" className="ml-1.5">
                            New joiner
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.workingDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.daysWorked}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.paidLeaveDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.unpaidLeaveDays}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.unexplainedDays}</TableCell>
                    <TableCell className={r.lopDays ? "text-right font-medium text-destructive tabular-nums" : "text-right tabular-nums"}>
                      {r.lopDays}
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">{r.payableDays}</TableCell>
                    <TableCell className="max-w-sm">
                      <ul className="space-y-0.5 text-xs">
                        {r.flags.map((f) => (
                          <li key={f.code} className="flex items-start gap-1 text-amber-700 dark:text-amber-400">
                            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                            <span className="whitespace-normal">{f.message}</span>
                          </li>
                        ))}
                      </ul>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Changes this month</CardTitle>
              <CardDescription>Joiners, exits and edits to job title, department, employment type or status.</CardDescription>
            </CardHeader>
            <CardContent>
              {data?.changes.length === 0 && <p className="text-sm text-muted-foreground">No changes.</p>}
              <ul className="space-y-2 text-sm">
                {data?.changes.map((c, i) => (
                  <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                    <Badge variant={c.kind === "EXITED" ? "destructive" : "secondary"}>{changeLabels[c.kind]}</Badge>
                    <span className="font-medium">{fullName(c.employee)}</span>
                    <span>{c.summary}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(c.date)}
                      {c.by && ` · by ${c.by.name}`}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
