"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { todayIso } from "@/lib/format";
import { useLeaveBalances, useLeaveRequests } from "@/lib/leave-queries";
import { BalanceCards } from "./balance-cards";
import { LeaveTable } from "./leave-table";

/** Leave balances and recent requests on the employee detail page. */
export function EmployeeLeave({ employeeId }: { employeeId: string }) {
  const year = Number(todayIso().slice(0, 4));
  const balances = useLeaveBalances(employeeId, year);
  const requests = useLeaveRequests({ employeeId, pageSize: 5 });

  if (balances.error) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Leave ({year})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <BalanceCards balances={balances.data} />
        <LeaveTable
          requests={requests.data?.items}
          showEmployee={false}
          emptyMessage="No leave requests yet."
        />
      </CardContent>
    </Card>
  );
}
