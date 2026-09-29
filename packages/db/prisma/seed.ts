/**
 * Demo seed: 4 departments, 20 employees, one login per role, a holiday
 * calendar, leave requests in every status, and employee documents (demo PDFs).
 * Idempotent — safe to re-run; records are upserted by their unique keys.
 *
 * Priya is intentionally absent: "Onboard Priya…" is the headline AI demo.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config as loadEnv } from 'dotenv';
import {
  createPrismaClient,
  type DocumentStatus,
  type DocumentType,
  type EmployeeStatus,
  type EmploymentType,
  type LeaveStatus,
  type LeaveType,
  type OnboardingAssignee,
  type OnboardingCategory,
  type Role,
} from '../src/index.js';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

export const DEMO_PASSWORD = 'Password123!';

const prisma = createPrismaClient();

const departments = [
  { code: 'ENG', name: 'Engineering' },
  { code: 'PRD', name: 'Product' },
  { code: 'PEO', name: 'People Operations' },
  { code: 'SAL', name: 'Sales' },
] as const;

type DeptCode = (typeof departments)[number]['code'];

interface SeedEmployee {
  firstName: string;
  lastName: string;
  jobTitle: string;
  dept: DeptCode;
  /** Email local-part of this employee's manager. */
  manager?: string;
  location: string;
  joiningDate: string;
  dateOfBirth: string;
  employmentType?: EmploymentType;
  status?: EmployeeStatus;
  phone?: string;
}

// Order matters: managers first, so their codes come first.
const employees: SeedEmployee[] = [
  { firstName: 'Meera', lastName: 'Iyer', jobTitle: 'Head of People Operations', dept: 'PEO', location: 'Bangalore', joiningDate: '2021-04-01', dateOfBirth: '1984-02-11', phone: '+91 98450 11001' },
  { firstName: 'Rahul', lastName: 'Sharma', jobTitle: 'Engineering Manager', dept: 'ENG', location: 'Bangalore', joiningDate: '2021-07-15', dateOfBirth: '1986-09-23', phone: '+91 98450 11002' },
  { firstName: 'Ananya', lastName: 'Reddy', jobTitle: 'Head of Product', dept: 'PRD', location: 'Hyderabad', joiningDate: '2022-01-10', dateOfBirth: '1988-05-30', phone: '+91 98450 11003' },
  { firstName: 'Vikram', lastName: 'Singh', jobTitle: 'Sales Director', dept: 'SAL', location: 'Mumbai', joiningDate: '2021-11-01', dateOfBirth: '1983-12-04', phone: '+91 98450 11004' },
  { firstName: 'Arun', lastName: 'Kumar', jobTitle: 'Senior Software Engineer', dept: 'ENG', manager: 'rahul.sharma', location: 'Bangalore', joiningDate: '2022-03-21', dateOfBirth: '1991-07-17' },
  { firstName: 'Sneha', lastName: 'Patel', jobTitle: 'Software Engineer', dept: 'ENG', manager: 'rahul.sharma', location: 'Bangalore', joiningDate: '2023-06-05', dateOfBirth: '1996-03-08' },
  { firstName: 'Karthik', lastName: 'Nair', jobTitle: 'DevOps Engineer', dept: 'ENG', manager: 'rahul.sharma', location: 'Chennai', joiningDate: '2023-09-18', dateOfBirth: '1993-10-27' },
  { firstName: 'Divya', lastName: 'Menon', jobTitle: 'QA Engineer', dept: 'ENG', manager: 'rahul.sharma', location: 'Bangalore', joiningDate: '2024-02-12', dateOfBirth: '1995-01-19' },
  { firstName: 'Rohan', lastName: 'Gupta', jobTitle: 'Software Engineer', dept: 'ENG', manager: 'rahul.sharma', location: 'Pune', joiningDate: '2026-07-01', dateOfBirth: '1999-06-02', status: 'PROBATION' },
  { firstName: 'Aisha', lastName: 'Khan', jobTitle: 'Software Engineering Intern', dept: 'ENG', manager: 'arun.kumar', location: 'Bangalore', joiningDate: '2026-06-15', dateOfBirth: '2003-04-14', employmentType: 'INTERN', status: 'PROBATION' },
  { firstName: 'Neha', lastName: 'Joshi', jobTitle: 'Product Manager', dept: 'PRD', manager: 'ananya.reddy', location: 'Hyderabad', joiningDate: '2023-03-13', dateOfBirth: '1992-08-25' },
  { firstName: 'Siddharth', lastName: 'Rao', jobTitle: 'Product Designer', dept: 'PRD', manager: 'ananya.reddy', location: 'Bangalore', joiningDate: '2024-05-06', dateOfBirth: '1994-11-09' },
  { firstName: 'Pooja', lastName: 'Verma', jobTitle: 'UX Researcher', dept: 'PRD', manager: 'ananya.reddy', location: 'Hyderabad', joiningDate: '2026-08-03', dateOfBirth: '1997-02-21', employmentType: 'CONTRACT', status: 'PROBATION' },
  { firstName: 'Lakshmi', lastName: 'Pillai', jobTitle: 'HR Operations Executive', dept: 'PEO', manager: 'meera.iyer', location: 'Bangalore', joiningDate: '2022-08-22', dateOfBirth: '1993-06-12', phone: '+91 98450 11014' },
  { firstName: 'Farhan', lastName: 'Ali', jobTitle: 'Talent Acquisition Specialist', dept: 'PEO', manager: 'meera.iyer', location: 'Bangalore', joiningDate: '2024-10-14', dateOfBirth: '1996-09-03' },
  { firstName: 'Kavya', lastName: 'Shetty', jobTitle: 'Payroll Specialist', dept: 'PEO', manager: 'meera.iyer', location: 'Mangalore', joiningDate: '2025-01-20', dateOfBirth: '1995-12-28', employmentType: 'PART_TIME' },
  { firstName: 'Amit', lastName: 'Desai', jobTitle: 'Account Executive', dept: 'SAL', manager: 'vikram.singh', location: 'Mumbai', joiningDate: '2023-04-17', dateOfBirth: '1992-03-15' },
  { firstName: 'Riya', lastName: 'Chatterjee', jobTitle: 'Sales Development Rep', dept: 'SAL', manager: 'vikram.singh', location: 'Kolkata', joiningDate: '2026-05-11', dateOfBirth: '1998-07-07', status: 'PROBATION' },
  { firstName: 'Manoj', lastName: 'Yadav', jobTitle: 'Account Executive', dept: 'SAL', manager: 'vikram.singh', location: 'Delhi', joiningDate: '2024-07-29', dateOfBirth: '1990-01-31' },
  { firstName: 'Suresh', lastName: 'Babu', jobTitle: 'Customer Success Manager', dept: 'SAL', manager: 'vikram.singh', location: 'Chennai', joiningDate: '2022-06-06', dateOfBirth: '1989-10-16', status: 'ARCHIVED' },
];

