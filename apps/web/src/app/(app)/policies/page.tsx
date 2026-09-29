"use client";

import {
  POLICY_CATEGORIES,
  POLICY_CATEGORY_LABELS,
  type Policy,
  type PolicyCategory,
  type PolicyVersion,
} from "@hr/contracts";
import { Eye, Loader2, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { QueryError } from "@/components/query-error";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useOpenFile } from "@/lib/open-file";
import { usePolicies, usePublishPolicy } from "@/lib/payroll-policy-queries";
import { useCan } from "@/lib/session";

export default function PoliciesPage() {
  const can = useCan();
  const policies = usePolicies();
  const [publishing, setPublishing] = useState<{ title: string; category: PolicyCategory } | null>(null);

  return (
    <>
      <PageHeader
        title="Policies"
        description="Company policies and their version history. The version in force is decided by its effective date."
        actions={
          can("policy:manage") && (
            <Button onClick={() => setPublishing({ title: "", category: "OTHER" })}>
              <Upload />
              Publish policy
            </Button>
          )
        }
      />
      {policies.error && <QueryError error={policies.error} />}
      {!policies.data && !policies.error && (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {policies.data?.map((p) => (
          <PolicyCard
            key={p.title}
            policy={p}
            onNewVersion={can("policy:manage") ? () => setPublishing({ title: p.title, category: p.category }) : undefined}
          />
        ))}
      </div>
      {publishing && (
        <PublishDialog
          initial={publishing}
          existingTitles={policies.data?.map((p) => p.title) ?? []}
          onClose={() => setPublishing(null)}
        />
      )}
    </>
  );
}

function PolicyCard({ policy, onNewVersion }: { policy: Policy; onNewVersion?: () => void }) {
  const openFile = useOpenFile();
  const headline = policy.current ?? policy.versions[0];

  async function view(v: PolicyVersion) {
    try {
      await openFile(`/policies/${v.id}/file`, v.fileName);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {policy.title}
          <Badge variant="secondary" className="font-normal">
            {POLICY_CATEGORY_LABELS[policy.category]}
          </Badge>
        </CardTitle>
        <CardDescription>{headline.summary}</CardDescription>
        {onNewVersion && (
          <CardAction>
            <Button size="sm" variant="outline" onClick={onNewVersion}>
              New version
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent>
        <ul className="divide-y text-sm">
          {policy.versions.map((v) => (
            <li key={v.id} className="flex items-center gap-3 py-2">
              <span className="w-8 font-medium">v{v.version}</span>
              <StatusBadge status={v.state} />
              <span className="flex-1 text-muted-foreground">
                {v.state === "UPCOMING" ? "Takes effect" : "Effective"} {formatDate(v.effectiveFrom)}
              </span>
              <Button size="sm" variant="ghost" onClick={() => view(v)} aria-label={`View ${policy.title} v${v.version}`}>
                <Eye />
                View
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function PublishDialog({
  initial,
  existingTitles,
  onClose,
}: {
  initial: { title: string; category: PolicyCategory };
  existingTitles: string[];
  onClose: () => void;
}) {
  const publish = usePublishPolicy();
  const [title, setTitle] = useState(initial.title);
  const [category, setCategory] = useState<PolicyCategory>(initial.category);
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [summary, setSummary] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const isNewVersion = existingTitles.some((t) => t.toLowerCase() === title.trim().toLowerCase());

  async function submit() {
    if (!file) return;
    try {
      const version = await publish.mutateAsync({
        title: title.trim(),
        category,
        effectiveFrom,
        summary: summary.trim() || undefined,
        file,
      });
      toast.success(`${title.trim()} v${version.version} published`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{initial.title ? `New version of ${initial.title}` : "Publish policy"}</DialogTitle>
          <DialogDescription>PDF, DOCX, Markdown or text. Earlier versions stay on file for traceability.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="space-y-2">
            <Label htmlFor="policy-title">Title</Label>
            <Input
              id="policy-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              list="policy-titles"
              disabled={!!initial.title}
            />
            <datalist id="policy-titles">
              {existingTitles.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            {isNewVersion && !initial.title && (
              <p className="text-xs text-muted-foreground">This publishes a new version of an existing policy.</p>
            )}
          </div>
          {!isNewVersion && (
            <div className="space-y-2">
              <Label htmlFor="policy-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as PolicyCategory)}>
                <SelectTrigger id="policy-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {POLICY_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {POLICY_CATEGORY_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="policy-effective">Effective from</Label>
            <Input id="policy-effective" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="policy-summary">What changed (optional)</Label>
            <Textarea id="policy-summary" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={500} rows={2} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="policy-file">Document</Label>
            <Input
              id="policy-file"
              type="file"
              accept=".pdf,.docx,.md,.txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!file || title.trim().length < 3 || !effectiveFrom || publish.isPending}>
            {publish.isPending && <Loader2 className="animate-spin" />}
            Publish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
