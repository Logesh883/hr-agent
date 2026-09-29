import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DOCUMENT_TYPE_LABELS,
  documentLabelInSentence,
  REQUIRED_DOCUMENT_TYPES,
  roleHasPermission,
  type DocumentType,
  type EmployeeOnboarding,
  type MissingInfo,
  type OnboardingProgress,
  type OnboardingSearchQuery,
  type OnboardingSummary,
  type OnboardingTask,
  type Paginated,
  type UpdateOnboardingTaskBody,
} from '@hr/contracts';
import type { Prisma } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { addDays, fromIsoDate, toIsoDate, todayIso } from '../common/dates.js';
import { assertEmployeeInScope, employeeScope } from '../common/scope.js';
import { DocumentsService } from '../documents/documents.service.js';
import { employeeRefSelect } from '../employees/employee.mapper.js';
import { PrismaService, type Tx } from '../prisma/prisma.service.js';

const taskInclude = {
  completedBy: { select: { id: true, name: true } },
} satisfies Prisma.OnboardingTaskInclude;

type TaskRow = Prisma.OnboardingTaskGetPayload<{ include: typeof taskInclude }>;

const employeeSelect = {
  ...employeeRefSelect,
  jobTitle: true,
  joiningDate: true,
  status: true,
  phone: true,
  dateOfBirth: true,
  managerId: true,
  departmentId: true,
  department: { select: { name: true } },
} satisfies Prisma.EmployeeSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{ select: typeof employeeSelect }>;

