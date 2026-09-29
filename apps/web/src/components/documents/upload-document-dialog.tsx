"use client";

import {
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  DOCUMENT_UPLOAD_RULES,
  type DocumentType,
} from "@hr/contracts";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "@/lib/api";
import { useUploadDocument } from "@/lib/document-queries";

const MAX_MB = DOCUMENT_UPLOAD_RULES.maxBytes / 1024 / 1024;

export function UploadDocumentDialog({
  employeeId,
  open,
  onOpenChange,
  initialType = "OTHER",
}: {
  employeeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialType?: DocumentType;
}) {
  const upload = useUploadDocument();
  const [type, setType] = useState<DocumentType>(initialType);
  const [file, setFile] = useState<File | null>(null);
  const tooBig = !!file && file.size > DOCUMENT_UPLOAD_RULES.maxBytes;

  async function submit() {
    if (!file) return;
    try {
      await upload.mutateAsync({ employeeId, type, file });
      toast.success(`${DOCUMENT_TYPE_LABELS[type]} uploaded for review`);
      setFile(null);
      onOpenChange(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
          <DialogDescription>PDF, JPEG or PNG up to {MAX_MB} MB. HR verifies every upload.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="doc-type">Document type</Label>
            <Select value={type} onValueChange={(v) => setType(v as DocumentType)}>
              <SelectTrigger id="doc-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DOCUMENT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {DOCUMENT_TYPE_LABELS[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-file">File</Label>
            <Input
              id="doc-file"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              aria-invalid={tooBig}
            />
            {tooBig && <p className="text-sm text-destructive">The file is larger than {MAX_MB} MB.</p>}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || tooBig || upload.isPending}>
            {upload.isPending && <Loader2 className="animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
