import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  AttendanceDay,
  PayrollChange,
  PayrollFlag,
  PayrollReport,
  PayrollRow,
} from '@hr/contracts';
import { AttendanceService } from '../attendance/attendance.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { addDays, fromIsoDate, monthRange, toIsoDate, todayIso } from '../common/dates.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { payrollCounts, toCsv } from './payroll-rules.js';

/** Employee fields whose changes matter to payroll. */
const PAYROLL_FIELDS: Record<string, string> = {
  jobTitle: 'Job title',
  departmentId: 'Department',
  employmentType: 'Employment type',
  status: 'Status',
};

@Injectable()
export class PayrollService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly attendance: AttendanceService,
  ) {}

  /** Payroll inputs and blockers for a month. Payroll-wide, so HR-only. */
  async preparation(user: AuthUser, month: string): Promise<PayrollReport> {
    const { start, end } = monthRange(month);
    const today = todayIso();
    if (start > today) throw new BadRequestException("That month hasn't started yet.");
    // Today isn't over, so the current month is reported up to yesterday.
    const through = end < today ? end : addDays(today, -1);
    const complete = end < today;

    const { days } = await this.attendance.dayGrid(user, start, end);
    const byEmployee = new Map<string, AttendanceDay[]>();
    for (const d of days) byEmployee.set(d.employee.id, [...(byEmployee.get(d.employee.id) ?? []), d]);
    const ids = [...byEmployee.keys()];

    const [employees, documents, pendingLeave, pendingCorrections, departments] = await Promise.all([
      this.prisma.employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, joiningDate: true, employmentType: true, department: { select: { name: true } } },
      }),
      this.prisma.document.findMany({
        where: { employeeId: { in: ids }, type: { in: ['BANK_DETAILS', 'PAN_CARD'] } },
        select: { employeeId: true, type: true, status: true, reviewNote: true },
        orderBy: { uploadedAt: 'desc' },
      }),
      this.prisma.leaveRequest.findMany({
        where: {
          employeeId: { in: ids },
          status: 'PENDING',
          startDate: { lte: fromIsoDate(end) },
          endDate: { gte: fromIsoDate(start) },
        },
        select: { employeeId: true },
      }),
      this.prisma.attendanceCorrection.findMany({
        where: { employeeId: { in: ids }, status: 'PENDING', date: { gte: fromIsoDate(start), lte: fromIsoDate(end) } },
        select: { employeeId: true },
      }),
      this.prisma.department.findMany({ select: { id: true, name: true } }),
    ]);
    const employeeInfo = new Map(employees.map((e) => [e.id, e]));

    const rows: PayrollRow[] = [...byEmployee.entries()].map(([id, employeeDays]) => {
      const info = employeeInfo.get(id)!;
      const joiningDate = toIsoDate(info.joiningDate);
      const counts = payrollCounts(employeeDays, through);
      const latest = (type: 'BANK_DETAILS' | 'PAN_CARD') =>
        documents.find((d) => d.employeeId === id && d.type === type);
      const flags: PayrollFlag[] = [];

      const bank = latest('BANK_DETAILS');
      if (!bank || bank.status === 'PENDING') {
        flags.push({
          code: 'MISSING_BANK_DETAILS',
          message: bank ? 'Bank details uploaded but not verified yet.' : 'No bank details on file.',
        });
      } else if (bank.status === 'FLAGGED') {
        flags.push({ code: 'BANK_DETAILS_FLAGGED', message: `Bank details flagged: ${bank.reviewNote ?? 'needs a corrected upload'}` });
      }
      const pan = latest('PAN_CARD');
      if (pan?.status !== 'VERIFIED') {
        flags.push({ code: 'MISSING_PAN', message: pan ? 'PAN card not verified yet.' : 'No PAN card on file.' });
      }
      if (counts.unexplainedDays > 0) {
        flags.push({
          code: 'UNRESOLVED_ATTENDANCE',
          message: `${counts.unexplainedDays} working day${counts.unexplainedDays === 1 ? '' : 's'} with no attendance or leave (counted as loss of pay).`,
        });
      }
      const leaveCount = pendingLeave.filter((l) => l.employeeId === id).length;
      if (leaveCount) {
        flags.push({ code: 'PENDING_LEAVE', message: `${leaveCount} leave request${leaveCount === 1 ? '' : 's'} in this month still awaiting approval.` });
      }
      const correctionCount = pendingCorrections.filter((c) => c.employeeId === id).length;
      if (correctionCount) {
        flags.push({ code: 'PENDING_CORRECTION', message: `${correctionCount} attendance correction${correctionCount === 1 ? '' : 's'} awaiting approval.` });
      }

      return {
        employee: employeeDays[0].employee,
        department: info.department?.name ?? null,
        employmentType: info.employmentType,
        joiningDate,
        newJoiner: joiningDate >= start && joiningDate <= end,
        ...counts,
        flags,
      };
    });

    const changes = await this.changes(start, end, rows, new Map(departments.map((d) => [d.id, d.name])));
    return {
      month,
      through,
      complete,
      summary: {
        headcount: rows.length,
        newJoiners: rows.filter((r) => r.newJoiner).length,
        exits: changes.filter((c) => c.kind === 'EXITED').length,
        employeesWithFlags: rows.filter((r) => r.flags.length).length,
        lopDays: rows.reduce((sum, r) => sum + r.lopDays, 0),
      },
      rows,
      changes,
    };
  }

  async preparationCsv(user: AuthUser, month: string): Promise<string> {
    const report = await this.preparation(user, month);
    return toCsv([
      [
        'Employee code', 'Name', 'Department', 'Employment type', 'Joining date', 'New joiner',
        'Working days', 'Days worked', 'Paid leave', 'Unpaid leave', 'Unexplained days',
        'LOP days', 'Payable days', 'Flags',
      ],
      ...report.rows.map((r) => [
        r.employee.employeeCode,
        `${r.employee.firstName} ${r.employee.lastName}`,
        r.department,
        r.employmentType,
        r.joiningDate,
        r.newJoiner ? 'Yes' : 'No',
        r.workingDays,
        r.daysWorked,
        r.paidLeaveDays,
        r.unpaidLeaveDays,
        r.unexplainedDays,
        r.lopDays,
        r.payableDays,
        r.flags.map((f) => f.message).join(' | '),
      ]),
    ]);
  }

  /** Joiners (from joining dates) plus exits and payroll-relevant edits (from the audit log). */
  private async changes(
    start: string,
    end: string,
    rows: PayrollRow[],
    departmentNames: Map<string, string>,
  ): Promise<PayrollChange[]> {
    const changes: PayrollChange[] = rows
      .filter((r) => r.newJoiner)
      .map((r) => ({
        employee: r.employee,
        kind: 'JOINED' as const,
        summary: `Joined as ${r.employmentType.replace('_', '-').toLowerCase()} in ${r.department ?? 'no department'}; prorate from ${r.joiningDate}.`,
        date: r.joiningDate,
        by: null,
      }));

    const logs = await this.prisma.auditLog.findMany({
      where: {
        entityType: 'Employee',
        action: { in: ['employee.updated', 'employee.archived', 'employee.reactivated'] },
        timestamp: { gte: fromIsoDate(start), lt: fromIsoDate(addDays(end, 1)) },
      },
      orderBy: { timestamp: 'asc' },
    });
    if (!logs.length) return changes;

    const [employees, actors] = await Promise.all([
      this.prisma.employee.findMany({
        where: { id: { in: logs.map((l) => l.entityId) } },
        select: employeeRefSelect,
      }),
      this.prisma.user.findMany({
        where: { id: { in: logs.map((l) => l.actorId).filter((id) => id !== null) } },
        select: { id: true, name: true },
      }),
    ]);
    const display = (field: string, value: unknown): string => {
      if (value === null || value === undefined) return '—';
      if (typeof value !== 'string' && typeof value !== 'number') return JSON.stringify(value);
      return field === 'departmentId' ? (departmentNames.get(String(value)) ?? 'unknown') : String(value);
    };

    for (const log of logs) {
      const employee = employees.find((e) => e.id === log.entityId);
      if (!employee) continue;
      const by = actors.find((a) => a.id === log.actorId) ?? null;
      const date = toIsoDate(log.timestamp);
      if (log.action === 'employee.archived') {
        changes.push({ employee, kind: 'EXITED', summary: 'Archived: include in full and final settlement.', date, by });
        continue;
      }
      const before = (log.before ?? {}) as Record<string, unknown>;
      const after = (log.after ?? {}) as Record<string, unknown>;
      const parts = Object.keys(after)
        .filter((field) => field in PAYROLL_FIELDS)
        .map((field) => `${PAYROLL_FIELDS[field]}: ${display(field, before[field])} → ${display(field, after[field])}`);
      if (parts.length) changes.push({ employee, kind: 'CHANGED', summary: parts.join('; '), date, by });
    }
    return changes.sort((a, b) => a.date.localeCompare(b.date));
  }
}