const departmentManagers: Record<DeptCode, string> = {
  ENG: 'rahul.sharma',
  PRD: 'ananya.reddy',
  PEO: 'meera.iyer',
  SAL: 'vikram.singh',
};

const users: { email: string; name: string; role: Role; employee?: string }[] = [
  { email: 'admin@hr.local', name: 'System Admin', role: 'ADMIN' },
  { email: 'hr@hr.local', name: 'Lakshmi Pillai', role: 'HR_OPS', employee: 'lakshmi.pillai' },
  { email: 'manager@hr.local', name: 'Rahul Sharma', role: 'MANAGER', employee: 'rahul.sharma' },
  { email: 'employee@hr.local', name: 'Sneha Patel', role: 'EMPLOYEE', employee: 'sneha.patel' },
];

/** Demo company calendar: fixed-date holidays only. */
const holidays = [
  { date: '2026-01-01', name: "New Year's Day" },
  { date: '2026-01-26', name: 'Republic Day' },
  { date: '2026-05-01', name: 'Labour Day' },
  { date: '2026-08-15', name: 'Independence Day' },
  { date: '2026-10-02', name: 'Gandhi Jayanti' },
  { date: '2026-12-25', name: 'Christmas' },
  { date: '2027-01-01', name: "New Year's Day" },
  { date: '2027-01-26', name: 'Republic Day' },
  { date: '2027-05-01', name: 'Labour Day' },
  { date: '2027-08-15', name: 'Independence Day' },
  { date: '2027-10-02', name: 'Gandhi Jayanti' },
  { date: '2027-12-25', name: 'Christmas' },
];

const HR = 'hr@hr.local';
const RAHUL = 'manager@hr.local';
const SNEHA = 'employee@hr.local';

