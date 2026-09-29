"use client";

import type { Employee, Role } from "@hr/contracts";
import { Check, Copy, KeyRound, Loader2, ShieldCheck, ShieldOff, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryError } from "@/components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeAccess, useGrantAccess, useResetPassword, useUpdateAccess } from "@/lib/access-queries";
import { errorMessage } from "@/lib/api";
import { formatDateTime, fullName, roleLabels } from "@/lib/format";

/** App login for an employee: grant, change role, reset password, turn off. HR and admins only. */
export function EmployeeAccessCard({ employee }: { employee: Employee }) {
  const access = useEmployeeAccess(employee.id);
  const grant = useGrantAccess(employee.id);
  const update = useUpdateAccess(employee.id);
  const reset = useResetPassword(employee.id);
  const [granting, setGranting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [issued, setIssued] = useState<{ password: string; reason: "granted" | "reset" } | null>(null);

  if (access.error) return <QueryError error={access.error} />;
  const a = access.data;
  const archived = employee.status === "ARCHIVED";

  async function run<T>(action: Promise<T>, success: string) {
    try {
      const result = await action;
      toast.success(success);
      return result;
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          App access
        </CardTitle>
        <CardDescription>Their login uses their work email, {employee.email}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!a && <Skeleton className="h-16 w-full" />}

        {a && !a.hasAccess && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {archived
                ? "No login. Archived employees can't be given access."
                : `No login yet: ${employee.firstName} can't sign in.`}
            </p>
            {a.canManage && !archived && (
              <Button onClick={() => setGranting(true)}>
                <UserPlus />
                Give app access
              </Button>
            )}
          </div>
        )}

        {a?.hasAccess && (
          <>
            <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-3 text-sm">
              <dt className="text-muted-foreground">Status</dt>
              <dd className="flex flex-wrap items-center gap-2">
                {a.isActive ? (
                  <Badge variant="secondary" className="bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                    Can sign in
                  </Badge>
                ) : (
                  <Badge variant="secondary">Access turned off</Badge>
                )}
                {a.isActive && a.mustChangePassword && (
                  <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 dark:text-amber-400">
                    Waiting for first sign-in
                  </Badge>
                )}
              </dd>
              <dt className="text-muted-foreground">Role</dt>
              <dd>
                {a.canManage ? (
                  <Select
                    value={a.role ?? undefined}
                    onValueChange={(role) =>
                      void run(update.mutateAsync({ role: role as Role }), `Role changed to ${roleLabels[role as Role]}`)
                    }
                    disabled={update.isPending}
                  >
                    <SelectTrigger className="w-48" aria-label="Role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {a.grantableRoles.map((r) => (
                        <SelectItem key={r} value={r}>
                          {roleLabels[r]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  a.role && roleLabels[a.role]
                )}
              </dd>
              <dt className="text-muted-foreground">Last sign-in</dt>
              <dd>{a.lastLoginAt ? formatDateTime(a.lastLoginAt) : "Never"}</dd>
            </dl>

            {a.canManage ? (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => setConfirmReset(true)} disabled={!a.isActive}>
                  <KeyRound />
                  Reset password
                </Button>
                {a.isActive ? (
                  <Button
                    variant="outline"
                    onClick={() => void run(update.mutateAsync({ isActive: false }), `${employee.firstName} can no longer sign in`)}
                    disabled={update.isPending}
                  >
                    <ShieldOff />
                    Turn off access
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => void run(update.mutateAsync({ isActive: true }), `${employee.firstName} can sign in again`)}
                    disabled={update.isPending || archived}
                  >
                    <ShieldCheck />
                    Turn on access
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {a.role === "ADMIN"
                  ? "Only an admin can change an admin's login."
                  : "This is your own login. Ask another HR admin to change it."}
              </p>
            )}
          </>
        )}
      </CardContent>

      {granting && a && (
        <GrantDialog
          employee={employee}
          roles={a.grantableRoles}
          pending={grant.isPending}
          onClose={() => setGranting(false)}
          onGrant={async (role) => {
            const result = await run(grant.mutateAsync(role), `${employee.firstName} now has app access`);
            if (result) {
              setGranting(false);
              setIssued({ password: result.temporaryPassword, reason: "granted" });
            }
          }}
        />
      )}

      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset {fullName(employee)}&apos;s password?</DialogTitle>
            <DialogDescription>
              Their current password stops working and they&apos;re signed out everywhere. You&apos;ll get a new
              temporary password to give them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              disabled={reset.isPending}
              onClick={async () => {
                const result = await run(reset.mutateAsync(), "Password reset");
                setConfirmReset(false);
                if (result) setIssued({ password: result.temporaryPassword, reason: "reset" });
              }}
            >
              {reset.isPending && <Loader2 className="animate-spin" />}
              Reset password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {issued && (
        <TemporaryPasswordDialog
          employee={employee}
          password={issued.password}
          reason={issued.reason}
          onClose={() => setIssued(null)}
        />
      )}
    </Card>
  );
}

function GrantDialog({
  employee,
  roles,
  pending,
  onClose,
  onGrant,
}: {
  employee: Employee;
  roles: Role[];
  pending: boolean;
  onClose: () => void;
  onGrant: (role: Role) => Promise<void>;
}) {
  const [role, setRole] = useState<Role>("EMPLOYEE");
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Give {fullName(employee)} app access</DialogTitle>
          <DialogDescription>
            They&apos;ll sign in with {employee.email} and a temporary password you&apos;ll see next. They must choose
            their own password when they first sign in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="access-role">Role</Label>
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger id="access-role" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabels[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Employee: their own records. Manager: plus their direct reports. HR Operations: everyone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void onGrant(role)} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            Give access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemporaryPasswordDialog({
  employee,
  password,
  reason,
  onClose,
}: {
  employee: Employee;
  password: string;
  reason: "granted" | "reset";
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      toast.error("Couldn't copy. Select the password and copy it manually.");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{reason === "granted" ? "Access created" : "Password reset"}</DialogTitle>
          <DialogDescription>
            Give {employee.firstName} these sign-in details. They&apos;ll be asked to choose their own password
            straight away.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[6rem_1fr] items-center gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="font-medium break-all">{employee.email}</dd>
          <dt className="text-muted-foreground">Password</dt>
          <dd className="flex items-center gap-2">
            <code className="rounded-md bg-muted px-2 py-1 font-mono text-base tracking-wider select-all" data-testid="temporary-password">
              {password}
            </code>
            <Button size="icon-sm" variant="ghost" onClick={copy} aria-label="Copy password">
              {copied ? <Check /> : <Copy />}
            </Button>
          </dd>
        </dl>
        <Alert>
          <AlertTitle>This is the only time it&apos;s shown</AlertTitle>
          <AlertDescription>
            Share it privately (not in a group chat). If it&apos;s lost, reset the password to get a new one.
          </AlertDescription>
        </Alert>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
