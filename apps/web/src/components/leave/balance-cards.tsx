"use client";

import type { LeaveBalance } from "@hr/contracts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { leaveTypeLabels } from "@/lib/format";

export function BalanceCards({ balances }: { balances: LeaveBalance[] | undefined }) {
  if (!balances) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {balances.map((b) => (
        <Card key={b.type} size="sm">
          <CardHeader>
            <CardDescription>{leaveTypeLabels[b.type]}</CardDescription>
            <CardTitle className="text-2xl tabular-nums">
              {b.available === null ? (
                <span className="text-base font-normal text-muted-foreground">No limit</span>
              ) : (
                <>
                  {b.available}
                  <span className="text-sm font-normal text-muted-foreground"> / {b.entitled} days left</span>
                </>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {b.entitled !== null && b.entitled > 0 && (
              <Progress value={((b.used + b.pending) / b.entitled) * 100} aria-label={`${leaveTypeLabels[b.type]} used`} />
            )}
            <p className="text-xs text-muted-foreground">
              {b.used} used{b.pending > 0 && ` · ${b.pending} pending`}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