/** Fixed ids keep re-seeding idempotent. */
const leaveRequests: {
  id: string;
  employee: string;
  type: LeaveType;
  start: string;
  end: string;
  status: LeaveStatus;
  reason: string;
  requestedBy: string;
  decidedBy?: string;
  comment?: string;
}[] = [
  { id: '6c1f0a2e-0001-4000-8000-000000000001', employee: 'arun.kumar', type: 'ANNUAL', start: '2026-08-10', end: '2026-08-14', status: 'APPROVED', reason: 'Family trip', requestedBy: HR, decidedBy: RAHUL },
  { id: '6c1f0a2e-0001-4000-8000-000000000002', employee: 'sneha.patel', type: 'SICK', start: '2026-07-06', end: '2026-07-06', status: 'APPROVED', reason: 'Fever', requestedBy: SNEHA, decidedBy: RAHUL },
  { id: '6c1f0a2e-0001-4000-8000-000000000003', employee: 'karthik.nair', type: 'SICK', start: '2026-09-14', end: '2026-09-15', status: 'APPROVED', reason: 'Viral infection', requestedBy: HR, decidedBy: RAHUL },
  { id: '6c1f0a2e-0001-4000-8000-000000000004', employee: 'amit.desai', type: 'ANNUAL', start: '2026-09-21', end: '2026-09-25', status: 'APPROVED', reason: 'Wedding in the family', requestedBy: HR, decidedBy: HR },
  { id: '6c1f0a2e-0001-4000-8000-000000000005', employee: 'divya.menon', type: 'ANNUAL', start: '2026-12-21', end: '2026-12-31', status: 'REJECTED', reason: 'Year-end holiday', requestedBy: HR, decidedBy: RAHUL, comment: 'Release freeze in the last two weeks of December' },
  { id: '6c1f0a2e-0001-4000-8000-000000000006', employee: 'sneha.patel', type: 'ANNUAL', start: '2026-10-19', end: '2026-10-23', status: 'PENDING', reason: 'Diwali at home', requestedBy: SNEHA },
  { id: '6c1f0a2e-0001-4000-8000-000000000007', employee: 'rohan.gupta', type: 'CASUAL', start: '2026-10-09', end: '2026-10-09', status: 'PENDING', reason: 'Personal errand', requestedBy: HR },
  { id: '6c1f0a2e-0001-4000-8000-000000000008', employee: 'rahul.sharma', type: 'ANNUAL', start: '2026-11-02', end: '2026-11-06', status: 'PENDING', reason: 'Vacation', requestedBy: RAHUL },
  { id: '6c1f0a2e-0001-4000-8000-000000000009', employee: 'neha.joshi', type: 'CASUAL', start: '2026-10-05', end: '2026-10-05', status: 'PENDING', reason: 'Moving house', requestedBy: HR },
];

function workingDays(start: string, end: string, holidayDates: Set<string>): number {
  let count = 0;
  for (let d = date(start); d <= date(end); d = new Date(d.getTime() + 86_400_000)) {
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6 && !holidayDates.has(d.toISOString().slice(0, 10))) count++;
  }
  return count;
}

const emailFor = (e: Pick<SeedEmployee, 'firstName' | 'lastName'>) =>
  `${e.firstName}.${e.lastName}@acme.example`.toLowerCase();
