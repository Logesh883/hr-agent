"use client";

import { PERMISSIONS, ROLE_PERMISSIONS, ROLES, type Permission } from "@hr/contracts";
import { ArrowRight, Check, Lightbulb, Lock, Minus } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { roleLabels } from "@/lib/format";
import {
  guideContext,
  guideSections,
  roleSummaries,
  type GuideContext,
  type GuideSection,
  type GuideTopic,
} from "@/lib/guide-content";
import { useCurrentUser } from "@/lib/session";
import { cn } from "@/lib/utils";

/** Plain-language names for each permission, for the roles table. */
const capabilityLabels: Record<Permission, string> = {
  "employee:read": "View the employee directory",
  "employee:create": "Add employees",
  "employee:update": "Edit employee records",
  "employee:archive": "Archive and reactivate employees",
  "department:read": "View departments",
  "department:manage": "Manage departments",
  "audit:read": "View change history",
  "leave:request": "Request your own leave",
  "leave:approve": "Approve leave (managers: direct reports)",
  "leave:manage": "Manage everyone's leave",
  "onboarding:read": "View onboarding (own, team or all)",
  "onboarding:manage": "Start and manage onboarding",
  "document:read": "View documents (own; HR: everyone's)",
  "document:upload": "Upload documents",
  "document:verify": "Verify and flag documents",
  "attendance:read": "View attendance (own, team or all)",
  "attendance:propose": "Propose attendance corrections",
  "attendance:approve": "Approve attendance corrections",
  "payroll:read": "Payroll preparation",
  "policy:read": "Read policies",
  "policy:manage": "Publish policies",
  "access:manage": "Give app access, change roles, reset passwords",
};

const resolve = <T,>(value: T | ((ctx: GuideContext) => T) | undefined, ctx: GuideContext) =>
  typeof value === "function" ? (value as (ctx: GuideContext) => T)(ctx) : value;

export default function GuidePage() {
  const user = useCurrentUser();
  if (!user) return null;

  const ctx = guideContext(user.role, user.permissions, user.employeeId);
  const available = guideSections.filter((s) => !s.permission || ctx.can(s.permission));
  const unavailable = guideSections.filter((s) => s.permission && !ctx.can(s.permission));

  return (
    <>
      <PageHeader
        title="User guide"
        description={`Tailored to your role. It only covers what ${roleLabels[user.role]} can do in this app.`}
      />

      <Card className="mb-6">
        <CardHeader>
          <CardDescription>You&apos;re signed in as {user.name}</CardDescription>
          <CardTitle className="flex items-center gap-2 text-xl">
            {roleLabels[user.role]}
            <Badge variant="secondary">Your role</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-3xl text-sm">{roleSummaries[user.role]}</p>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <nav aria-label="Guide contents" className="lg:sticky lg:top-6 lg:self-start">
          <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Contents</p>
          <ul className="flex flex-wrap gap-1 lg:flex-col">
            {available.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                  <s.icon className="size-4 text-muted-foreground" />
                  {s.title}
                </a>
              </li>
            ))}
            <li>
              <a href="#roles" className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted">
                <Lock className="size-4 text-muted-foreground" />
                Roles at a glance
              </a>
            </li>
          </ul>
        </nav>

        <div className="min-w-0 space-y-6">
          {available.map((section) => (
            <GuideSectionCard key={section.id} section={section} ctx={ctx} />
          ))}

          {unavailable.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Not available to your role</CardTitle>
                <CardDescription>Ask someone with one of these roles if you need them.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm">
                  {unavailable.map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center gap-2">
                      <s.icon className="size-4 text-muted-foreground" />
                      <span className="font-medium">{s.title}</span>
                      <span className="text-muted-foreground">
                        {ROLES.filter((r) => ROLE_PERMISSIONS[r].includes(s.permission!))
                          .map((r) => roleLabels[r])
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}

          <RolesTable currentRole={user.role} />
        </div>
      </div>
    </>
  );
}

function GuideSectionCard({ section, ctx }: { section: GuideSection; ctx: GuideContext }) {
  const topics = section.topics.filter((t) => !t.show || t.show(ctx));
  return (
    <section id={section.id} className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <section.icon className="size-5 text-muted-foreground" />
            {section.title}
          </CardTitle>
          <CardDescription>{section.intro(ctx)}</CardDescription>
          {section.href && (
            <CardAction>
              <Link href={section.href} className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
                Open {section.title}
                <ArrowRight className="size-3.5" />
              </Link>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-5">
          {topics.map((topic) => (
            <Topic key={topic.title} topic={topic} ctx={ctx} />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

function Topic({ topic, ctx }: { topic: GuideTopic; ctx: GuideContext }) {
  const body = resolve(topic.body, ctx);
  const steps = resolve(topic.steps, ctx);
  const tip = resolve(topic.tip, ctx);
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{topic.title}</h3>
      {body && <p className="text-sm text-muted-foreground">{body}</p>}
      {steps && steps.length > 0 && (
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground marker:text-foreground/60">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      )}
      {tip && (
        <p className="mt-2 flex items-start gap-1.5 rounded-md bg-muted/60 px-3 py-2 text-xs">
          <Lightbulb className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          {tip}
        </p>
      )}
    </div>
  );
}

function RolesTable({ currentRole }: { currentRole: (typeof ROLES)[number] }) {
  return (
    <section id="roles" className="scroll-mt-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="size-5 text-muted-foreground" />
            Roles at a glance
          </CardTitle>
          <CardDescription>
            What each role can do. HR and admins work across the whole company; managers see themselves and their direct
            reports; employees see their own records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Capability</TableHead>
                  {ROLES.map((r) => (
                    <TableHead
                      key={r}
                      className={cn("text-center", r === currentRole && "bg-muted font-semibold text-foreground")}
                    >
                      {roleLabels[r]}
                      {r === currentRole && <span className="block text-[10px] font-normal">(you)</span>}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {PERMISSIONS.map((p) => (
                  <TableRow key={p}>
                    <TableCell className="text-sm">{capabilityLabels[p]}</TableCell>
                    {ROLES.map((r) => {
                      const allowed = ROLE_PERMISSIONS[r].includes(p);
                      return (
                        <TableCell key={r} className={cn("text-center", r === currentRole && "bg-muted")}>
                          {allowed ? (
                            <Check className="mx-auto size-4 text-emerald-600" aria-label="Yes" />
                          ) : (
                            <Minus className="mx-auto size-4 text-muted-foreground/50" aria-label="No" />
                          )}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
