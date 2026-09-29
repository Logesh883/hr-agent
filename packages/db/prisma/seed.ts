/**
 * Demo seed: 4 departments, 20 employees, and one login per role.
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

  console.log(
    `Seeded ${departments.length} departments, ${employees.length} employees, ${users.length} users.`,
  );
  console.log(`Demo logins (password "${DEMO_PASSWORD}"): ${users.map((u) => u.email).join(', ')}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