const localPart = (email: string) => email.split('@')[0];
const date = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function main() {
  const deptIds = new Map<DeptCode, string>();
  for (const d of departments) {
    const row = await prisma.department.upsert({
      where: { code: d.code },
      update: { name: d.name },
      create: { code: d.code, name: d.name },
    });
    deptIds.set(d.code, row.id);
  }

  const employeeIds = new Map<string, string>();
  for (const [index, e] of employees.entries()) {
    const email = emailFor(e);
    const data = {
      firstName: e.firstName,
      lastName: e.lastName,
      phone: e.phone ?? null,
      dateOfBirth: date(e.dateOfBirth),
      jobTitle: e.jobTitle,
      location: e.location,
      joiningDate: date(e.joiningDate),
      employmentType: e.employmentType ?? 'FULL_TIME',
      status: e.status ?? 'ACTIVE',
      departmentId: deptIds.get(e.dept)!,
      managerId: e.manager ? (employeeIds.get(e.manager) ?? null) : null,
    };
    const row = await prisma.employee.upsert({
      where: { email },
      update: data,
      create: {
        ...data,
        email,
        employeeCode: `EMP-${String(index + 1).padStart(4, '0')}`,
      },
    });
    employeeIds.set(localPart(email), row.id);
  }

  await prisma.counter.upsert({
    where: { name: 'employeeCode' },
    update: {},
    create: { name: 'employeeCode', value: employees.length },
  });

  for (const [code, manager] of Object.entries(departmentManagers)) {
    await prisma.department.update({
      where: { code },
      data: { managerId: employeeIds.get(manager) },
    });
  }

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of users) {
    const employeeId = u.employee ? employeeIds.get(u.employee)! : null;
    await prisma.user.upsert({
      where: { email: u.email },
      update: { name: u.name, role: u.role, employeeId, passwordHash },
      create: { email: u.email, name: u.name, role: u.role, employeeId, passwordHash },
    });
  }

  const userIds = new Map<string, string>();
  for (const u of await prisma.user.findMany({ select: { id: true, email: true } })) {
    userIds.set(u.email, u.id);
  }

  for (const h of holidays) {
    await prisma.holiday.upsert({
      where: { date: date(h.date) },
      update: { name: h.name },
      create: { date: date(h.date), name: h.name },
    });
  }
  const holidayDates = new Set(holidays.map((h) => h.date));

  for (const l of leaveRequests) {
    const data = {
      employeeId: employeeIds.get(l.employee)!,
      type: l.type,
      startDate: date(l.start),
      endDate: date(l.end),
      days: workingDays(l.start, l.end, holidayDates),
      reason: l.reason,
      status: l.status,
      requestedById: userIds.get(l.requestedBy)!,
      decidedById: l.decidedBy ? userIds.get(l.decidedBy)! : null,
      decidedAt: l.decidedBy ? new Date(`${l.start}T04:30:00.000Z`) : null,
      decisionComment: l.comment ?? null,
    };
    await prisma.leaveRequest.upsert({ where: { id: l.id }, update: data, create: { id: l.id, ...data } });
  }

  const documentCount = await seedDocuments(employeeIds, userIds);
  const taskCount = await seedOnboarding(deptIds, employeeIds, userIds);

  console.log(
    `Seeded ${departments.length} departments, ${employees.length} employees, ${users.length} users, ` +
      `${holidays.length} holidays, ${leaveRequests.length} leave requests, ${documentCount} documents, ` +
      `${onboardingTemplates.length} onboarding templates, ${taskCount} onboarding tasks.`,
  );
  console.log(`Demo logins (password "${DEMO_PASSWORD}"): ${users.map((u) => u.email).join(', ')}`);
}

// ---- Onboarding ---------------------------------------------------------------

const onboardingTemplates: {
  title: string;
  description?: string;
  category: OnboardingCategory;
  assignee: OnboardingAssignee;
  dueOffsetDays: number;
  dept?: DeptCode;
  requiredDocumentType?: DocumentType;
}[] = [
  { title: 'Send offer letter and collect the signed copy', category: 'PAPERWORK', assignee: 'HR', dueOffsetDays: -14, requiredDocumentType: 'OFFER_LETTER' },
  { title: 'Collect ID proof', category: 'DOCUMENTS', assignee: 'EMPLOYEE', dueOffsetDays: -7, requiredDocumentType: 'ID_PROOF' },
  { title: 'Collect PAN card', category: 'DOCUMENTS', assignee: 'EMPLOYEE', dueOffsetDays: -7, requiredDocumentType: 'PAN_CARD' },
  { title: 'Collect bank account details', description: 'Needed before the first payroll run.', category: 'DOCUMENTS', assignee: 'EMPLOYEE', dueOffsetDays: -3, requiredDocumentType: 'BANK_DETAILS' },
  { title: 'Create email and system accounts', category: 'IT_SETUP', assignee: 'IT', dueOffsetDays: -2 },
  { title: 'Prepare laptop', category: 'IT_SETUP', assignee: 'IT', dueOffsetDays: -1 },
  { title: 'Send a welcome message to the new hire', category: 'TEAM', assignee: 'MANAGER', dueOffsetDays: -1 },
  { title: 'Day-one HR orientation', category: 'ORIENTATION', assignee: 'HR', dueOffsetDays: 0 },
  { title: 'Assign an onboarding buddy', category: 'TEAM', assignee: 'MANAGER', dueOffsetDays: 0 },
  { title: 'Grant GitHub and cloud access', category: 'IT_SETUP', assignee: 'IT', dueOffsetDays: 0, dept: 'ENG' },
  { title: 'CRM access and territory handover', category: 'TEAM', assignee: 'MANAGER', dueOffsetDays: 3, dept: 'SAL' },
  { title: 'First code review walkthrough', category: 'TEAM', assignee: 'MANAGER', dueOffsetDays: 5, dept: 'ENG' },
  { title: 'Read and acknowledge company policies', category: 'ORIENTATION', assignee: 'EMPLOYEE', dueOffsetDays: 7 },
  { title: '30-day check-in', description: 'Review goals, fit and any blockers.', category: 'TEAM', assignee: 'MANAGER', dueOffsetDays: 30 },
];