@Injectable()
export class OnboardingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: DocumentsService,
  ) {}

  onModuleInit() {
    // Verifying a required document completes the matching onboarding task.
    this.documents.onVerified((tx, doc, actor) => this.completeDocumentTasks(tx, doc.employeeId, doc.type, actor));
  }

  async list(user: AuthUser, query: OnboardingSearchQuery): Promise<Paginated<OnboardingSummary>> {
    const employees = await this.prisma.employee.findMany({
      where: { AND: [employeeScope(user, 'team') ?? {}, { onboardingTasks: { some: {} } }] },
      select: { ...employeeSelect, onboardingTasks: { include: taskInclude } },
      orderBy: { joiningDate: 'desc' },
    });
    const documents = await this.requiredDocuments(employees.map((e) => e.id));
    const today = todayIso();

    // Demo scale: summarise in memory, then filter and paginate.
    const summaries = employees
      .map((e) => {
        const progress = progressOf(e.onboardingTasks, today);
        const next = e.onboardingTasks
          .filter((t) => t.status === 'PENDING')
          .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.sortOrder - b.sortOrder)
          .at(0);
        return {
          employee: employeeHeader(e),
          progress,
          nextTask: next
            ? { title: next.title, dueDate: toIsoDate(next.dueDate), isOverdue: toIsoDate(next.dueDate) < today }
            : null,
          missingInfoCount: missingInfoFor(e, documents.get(e.id) ?? []).length,
        } satisfies OnboardingSummary;
      })
      .filter((s) => {
        const complete = s.progress.percent === 100;
        return query.state === 'all' || (query.state === 'completed' ? complete : !complete);
      });

    const start = (query.page - 1) * query.pageSize;
    return {
      items: summaries.slice(start, start + query.pageSize),
      total: summaries.length,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async forEmployee(user: AuthUser, employeeId: string): Promise<EmployeeOnboarding> {
    await assertEmployeeInScope(this.prisma, user, employeeId, 'team');
    const employee = await this.prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: employeeSelect,
    });
    const tasks = await this.prisma.onboardingTask.findMany({
      where: { employeeId },
      include: taskInclude,
      orderBy: [{ dueDate: 'asc' }, { sortOrder: 'asc' }],
    });
    const documents = await this.requiredDocuments([employeeId]);
    const today = todayIso();

    return {
      employee: employeeHeader(employee),
      started: tasks.length > 0,
      tasks: tasks.map((t) => this.toDto(t, employee, user, today)),
      progress: progressOf(tasks, today),
      missingInfo: missingInfoFor(employee, documents.get(employeeId) ?? []),
      canStart:
        tasks.length === 0 &&
        employee.status !== 'ARCHIVED' &&
        roleHasPermission(user.role, 'onboarding:manage'),
    };
  }

  /** Creates the checklist from company-wide and department templates. */
  async start(user: AuthUser, employeeId: string): Promise<EmployeeOnboarding> {
    await this.prisma.$transaction(async (tx) => {
      const employee = await tx.employee.findUnique({ where: { id: employeeId }, select: employeeSelect });
      if (!employee) throw new NotFoundException('Employee not found');
      if (employee.status === 'ARCHIVED') {
        throw new BadRequestException("Archived employees can't be onboarded.");
      }
      if (await tx.onboardingTask.count({ where: { employeeId } })) {
        throw new ConflictException('Onboarding has already started for this employee.');
      }

      const [templates, verified] = await Promise.all([
        tx.onboardingTemplateTask.findMany({
          where: { OR: [{ departmentId: null }, { departmentId: employee.departmentId }] },
          orderBy: { sortOrder: 'asc' },
        }),
        tx.document.findMany({
          where: { employeeId, status: 'VERIFIED' },
          select: { type: true },
        }),
      ]);
      if (templates.length === 0) {
        throw new BadRequestException('No onboarding templates are configured.');
      }
      const verifiedTypes = new Set(verified.map((d) => d.type));
      const joining = toIsoDate(employee.joiningDate);
      const now = new Date();

      await tx.onboardingTask.createMany({
        data: templates.map((t) => {
          const alreadyVerified = !!t.requiredDocumentType && verifiedTypes.has(t.requiredDocumentType);
          return {
            employeeId,
            templateTaskId: t.id,
            title: t.title,
            description: t.description,
            category: t.category,
            assignee: t.assignee,
            dueDate: fromIsoDate(addDays(joining, t.dueOffsetDays)),
            requiredDocumentType: t.requiredDocumentType,
            sortOrder: t.sortOrder,
            ...(alreadyVerified && {
              status: 'DONE' as const,
              completedAt: now,
              completedById: user.id,
              notes: 'Completed automatically: the document was already verified.',
            }),
          };
        }),
      });
      await this.audit.record(tx, {
        actor: user,
        action: 'onboarding.started',
        entityType: 'Employee',
        entityId: employeeId,
        after: { tasks: templates.length, alreadyComplete: templates.filter((t) => t.requiredDocumentType && verifiedTypes.has(t.requiredDocumentType)).length },
      });
    });
    return this.forEmployee(user, employeeId);
  }

  async updateTask(user: AuthUser, taskId: string, body: UpdateOnboardingTaskBody): Promise<OnboardingTask> {
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.onboardingTask.findFirst({
        where: { id: taskId, employee: employeeScope(user, 'team') },
        include: { ...taskInclude, employee: { select: employeeSelect } },
      });
      if (!task) throw new NotFoundException('Onboarding task not found');

      const isHr = roleHasPermission(user.role, 'onboarding:manage');
      if (!canUpdate(user, task, task.employee)) {
        throw new ForbiddenException('Only HR or the person this task is assigned to can update it.');
      }
      if (!isHr && body.dueDate) {
        throw new ForbiddenException('Only HR can change due dates.');
      }
      if (body.status === 'SKIPPED' && !isHr) {
        throw new ForbiddenException('Only HR can skip onboarding tasks.');
      }
      if (body.status === 'DONE' && task.requiredDocumentType && task.status !== 'DONE') {
        throw new BadRequestException(
          `This task completes automatically when the ${documentLabelInSentence(task.requiredDocumentType)} is verified.`,
        );
      }
      if (body.status === 'SKIPPED' && !body.notes?.trim()) {
        throw new BadRequestException('Add a note explaining why the task is skipped.');
      }

      const statusChanged = body.status !== undefined && body.status !== task.status;
      const row = await tx.onboardingTask.update({
        where: { id: taskId },
        data: {
          ...(body.notes !== undefined && { notes: body.notes || null }),
          ...(body.dueDate && { dueDate: fromIsoDate(body.dueDate) }),
          ...(statusChanged && {
            status: body.status,
            completedAt: body.status === 'PENDING' ? null : new Date(),
            completedById: body.status === 'PENDING' ? null : user.id,
          }),
        },
        include: taskInclude,
      });

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      if (statusChanged) {
        before.status = task.status;
        after.status = row.status;
      }
      if (body.dueDate && body.dueDate !== toIsoDate(task.dueDate)) {
        before.dueDate = toIsoDate(task.dueDate);
        after.dueDate = body.dueDate;
      }
      if (body.notes !== undefined && (body.notes || null) !== task.notes) {
        before.notes = task.notes;
        after.notes = row.notes;
      }
      if (Object.keys(after).length) {
        await this.audit.record(tx, {
          actor: user,
          action: 'onboarding.task_updated',
          entityType: 'OnboardingTask',
          entityId: taskId,
          before: { title: task.title, ...before },
          after,
        });
      }
      return this.toDto(row, task.employee, user, todayIso());
    });
  }

  private async completeDocumentTasks(tx: Tx, employeeId: string, type: DocumentType, actor: AuthUser) {
    const tasks = await tx.onboardingTask.findMany({
      where: { employeeId, requiredDocumentType: type, status: 'PENDING' },
    });
    for (const task of tasks) {
      await tx.onboardingTask.update({
        where: { id: task.id },
        data: {
          status: 'DONE',
          completedAt: new Date(),
          completedById: actor.id,
          notes: `Completed automatically when the ${documentLabelInSentence(type)} was verified.`,
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'onboarding.task_updated',
        entityType: 'OnboardingTask',
        entityId: task.id,
        before: { title: task.title, status: 'PENDING' },
        after: { status: 'DONE', automatic: true },
      });
    }
  }

  /** Latest document per required type, per employee. */
  private async requiredDocuments(employeeIds: string[]) {
    const docs = await this.prisma.document.findMany({
      where: { employeeId: { in: employeeIds }, type: { in: [...REQUIRED_DOCUMENT_TYPES] } },
      select: { employeeId: true, type: true, status: true, reviewNote: true, uploadedAt: true },
      orderBy: { uploadedAt: 'desc' },
    });
    const byEmployee = new Map<string, typeof docs>();
    for (const d of docs) {
      const list = byEmployee.get(d.employeeId) ?? [];
      if (!list.some((x) => x.type === d.type)) list.push(d);
      byEmployee.set(d.employeeId, list);
    }
    return byEmployee;
  }

  private toDto(row: TaskRow, employee: EmployeeRow, user: AuthUser, today: string): OnboardingTask {
    const dueDate = toIsoDate(row.dueDate);
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      category: row.category,
      assignee: row.assignee,
      dueDate,
      status: row.status,
      requiredDocumentType: row.requiredDocumentType,
      completedAt: row.completedAt?.toISOString() ?? null,
      completedBy: row.completedBy,
      notes: row.notes,
      isOverdue: row.status === 'PENDING' && dueDate < today,
      canUpdate: canUpdate(user, row, employee),
    };
  }
}

