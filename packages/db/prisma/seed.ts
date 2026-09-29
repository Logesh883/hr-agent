/**
 * Demo seed: 4 departments, 20 employees, one login per role, a holiday
 * calendar, and leave requests in every status.
 * Idempotent — safe to re-run; records are upserted by their unique keys.
 *
 * Priya is intentionally absent: "Onboard Priya…" is the headline AI demo.
 */
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { config as loadEnv } from 'dotenv';
import {
  createPrismaClient,
  type EmployeeStatus,
  type EmploymentType,
  type LeaveStatus,
  type LeaveType,
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

  console.log(
    `Seeded ${departments.length} departments, ${employees.length} employees, ${users.length} users, ` +
      `${holidays.length} holidays, ${leaveRequests.length} leave requests.`,
  );
  console.log(`Demo logins (password "${DEMO_PASSWORD}"): ${users.map((u) => u.email).join(', ')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