/** Recent joiners with onboarding underway; tasks due on or before `doneThrough` are complete. */
const onboardingInProgress: Record<string, string> = {
  'riya.chatterjee': '2026-12-31',
  'aisha.khan': '2026-07-10',
  'rohan.gupta': '2026-07-10',
  'pooja.verma': '2026-08-02',
};

async function seedOnboarding(
  deptIds: Map<DeptCode, string>,
  employeeIds: Map<string, string>,
  userIds: Map<string, string>,
) {
  const templateIds: string[] = [];
  for (const [i, t] of onboardingTemplates.entries()) {
    const id = `6c1f0a2e-0004-4000-8000-${String(i + 1).padStart(12, '0')}`;
    const data = {
      title: t.title,
      description: t.description ?? null,
      category: t.category,
      assignee: t.assignee,
      dueOffsetDays: t.dueOffsetDays,
      departmentId: t.dept ? deptIds.get(t.dept)! : null,
      requiredDocumentType: t.requiredDocumentType ?? null,
      sortOrder: (i + 1) * 10,
    };
    await prisma.onboardingTemplateTask.upsert({ where: { id }, update: data, create: { id, ...data } });
    templateIds.push(id);
  }

  const hr = userIds.get(HR)!;
  let n = 0;
  for (const [key, doneThrough] of Object.entries(onboardingInProgress)) {
    const e = employees.find((x) => localPart(emailFor(x)) === key)!;
    const employeeId = employeeIds.get(key)!;
    const verified = new Set(
      (await prisma.document.findMany({ where: { employeeId, status: 'VERIFIED' }, select: { type: true } })).map((d) => d.type),
    );
    for (const [i, t] of onboardingTemplates.entries()) {
      if (t.dept && t.dept !== e.dept) continue;
      n++;
      const id = `6c1f0a2e-0003-4000-8000-${String(n).padStart(12, '0')}`;
      const due = new Date(date(e.joiningDate).getTime() + t.dueOffsetDays * 86_400_000);
      const done = t.requiredDocumentType
        ? verified.has(t.requiredDocumentType)
        : due.toISOString().slice(0, 10) <= doneThrough;
      const data = {
        employeeId,
        templateTaskId: templateIds[i],
        title: t.title,
        description: t.description ?? null,
        category: t.category,
        assignee: t.assignee,
        dueDate: due,
        requiredDocumentType: t.requiredDocumentType ?? null,
        sortOrder: (i + 1) * 10,
        status: done ? ('DONE' as const) : ('PENDING' as const),
        completedAt: done ? new Date(due.getTime() + 6 * 3_600_000) : null,
        completedById: done ? hr : null,
        notes: null,
      };
      await prisma.onboardingTask.upsert({ where: { id }, update: data, create: { id, ...data } });
    }
  }
  return n;
}

// ---- Documents ---------------------------------------------------------------

const REQUIRED: DocumentType[] = ['OFFER_LETTER', 'ID_PROOF', 'PAN_CARD', 'BANK_DETAILS'];

/** Per-employee exceptions to "all required documents uploaded and verified". */
const documentOverrides: Record<string, Partial<Record<DocumentType, DocumentStatus | 'MISSING'>>> = {
  'rohan.gupta': { ID_PROOF: 'PENDING', PAN_CARD: 'PENDING', BANK_DETAILS: 'MISSING' },
  'aisha.khan': { PAN_CARD: 'PENDING', BANK_DETAILS: 'MISSING' },
  'pooja.verma': { OFFER_LETTER: 'PENDING', ID_PROOF: 'MISSING', PAN_CARD: 'MISSING', BANK_DETAILS: 'MISSING' },
  'riya.chatterjee': { BANK_DETAILS: 'PENDING' },
  'kavya.shetty': { BANK_DETAILS: 'FLAGGED' },
};

