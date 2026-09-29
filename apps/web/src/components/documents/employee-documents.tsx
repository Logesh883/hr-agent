"use client";

import {
  DOCUMENT_TYPE_LABELS,
  REQUIRED_DOCUMENT_TYPES,
  type DocumentStatus,
  type DocumentType,
  type EmployeeDocument,
} from "@hr/contracts";
import { Upload } from "lucide-react";
import { useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useEmployeeDocuments } from "@/lib/document-queries";
import { useCan } from "@/lib/session";
import { DocumentTable } from "./document-table";
import { UploadDocumentDialog } from "./upload-document-dialog";

/** Latest upload per required type, or MISSING. */
export function requiredDocumentStatus(
  documents: EmployeeDocument[],
): { type: DocumentType; status: DocumentStatus | "MISSING" }[] {
  return REQUIRED_DOCUMENT_TYPES.map((type) => {
    const latest = documents
      .filter((d) => d.type === type)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
      .at(0);
    return { type, status: latest?.status ?? "MISSING" };
  });
}

export function EmployeeDocuments({ employeeId }: { employeeId: string }) {
  const can = useCan();
  const documents = useEmployeeDocuments(employeeId);
  const [uploadType, setUploadType] = useState<DocumentType | null>(null);

  if (documents.error) return null;
  const required = documents.data ? requiredDocumentStatus(documents.data) : [];
  const canUpload = can("document:upload");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Documents</CardTitle>
        {canUpload && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={() => setUploadType("OTHER")}>
              <Upload />
              Upload
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {documents.data && (
          <div>
            <h3 className="mb-2 text-sm font-medium text-muted-foreground">Required documents</h3>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {required.map(({ type, status }) => (
                <li key={type} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                  <span>{DOCUMENT_TYPE_LABELS[type]}</span>
                  {status === "MISSING" && canUpload ? (
                    <Button size="xs" variant="outline" onClick={() => setUploadType(type)}>
                      Upload
                    </Button>
                  ) : (
                    <StatusBadge status={status} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DocumentTable documents={documents.data} showEmployee={false} emptyMessage="No documents uploaded yet." />
      </CardContent>
      {uploadType && (
        <UploadDocumentDialog
          key={uploadType}
          employeeId={employeeId}
          initialType={uploadType}
          open
          onOpenChange={(open) => !open && setUploadType(null)}
        />
      )}
    </Card>
  );
}