function canUpdate(
  user: AuthUser,
  task: { assignee: string },
  employee: { id: string; managerId: string | null },
): boolean {
  if (roleHasPermission(user.role, 'onboarding:manage')) return true;
  if (!user.employeeId) return false;
  return (
    (task.assignee === 'MANAGER' && employee.managerId === user.employeeId) ||
    (task.assignee === 'EMPLOYEE' && employee.id === user.employeeId)
  );
}

function progressOf(
  tasks: { status: string; dueDate: Date }[],
  today: string,
): OnboardingProgress {
  const done = tasks.filter((t) => t.status === 'DONE').length;
  const skipped = tasks.filter((t) => t.status === 'SKIPPED').length;
  const overdue = tasks.filter((t) => t.status === 'PENDING' && toIsoDate(t.dueDate) < today).length;
  return {
    total: tasks.length,
    done,
    skipped,
    overdue,
    percent: tasks.length ? Math.round(((done + skipped) / tasks.length) * 100) : 0,
  };
}

function employeeHeader(e: EmployeeRow) {
  return {
    id: e.id,
    employeeCode: e.employeeCode,
    firstName: e.firstName,
    lastName: e.lastName,
    jobTitle: e.jobTitle,
    joiningDate: toIsoDate(e.joiningDate),
    departmentName: e.department?.name ?? null,
  };
}

/** Deterministic checks for gaps in the employee record and required documents. */
function missingInfoFor(
  employee: EmployeeRow,
  documents: { type: DocumentType; status: string; reviewNote: string | null }[],
): MissingInfo[] {
  const missing: MissingInfo[] = [];
  if (!employee.phone) missing.push({ code: 'PHONE', message: 'Phone number is missing.' });
  if (!employee.dateOfBirth) missing.push({ code: 'DATE_OF_BIRTH', message: 'Date of birth is missing.' });
  if (!employee.managerId) missing.push({ code: 'MANAGER', message: 'No reporting manager assigned.' });

  for (const type of REQUIRED_DOCUMENT_TYPES) {
    const label = DOCUMENT_TYPE_LABELS[type];
    const doc = documents.find((d) => d.type === type);
    if (!doc) missing.push({ code: `DOC_${type}`, message: `${label} not uploaded.` });
    else if (doc.status === 'PENDING') missing.push({ code: `DOC_${type}`, message: `${label} uploaded but not verified yet.` });
    else if (doc.status === 'FLAGGED') {
      missing.push({ code: `DOC_${type}`, message: `${label} flagged: ${doc.reviewNote ?? 'needs a corrected upload'}` });
    }
  }
  return missing;
}
