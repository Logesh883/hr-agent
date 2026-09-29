"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { DocumentTable } from "@/components/documents/document-table";
import { EmployeeDocuments } from "@/components/documents/employee-documents";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDocuments } from "@/lib/document-queries";
import { useCan, useCurrentUser } from "@/lib/session";

const PAGE_SIZE = 20;

export default function DocumentsPage() {
  return (
    <Suspense>
      <DocumentsView />
    </Suspense>
  );
}

function DocumentsView() {
  const can = useCan();
  const user = useCurrentUser();

  if (!can("document:verify")) {
    return (
      <>
        <PageHeader title="My documents" description="Upload documents for HR to verify." />
        {user?.employeeId ? (
          <EmployeeDocuments employeeId={user.employeeId} />
        ) : (
          <p className="text-sm text-muted-foreground">Your account isn&apos;t linked to an employee record.</p>
        )}
      </>
    );
  }
  return <ReviewQueues />;
}

function ReviewQueues() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabs = ["pending", "flagged", "all"];
  const tab = tabs.includes(searchParams.get("tab") ?? "") ? searchParams.get("tab")! : "pending";

  const pending = useDocuments({ status: "PENDING", pageSize: 100 });
  const flagged = useDocuments({ status: "FLAGGED", pageSize: 100 });

  return (
    <>
      <PageHeader title="Documents" description="Verify uploads and follow up on flagged documents." />
      <Tabs value={tab} onValueChange={(next) => router.replace(`${pathname}?tab=${next}`, { scroll: false })}>
        <TabsList className="mb-4">
          <TabsTrigger value="pending">
            Review queue
            <CountBadge count={pending.data?.total} />
          </TabsTrigger>
          <TabsTrigger value="flagged">
            Flagged
            <CountBadge count={flagged.data?.total} />
          </TabsTrigger>
          <TabsTrigger value="all">All documents</TabsTrigger>
        </TabsList>
        <TabsContent value="pending">
          {pending.error ? (
            <QueryError error={pending.error} />
          ) : (
            <DocumentTable documents={pending.data?.items} emptyMessage="Nothing to review. All uploads are verified." />
          )}
        </TabsContent>
        <TabsContent value="flagged">
          {flagged.error ? (
            <QueryError error={flagged.error} />
          ) : (
            <DocumentTable documents={flagged.data?.items} emptyMessage="No flagged documents." />
          )}
        </TabsContent>
        <TabsContent value="all">
          <AllDocuments />
        </TabsContent>
      </Tabs>
    </>
  );
}

function AllDocuments() {
  const [page, setPage] = useState(1);
  const documents = useDocuments({ page, pageSize: PAGE_SIZE });
  const total = documents.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      {documents.error ? (
        <QueryError error={documents.error} />
      ) : (
        <DocumentTable documents={documents.data?.items} emptyMessage="No documents yet." />
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

function CountBadge({ count }: { count: number | undefined }) {
  if (!count) return null;
  return <Badge className="ml-1.5 h-5 min-w-5 px-1.5 tabular-nums">{count}</Badge>;
}