const docLabels: Record<DocumentType, string> = {
  OFFER_LETTER: 'Offer Letter',
  ID_PROOF: 'Identity Proof (Aadhaar)',
  ADDRESS_PROOF: 'Address Proof',
  PAN_CARD: 'PAN Card',
  BANK_DETAILS: 'Bank Account Details',
  EDUCATION_CERTIFICATE: 'Education Certificate',
  EXPERIENCE_LETTER: 'Experience Letter',
  PHOTO: 'Photo',
  OTHER: 'Document',
};

async function seedDocuments(employeeIds: Map<string, string>, userIds: Map<string, string>) {
  const storageRoot = path.resolve(
    import.meta.dirname,
    '../../..',
    process.env.STORAGE_DIR ?? 'storage',
  );
  const hr = userIds.get(HR)!;
  const admin = userIds.get('admin@hr.local')!;
  let n = 0;

  for (const e of employees) {
    const key = localPart(emailFor(e));
    const employeeId = employeeIds.get(key)!;
    const name = `${e.firstName} ${e.lastName}`;
    for (const type of REQUIRED) {
      n++;
      const status = documentOverrides[key]?.[type] ?? 'VERIFIED';
      if (status === 'MISSING') continue;

      const id = `6c1f0a2e-0002-4000-8000-${String(n).padStart(12, '0')}`;
      const storageKey = `documents/${employeeId}/${id}.pdf`;
      const pdf = demoPdf(docLabels[type], documentLines(type, e, n));
      await mkdir(path.join(storageRoot, path.dirname(storageKey)), { recursive: true });
      await writeFile(path.join(storageRoot, storageKey), pdf);

      const uploadedAt = new Date(date(e.joiningDate).getTime() - 7 * 86_400_000 + 4.5 * 3_600_000);
      const reviewed = status !== 'PENDING';
      const data = {
        employeeId,
        type,
        fileName: `${docLabels[type].split(' (')[0].replace(/ /g, '_')}_${e.firstName}_${e.lastName}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: pdf.length,
        storageKey,
        status,
        uploadedById: hr,
        uploadedAt,
        // Nobody reviews their own documents: HR's own are reviewed by the admin.
        reviewedById: reviewed ? (key === 'lakshmi.pillai' ? admin : hr) : null,
        reviewedAt: reviewed ? new Date(uploadedAt.getTime() + 86_400_000) : null,
        reviewNote:
          status === 'FLAGGED'
            ? `Account holder name "${e.firstName} S." doesn't match the employee record "${name}".`
            : null,
      };
      await prisma.document.upsert({ where: { id }, update: data, create: { id, ...data } });
    }
  }
  return prisma.document.count();
}

function documentLines(type: DocumentType, e: SeedEmployee, n: number): string[] {
  const name = `${e.firstName} ${e.lastName}`;
  const pan = `${e.lastName.slice(0, 3).toUpperCase()}P${e.firstName[0]}${String(1000 + n)}${e.lastName[0]}`;
  switch (type) {
    case 'OFFER_LETTER':
      return [`Candidate: ${name}`, `Position: ${e.jobTitle}`, `Location: ${e.location}`, `Date of joining: ${e.joiningDate}`];
    case 'ID_PROOF':
      return [`Name: ${name}`, `Date of birth: ${e.dateOfBirth}`, `ID number: XXXX XXXX ${String(4000 + n)}`];
    case 'PAN_CARD':
      return [`Name: ${name}`, `Date of birth: ${e.dateOfBirth}`, `PAN: ${pan}`];
    case 'BANK_DETAILS': {
      const holder = documentOverrides[localPart(emailFor(e))]?.BANK_DETAILS === 'FLAGGED' ? `${e.firstName} S.` : name;
      return [`Account holder: ${holder}`, `Account number: 50100${String(n).padStart(7, '0')}`, 'IFSC: HDFC0001234', 'Bank: HDFC Bank'];
    }
    default:
      return [`Name: ${name}`];
  }
}

/** Minimal single-page PDF with Helvetica text; clearly marked as demo data. */
function demoPdf(title: string, lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[\\()]/g, (m) => `\\${m}`);
  const body = [
    `BT /F1 20 Tf 72 720 Td (${esc(title)}) Tj ET`,
    ...lines.map((l, i) => `BT /F1 12 Tf 72 ${680 - i * 20} Td (${esc(l)}) Tj ET`),
    'BT /F1 9 Tf 72 60 Td (DEMO DATA - NOT A REAL DOCUMENT) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
