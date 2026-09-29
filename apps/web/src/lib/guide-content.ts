/**
 * User guide content. Every section and topic declares who it applies to in
 * terms of permissions (the same map the API enforces), so the guide shown to
 * each role matches what that role can actually do. Numbers come from the
 * shared contracts, so the guide can't drift from the rules the API applies.
 */
import {
  ATTENDANCE_RULES,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_UPLOAD_RULES,
  LEAVE_POLICY,
  LEAVE_RULES,
  POLICY_UPLOAD_RULES,
  REQUIRED_DOCUMENT_TYPES,
  isOrgWide,
  type Permission,
  type Role,
} from "@hr/contracts";
import {
  Banknote,
  BookOpen,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Clock,
  Compass,
  FileText,
  History,
  LayoutDashboard,
  Scale,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface GuideContext {
  role: Role;
  can: (permission: Permission) => boolean;
  /** HR and admins: everyone's records. */
  orgWide: boolean;
  /** Line managers: their direct reports' records. */
  isManager: boolean;
  /** Linked to an employee record (so has their own leave, documents, …). */
  hasEmployee: boolean;
}

export interface GuideTopic {
  title: string;
  show?: (ctx: GuideContext) => boolean;
  body?: string | ((ctx: GuideContext) => string);
  steps?: string[] | ((ctx: GuideContext) => string[]);
  tip?: string | ((ctx: GuideContext) => string);
}

export interface GuideSection {
  id: string;
  title: string;
  icon: LucideIcon;
  href?: string;
  /** Section is shown only with this permission (omit for everyone). */
  permission?: Permission;
  intro: (ctx: GuideContext) => string;
  topics: GuideTopic[];
}

export function guideContext(role: Role, permissions: Permission[], employeeId: string | null): GuideContext {
  return {
    role,
    can: (p) => permissions.includes(p),
    orgWide: isOrgWide(role),
    isManager: role === "MANAGER",
    hasEmployee: !!employeeId,
  };
}

export const roleSummaries: Record<Role, string> = {
  ADMIN:
    "Full access to every area: people records, onboarding, leave, attendance, documents, payroll preparation, policies and the audit log.",
  HR_OPS:
    "You run HR operations for the whole company: people records, onboarding, leave and attendance approvals, document verification, payroll preparation and policies.",
  MANAGER:
    "You can read the employee directory and look after your direct reports: approve their leave, review their attendance, propose corrections and follow their onboarding. Your own leave, attendance and documents work like everyone else's.",
  EMPLOYEE:
    "You manage your own leave, attendance, onboarding checklist and documents, and you can read company policies and departments.",
};

const leaveLines = Object.values(LEAVE_POLICY).map((p) =>
  p.daysPerYear === null ? `${p.label}: no fixed limit (needs approval).` : `${p.label}: ${p.daysPerYear} working days per calendar year.`,
);

export const guideSections: GuideSection[] = [
  {
    id: "getting-started",
    title: "Getting started",
    icon: Compass,
    intro: () => "How the app is laid out and how your session works.",
    topics: [
      {
        title: "Finding your way around",
        body: "The menu on the left only lists the areas your role can use. The header has a light/dark theme switch and your account menu, where you can open this guide or sign out.",
      },
      {
        title: "First sign-in and passwords",
        body: "HR gives you a login using your work email and a one-time temporary password. The first time you sign in you must choose your own password (at least 10 characters, with a letter and a number); nothing else works until you do. You can change it any time from your account menu → Change password, which signs out your other sessions.",
      },
      {
        title: "Your session",
        body: "Sessions last 8 hours. When one expires you're sent back to the sign-in page with a note; sign in again to carry on. Anything the server refuses is explained on screen rather than failing silently.",
      },
      {
        title: "Everything is recorded",
        body: "Every change (who made it, when, and what changed) is written to an audit log at the same moment the change is saved.",
      },
    ],
  },
  {
    id: "dashboard",
    title: "Dashboard",
    icon: LayoutDashboard,
    href: "/",
    intro: () => "Your starting point, with counts of what needs your attention. Select a card to jump straight to the list behind it.",
    topics: [
      {
        title: "Your cards",
        steps: (ctx) =>
          [
            ctx.can("leave:approve") && "Leave awaiting your approval",
            ctx.can("document:verify") && "Documents to verify",
            ctx.can("attendance:approve") && "Attendance corrections to approve",
            ctx.can("employee:read") && ctx.can("onboarding:read") && "Onboarding in progress",
            ctx.can("employee:read") && "Employees and employees on probation",
            "Active departments",
          ].filter((s): s is string => !!s),
      },
    ],
  },
  {
    id: "employees",
    title: "Employees",
    icon: Users,
    href: "/employees",
    permission: "employee:read",
    intro: (ctx) =>
      ctx.can("employee:update")
        ? "Keep employee records up to date: add new hires, edit details, and archive people who leave."
        : "Look people up in the employee directory. The directory is read-only for your role.",
    topics: [
      {
        title: "Search and filter",
        steps: [
          "Type any mix of name, email, employee code or job title; every word must match, so \"arun kumar\" finds Arun Kumar.",
          "Filter by department, status and location. Archived employees are hidden unless you pick the Archived status.",
          "From an employee's page, select their number of direct reports to list everyone who reports to them.",
          "Filters live in the page address, so you can bookmark or share a filtered list.",
        ],
      },
      {
        title: "Add an employee",
        show: (ctx) => ctx.can("employee:create"),
        steps: [
          "Employees → Add employee.",
          "Fill in personal and employment details. The form checks everything before sending.",
          "The employee code (EMP-0001, …) is assigned automatically.",
          "You land on the new hire's Onboarding tab, ready to start their checklist.",
        ],
      },
      {
        title: "Edit details",
        show: (ctx) => ctx.can("employee:update"),
        body: "Open the employee and select Edit. Only the fields you change are saved and recorded in their history. If someone else saved changes while you were editing, you'll be told and the form reloads with their version, so nobody's work is overwritten.",
        tip: "A manager can't be set to someone who reports to the employee (directly or indirectly); the app blocks reporting loops.",
      },
      {
        title: "Give app access",
        show: (ctx) => ctx.can("access:manage"),
        steps: (ctx) => [
          "Creating an employee doesn't create a login. Open the employee and find App access on the Overview tab.",
          `Select Give app access and choose a role (${ctx.role === "ADMIN" ? "any role" : "Employee, Manager or HR Operations; only an admin can grant Admin"}).`,
          "A temporary password appears once. Share it privately along with their work email; they must choose their own password at first sign-in.",
          "From the same card you can change their role, reset the password (signing them out everywhere) or turn access off. Changes apply on their next click.",
        ],
        tip: "You can't change your own access, and archiving an employee turns their login off automatically.",
      },
      {
        title: "Archive or reactivate",
        show: (ctx) => ctx.can("employee:archive"),
        body: "Use Archive on the employee page and add a reason; it goes into the audit log. Archived employees drop out of the directory and can't be edited until reactivated.",
        tip: "You can't archive someone who still has active direct reports or who manages a department. Reassign those first.",
      },
      {
        title: "The employee page",
        body: (ctx) => {
          const tabs = ["Overview"];
          if (ctx.can("onboarding:manage") || ctx.isManager) tabs.push("Onboarding");
          if (ctx.can("leave:manage") || ctx.isManager) tabs.push("Leave");
          if (ctx.can("attendance:approve") || ctx.isManager) tabs.push("Attendance");
          if (ctx.can("document:verify")) tabs.push("Documents");
          else if (ctx.hasEmployee) tabs.push("Documents (your own record only)");
          if (ctx.can("audit:read")) tabs.push("History");
          const scope = ctx.orgWide ? "for every employee" : "on your own record and your direct reports' records";
          return `Tabs you'll see ${scope}: ${tabs.join(", ")}.`;
        },
      },
    ],
  },
  {
    id: "onboarding",
    title: "Onboarding",
    icon: ClipboardCheck,
    href: "/onboarding",
    permission: "onboarding:read",
    intro: (ctx) =>
      ctx.orgWide
        ? "Run new hires' checklists from before day one to their 30-day check-in, and chase missing information."
        : ctx.isManager
          ? "Follow your new team members' onboarding and tick off the tasks assigned to you as their manager."
          : "Your checklist for getting started, including the documents HR needs from you.",
    topics: [
      {
        title: "Start onboarding",
        show: (ctx) => ctx.can("onboarding:manage"),
        steps: [
          "Open the employee's Onboarding tab (new hires land there automatically) and select Start onboarding.",
          "The checklist is built from company-wide tasks plus the department's own (e.g. repository access for Engineering, CRM handover for Sales).",
          "Due dates are relative to the joining date; anything past due is marked overdue.",
        ],
      },
      {
        title: "Work through the checklist",
        steps: (ctx) =>
          ctx.can("onboarding:manage")
            ? [
                "Tick a task when it's done; untick to reopen it.",
                "Use ⋯ → Skip task for tasks that don't apply. A note explaining why is required.",
                "The Onboarding page lists everyone in progress with overdue counts and missing information.",
              ]
            : ctx.isManager
              ? [
                  "Open Onboarding to see your team's new hires, then select a name.",
                  "You can tick tasks assigned to Manager (welcome message, buddy, check-ins). Other tasks belong to HR, IT or the new hire.",
                ]
              : [
                  "Open Onboarding to see your checklist.",
                  "You can tick tasks assigned to New hire, such as reading and acknowledging company policies.",
                ],
      },
      {
        title: "Document tasks complete themselves",
        body: `Tasks like "Collect PAN card" can't be ticked by hand. They complete automatically when HR verifies the matching document. Required documents: ${REQUIRED_DOCUMENT_TYPES.map((t) => DOCUMENT_TYPE_LABELS[t]).join(", ")}.`,
        tip: (ctx) => (ctx.can("document:verify") ? "Verify the document from the Documents queue and the task ticks itself." : "Upload them from Documents; they're done once HR verifies them."),
      },
      {
        title: "Missing information",
        show: (ctx) => ctx.orgWide || ctx.isManager,
        body: "Each new hire shows what's still missing: phone number, date of birth, a reporting manager, and required documents that are missing, waiting for verification, or flagged.",
      },
    ],
  },
  {
    id: "leave",
    title: "Leave",
    icon: CalendarDays,
    href: "/leave",
    permission: "leave:request",
    intro: (ctx) =>
      [
        ctx.hasEmployee ? "Request time off and keep track of your balances." : "Your account isn't linked to an employee record, so you don't have your own leave.",
        ctx.can("leave:approve")
          ? ctx.orgWide
            ? "You can approve or reject anyone's leave."
            : "You approve or reject your direct reports' leave."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    topics: [
      {
        title: "Request leave",
        show: (ctx) => ctx.hasEmployee,
        steps: (ctx) => [
          "Leave → Request leave.",
          "Choose the type and dates. The preview shows how many working days it uses (weekends and company holidays aren't counted) and your balance afterwards.",
          "If something's wrong, such as not enough balance or an overlap with other leave, the preview says exactly what, and Submit stays disabled until it's fixed.",
          ctx.isManager
            ? "Submit. Your request goes to HR (or your own manager), since nobody approves their own leave."
            : "Submit. The request stays Pending until your manager (or HR) decides.",
        ],
      },
      {
        title: "Balances and cancelling",
        show: (ctx) => ctx.hasEmployee,
        body: "My leave shows, for each type, how many days are left, used and pending. You can cancel a pending request at any time, and an approved one until it starts.",
      },
      {
        title: "Request leave for someone else",
        show: (ctx) => ctx.can("leave:manage"),
        body: "In the request dialog, choose the employee. The same rules and balance checks apply, and the request records that you filed it.",
      },
      {
        title: "Approve or reject",
        show: (ctx) => ctx.can("leave:approve"),
        steps: (ctx) => [
          `Leave → Approvals lists pending requests ${ctx.orgWide ? "from everyone except you" : "from your direct reports"}.`,
          "Approve, or Reject with a reason (the employee sees it).",
          "Approving re-checks the balance and overlaps at that moment, so a request that no longer fits can't be approved by accident.",
        ],
      },
      {
        title: "Team view and who's out",
        show: (ctx) => ctx.can("leave:manage") || ctx.isManager,
        body: (ctx) =>
          `${ctx.orgWide ? "All requests" : "My team"} lists every request with a status filter; Who's out shows approved leave for the next 30 days.`,
      },
      {
        title: "Company holidays",
        body: "The Holidays tab lists this year's company holidays. They're never deducted from balances.",
      },
    ],
  },
  {
    id: "attendance",
    title: "Attendance",
    icon: Clock,
    href: "/attendance",
    permission: "attendance:read",
    intro: (ctx) =>
      ctx.orgWide
        ? "Check everyone's attendance against approved leave, spot anomalies, and approve corrections."
        : ctx.isManager
          ? "Review your team's attendance, spot anomalies and propose corrections for HR to approve."
          : "See your own attendance month by month, including anything flagged.",
    topics: [
      {
        title: "Your calendar",
        show: (ctx) => !ctx.can("employee:read"),
        body: "Attendance shows your month day by day: check-in and check-out times, leave, holidays and weekends. Days with a problem have a warning icon, and the reasons are listed below the calendar.",
        tip: "Spotted a mistake? Ask your manager or HR to propose a correction; you can't edit past records yourself.",
      },
      {
        title: "Daily, monthly and anomalies",
        show: (ctx) => ctx.can("employee:read"),
        steps: (ctx) => [
          "Daily opens on the last working day. Pick any date to see who was present, on leave, absent or missing.",
          "Monthly totals present, half days, leave, absences, missing days and anomalies per person.",
          "Anomalies lists every flagged day in the month with the reason in plain words.",
          ctx.orgWide ? "Filter any view by department." : "You see yourself and your direct reports.",
        ],
      },
      {
        title: "Propose a correction",
        show: (ctx) => ctx.can("attendance:propose"),
        steps: (ctx) => [
          "Select Correct on a row in Daily, or select a day in someone's attendance calendar.",
          "Enter what the record should say and why.",
          "The record doesn't change yet. It shows Correction pending until HR approves it.",
          ...(ctx.isManager ? ["You can propose corrections for your direct reports."] : []),
        ],
      },
      {
        title: "Approve corrections",
        show: (ctx) => ctx.can("attendance:approve"),
        body: "Attendance → Corrections shows each proposal as before → after with the reason. Approving applies it to the record (marked \"corrected\"); rejecting leaves the record as it was. You can't approve a correction you proposed yourself, or one to your own attendance.",
      },
    ],
  },
  {
    id: "documents",
    title: "Documents",
    icon: FileText,
    href: "/documents",
    permission: "document:read",
    intro: (ctx) =>
      ctx.can("document:verify")
        ? "Verify employees' documents, flag problems, and keep required documents complete."
        : "Upload your documents for HR to verify. Only you and HR can see them.",
    topics: [
      {
        title: "Upload a document",
        show: (ctx) => ctx.can("document:upload") && ctx.hasEmployee,
        steps: [
          "Documents → Upload, or use the Upload button next to a missing required document.",
          "Pick the document type and the file.",
          "The document shows as Pending until HR verifies it.",
        ],
        tip: `PDF, JPEG or PNG, up to ${DOCUMENT_UPLOAD_RULES.maxBytes / 1024 / 1024} MB. Files are checked by their content, not their name.`,
      },
      {
        title: "Review queue",
        show: (ctx) => ctx.can("document:verify"),
        steps: [
          "Documents → Review queue lists uploads waiting for review, oldest first.",
          "Select View to open the file, then Verify, or Flag with a note saying what needs fixing.",
          "The Flagged tab keeps track of documents waiting for a corrected upload.",
          "Verifying a required document completes the matching onboarding task.",
        ],
        tip: "You can't review your own documents.",
      },
      {
        title: "Who can see documents",
        body: (ctx) =>
          ctx.isManager
            ? "Identity and bank documents are private: you see your own, but not your direct reports'. HR handles those."
            : "Documents are private to the employee and HR.",
      },
    ],
  },
  {
    id: "payroll",
    title: "Payroll preparation",
    icon: Banknote,
    href: "/payroll",
    permission: "payroll:read",
    intro: () => "Check the inputs for each month's payroll run and clear anything that blocks it. Salary calculation itself is out of scope for this release.",
    topics: [
      {
        title: "Read the report",
        steps: [
          "Pick a month. The current month is counted up to yesterday.",
          "For each person: working days, days worked, paid and unpaid leave, unexplained days, loss of pay and payable days.",
          "Half days count as half a day worked; unexplained days (absent or no record, with no leave) count as loss of pay.",
          "Changes this month lists joiners, exits and edits to job title, department, employment type or status.",
        ],
      },
      {
        title: "Clear the blockers",
        body: "Tick \"Only employees that need attention\" to see flags such as missing or unverified bank details and PAN, unresolved attendance, and pending leave or corrections. Each flag says what to fix.",
      },
      {
        title: "Export",
        body: "Export CSV downloads the month's report, flags included.",
      },
    ],
  },
  {
    id: "policies",
    title: "Policies",
    icon: BookOpen,
    href: "/policies",
    permission: "policy:read",
    intro: (ctx) =>
      ctx.can("policy:manage")
        ? "Publish company policies and new versions of them; everyone can read them."
        : "Read company policies. The version in force today is marked In force.",
    topics: [
      {
        title: "Versions",
        body: "Each policy keeps its full history. In force is the version that applies today; Upcoming versions take effect on a future date; Superseded versions are kept so past decisions stay traceable. Select View to open any version.",
      },
      {
        title: "Publish a policy or a new version",
        show: (ctx) => ctx.can("policy:manage"),
        steps: [
          "Policies → Publish policy, or New version on an existing policy.",
          "Set the effective date (a new version can't take effect before the current one) and say what changed.",
          `Attach the document: ${POLICY_UPLOAD_RULES.extensions.join(", ")}.`,
        ],
      },
    ],
  },
  {
    id: "departments",
    title: "Departments",
    icon: Building2,
    href: "/departments",
    permission: "department:read",
    intro: (ctx) =>
      ctx.can("department:manage") ? "Create and maintain departments and their managers." : "See the company's departments and who manages them.",
    topics: [
      {
        title: "Manage departments",
        show: (ctx) => ctx.can("department:manage"),
        body: "New department creates one with a short code (e.g. ENG). Use the pencil to rename, change the manager or archive. A department can only be archived once nobody is left in it.",
      },
    ],
  },
  {
    id: "history",
    title: "History and audit",
    icon: History,
    permission: "audit:read",
    intro: () => "See who changed what, and when.",
    topics: [
      {
        title: "Employee history",
        body: "The History tab on an employee's page lists every change to their record, newest first, with the before and after values for the fields that changed, plus onboarding starting.",
      },
    ],
  },
  {
    id: "rules",
    title: "Rules at a glance",
    icon: Scale,
    intro: () => "The rules the app applies. They're checked on the server, so they hold however a change is made.",
    topics: [
      {
        title: "Leave",
        show: (ctx) => ctx.can("leave:request"),
        steps: [
          ...leaveLines,
          "Joining mid-year: entitlements are prorated by the months remaining.",
          "Only working days count; weekends and company holidays inside a request are free.",
          `Requests can start up to ${LEAVE_RULES.maxBackdateDays} days in the past, cover at most ${LEAVE_RULES.maxSpanDays} calendar days, and can't span two years or overlap other leave.`,
        ],
      },
      {
        title: "Attendance",
        show: (ctx) => ctx.can("attendance:read"),
        steps: [
          `Checking in after ${ATTENDANCE_RULES.lateAfter} (India time) is a late check-in.`,
          `A full day needs at least ${ATTENDANCE_RULES.minHoursPresent} hours; a half day at least ${ATTENDANCE_RULES.minHoursHalfDay}.`,
          "A working day with no record and no approved leave is flagged, and counts as loss of pay if it's still unresolved at payroll time.",
          "Checking in on a day of approved leave is flagged.",
          "Past records change only through an approved correction.",
        ],
      },
      {
        title: "Approvals",
        steps: [
          "Nobody approves their own leave, attendance correction or documents.",
          "Whoever proposes an attendance correction can't also approve it.",
        ],
      },
    ],
  },
];
