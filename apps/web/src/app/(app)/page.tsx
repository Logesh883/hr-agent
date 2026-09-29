"use client";

import { Building2, CalendarClock, ClipboardCheck, Clock, FileSearch, Users } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { roleLabels } from "@/lib/format";
import { useDocuments } from "@/lib/document-queries";
import { useLeaveRequests } from "@/lib/leave-queries";
import { useOnboardingList } from "@/lib/onboarding-queries";
import { useDepartments, useEmployees } from "@/lib/queries";
import { useCan, useCurrentUser } from "@/lib/session";

export default function DashboardPage() {
  const user = useCurrentUser();
  const can = useCan();
  const canReadEmployees = can("employee:read");

  const employees = useEmployees({ pageSize: 1 }, canReadEmployees);
  const probation = useEmployees({ pageSize: 1, status: "PROBATION" }, canReadEmployees);
  const departments = useDepartments();
  const canApprove = can("leave:approve");
  const approvals = useLeaveRequests({ view: "approvals", pageSize: 1 }, canApprove);
  const canVerify = can("document:verify");
  const pendingDocs = useDocuments({ status: "PENDING", pageSize: 1 }, canVerify);
  const seesOnboarding = canReadEmployees && can("onboarding:read");
  const onboarding = useOnboardingList({ state: "active", pageSize: 1 }, seesOnboarding);

  const stats = [
    ...(canApprove
      ? [
          {
            label: "Leave awaiting your approval",
            value: approvals.data?.total,
            icon: CalendarClock,
            href: "/leave?tab=approvals",
          },
        ]
      : []),
    ...(canVerify
      ? [
          {
            label: "Documents to verify",
            value: pendingDocs.data?.total,
            icon: FileSearch,
            href: "/documents",
          },
        ]
      : []),
    ...(seesOnboarding
      ? [
          {
            label: "Onboarding in progress",
            value: onboarding.data?.total,
            icon: ClipboardCheck,
            href: "/onboarding",
          },
        ]
      : []),
    ...(canReadEmployees
      ? [
          { label: "Employees", value: employees.data?.total, icon: Users, href: "/employees" },
          {
            label: "On probation",
            value: probation.data?.total,
            icon: Clock,
            href: "/employees?status=PROBATION",
          },
        ]
      : []),
    {
      label: "Departments",
      value: departments.data?.filter((d) => d.status === "ACTIVE").length,
      icon: Building2,
      href: "/departments",
    },
  ];

  return (
    <>
      <PageHeader
        title={`Welcome, ${user?.name.split(" ")[0] ?? ""}`}
        description={user && `Signed in as ${roleLabels[user.role]}`}
      />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {stats.map(({ label, value, icon: Icon, href }) => (
          <Link key={label} href={href} className="rounded-xl transition-shadow hover:shadow-md">
            <Card>
              <CardHeader>
                <CardDescription className="flex items-center gap-2">
                  <Icon className="size-4" />
                  {label}
                </CardDescription>
                <CardTitle className="text-3xl tabular-nums">
                  {value ?? <Skeleton className="h-9 w-16" />}
                </CardTitle>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
      {!canReadEmployees && (
        <p className="mt-6 text-sm text-muted-foreground">
          Use Leave to request time off and check your balances. Employee records are visible to
          managers and HR.
        </p>
      )}
    </>
  );
}
