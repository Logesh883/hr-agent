"use client";

import { LEAVE_STATUSES, type LeaveStatus } from "@hr/contracts";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BalanceCards } from "@/components/leave/balance-cards";
import { LeaveTable } from "@/components/leave/leave-table";
import { RequestLeaveDialog } from "@/components/leave/request-leave-dialog";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { addDaysIso, formatDate, todayIso } from "@/lib/format";
import { useHolidays, useLeaveBalances, useLeaveRequests } from "@/lib/leave-queries";
import { useCan, useCurrentUser } from "@/lib/session";

const PAGE_SIZE = 20;
const ANY = "any";

export default function LeavePage() {
  return (
    <Suspense>
      <LeaveView />
    </Suspense>
  );
}

function LeaveView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const user = useCurrentUser();
  const can = useCan();
  const [requesting, setRequesting] = useState(false);

  const hasEmployee = !!user?.employeeId;
  const canApprove = can("leave:approve");
  const seesOthers = can("leave:manage") || user?.role === "MANAGER";
  const tabs = [
    ...(hasEmployee ? ["mine"] : []),
    ...(canApprove ? ["approvals"] : []),
    ...(seesOthers ? ["all", "out"] : []),
    "holidays",
  ];
  const tab = tabs.includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : tabs[0];
  const approvals = useLeaveRequests({ view: "approvals", pageSize: 100 }, canApprove);

  function setTab(next: string) {
    router.replace(`${pathname}?tab=${next}`, { scroll: false });
  }

  return (
    <>
      <PageHeader
        title="Leave"
        description="Requests, approvals and balances. Weekends and company holidays aren't counted."
        actions={
          (hasEmployee || can("leave:manage")) && (
            <Button onClick={() => setRequesting(true)}>
              <Plus />
              Request leave
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          {hasEmployee && <TabsTrigger value="mine">My leave</TabsTrigger>}
          {canApprove && (
            <TabsTrigger value="approvals">
              Approvals
              {!!approvals.data?.total && (
                <Badge className="ml-1.5 h-5 min-w-5 px-1.5 tabular-nums">{approvals.data.total}</Badge>
              )}
            </TabsTrigger>
          )}
          {seesOthers && (
            <TabsTrigger value="all">{can("leave:manage") ? "All requests" : "My team"}</TabsTrigger>
          )}
          {seesOthers && <TabsTrigger value="out">Who&apos;s out</TabsTrigger>}
          <TabsTrigger value="holidays">Holidays</TabsTrigger>
        </TabsList>

        {hasEmployee && (
          <TabsContent value="mine">
            <MyLeave employeeId={user!.employeeId!} />
          </TabsContent>
        )}
        {canApprove && (
          <TabsContent value="approvals">
            {approvals.error ? (
              <QueryError error={approvals.error} />
            ) : (
              <LeaveTable requests={approvals.data?.items} emptyMessage="Nothing waiting for your approval." />
            )}
          </TabsContent>
        )}
        {seesOthers && (
          <TabsContent value="all">
            <AllRequests />
          </TabsContent>
        )}
        {seesOthers && (
          <TabsContent value="out">
            <WhosOut />
          </TabsContent>
        )}
        <TabsContent value="holidays">
          <Holidays />
        </TabsContent>
      </Tabs>

      <RequestLeaveDialog open={requesting} onOpenChange={setRequesting} />
    </>
  );
}

function MyLeave({ employeeId }: { employeeId: string }) {
  const year = Number(todayIso().slice(0, 4));
  const balances = useLeaveBalances(employeeId, year);
  const requests = useLeaveRequests({ view: "mine", pageSize: 50 });

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">{year} balances</h2>
        {balances.error ? <QueryError error={balances.error} /> : <BalanceCards balances={balances.data} />}
      </section>
      <section>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">My requests</h2>
        <LeaveTable
          requests={requests.data?.items}
          showEmployee={false}
          emptyMessage="You haven't requested any leave yet."
        />
      </section>
    </div>
  );
}

function AllRequests() {
  const [status, setStatus] = useState<LeaveStatus | typeof ANY>(ANY);
  const [page, setPage] = useState(1);
  const requests = useLeaveRequests({
    view: "all",
    status: status === ANY ? undefined : status,
    page,
    pageSize: PAGE_SIZE,
  });
  const total = requests.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <Select
        value={status}
        onValueChange={(v) => {
          setStatus(v as LeaveStatus | typeof ANY);
          setPage(1);
        }}
      >
        <SelectTrigger className="w-44" aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY}>All statuses</SelectItem>
          {LEAVE_STATUSES.map((s) => (
            <SelectItem key={s} value={s}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {requests.error ? (
        <QueryError error={requests.error} />
      ) : (
        <LeaveTable requests={requests.data?.items} emptyMessage="No leave requests match." />
      )}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            <ChevronLeft />
            Previous
          </Button>
          Page {page} of {pageCount}
          <Button variant="outline" size="sm" disabled={page >= pageCount} onClick={() => setPage(page + 1)}>
            Next
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}

/** Approved leave overlapping the next 30 days. */
function WhosOut() {
  const today = todayIso();
  const requests = useLeaveRequests({
    view: "all",
    status: "APPROVED",
    from: today,
    to: addDaysIso(today, 30),
    pageSize: 100,
  });
  const items = requests.data?.items
    ? [...requests.data.items].sort((a, b) => a.startDate.localeCompare(b.startDate))
    : undefined;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Approved leave from today to {formatDate(addDaysIso(today, 30))}.</p>
      {requests.error ? (
        <QueryError error={requests.error} />
      ) : (
        <LeaveTable requests={items} emptyMessage="Nobody is on approved leave in the next 30 days." />
      )}
    </div>
  );
}

function Holidays() {
  const year = Number(todayIso().slice(0, 4));
  const holidays = useHolidays(year);
  return (
    <div className="max-w-md rounded-lg border">
      {holidays.data?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No holidays configured.</p>}
      <ul className="divide-y">
        {holidays.data?.map((h) => (
          <li key={h.date} className="flex justify-between px-4 py-2.5 text-sm">
            <span>{h.name}</span>
            <span className="text-muted-foreground">
              {new Date(`${h.date}T00:00:00Z`).toLocaleDateString("en-IN", {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: "UTC",
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
