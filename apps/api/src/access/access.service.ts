import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import bcrypt from 'bcryptjs';
import {
  grantableRoles,
  type EmployeeAccess,
  type GrantAccessBody,
  type Role,
  type TemporaryPasswordResponse,
  type UpdateAccessBody,
} from '@hr/contracts';
import type { User } from '@hr/db';
import { AuditService } from '../audit/audit.service.js';
import { BCRYPT_ROUNDS } from '../auth/auth.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { generateTemporaryPassword } from './temporary-password.js';

const roleNames: Record<Role, string> = {
  ADMIN: 'Admin',
  HR_OPS: 'HR Operations',
  MANAGER: 'Manager',
  EMPLOYEE: 'Employee',
};

/**
 * App logins for employees. The login email is always the employee's work
 * email; passwords are only ever generated (temporary) or chosen by the user.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(actor: AuthUser, employeeId: string): Promise<EmployeeAccess> {
    const { employee, login } = await this.load(employeeId);
    return this.toDto(actor, employee, login);
  }

  async grant(actor: AuthUser, employeeId: string, body: GrantAccessBody): Promise<TemporaryPasswordResponse> {
    const { employee, login } = await this.load(employeeId);
    this.assertNotSelf(actor, employeeId);
    this.assertGrantable(actor, body.role);
    if (login) throw new ConflictException(`${employee.firstName} already has a login. Reset the password instead.`);
    if (employee.status === 'ARCHIVED') {
      throw new BadRequestException("Archived employees can't be given access. Reactivate them first.");
    }
    const clash = await this.prisma.user.findUnique({ where: { email: employee.email } });
    if (clash) throw new ConflictException(`Another login already uses ${employee.email}.`);

    const temporaryPassword = generateTemporaryPassword();
    const created = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: employee.email,
          name: `${employee.firstName} ${employee.lastName}`,
          role: body.role,
          employeeId,
          passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'access.granted',
        entityType: 'Employee',
        entityId: employeeId,
        after: { login: employee.email, role: body.role },
      });
      return user;
    });
    return { access: this.toDto(actor, employee, created), temporaryPassword };
  }

  async update(actor: AuthUser, employeeId: string, body: UpdateAccessBody): Promise<EmployeeAccess> {
    const { employee, login } = await this.load(employeeId);
    this.assertNotSelf(actor, employeeId);
    if (!login) throw new NotFoundException(`${employee.firstName} doesn't have a login yet.`);
    this.assertCanManage(actor, login);
    if (body.role) this.assertGrantable(actor, body.role);
    if (body.isActive && employee.status === 'ARCHIVED') {
      throw new BadRequestException("Archived employees can't sign in. Reactivate the employee first.");
    }

    const data = {
      ...(body.role !== undefined && body.role !== login.role && { role: body.role }),
      ...(body.isActive !== undefined && body.isActive !== login.isActive && { isActive: body.isActive }),
    };
    if (!Object.keys(data).length) return this.toDto(actor, employee, login);

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: login.id }, data });
      await this.audit.record(tx, {
        actor,
        action: 'access.updated',
        entityType: 'Employee',
        entityId: employeeId,
        before: Object.fromEntries(Object.keys(data).map((k) => [k, login[k as keyof typeof data]])),
        after: data,
      });
      return user;
    });
    return this.toDto(actor, employee, updated);
  }

  /** Issues a new temporary password; the old one and any open sessions stop working. */
  async resetPassword(actor: AuthUser, employeeId: string): Promise<TemporaryPasswordResponse> {
    const { employee, login } = await this.load(employeeId);
    this.assertNotSelf(actor, employeeId);
    if (!login) throw new NotFoundException(`${employee.firstName} doesn't have a login yet.`);
    this.assertCanManage(actor, login);

    const temporaryPassword = generateTemporaryPassword();
    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: login.id },
        data: {
          passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_ROUNDS),
          mustChangePassword: true,
          passwordChangedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        actor,
        action: 'access.password_reset',
        entityType: 'Employee',
        entityId: employeeId,
      });
      return user;
    });
    return { access: this.toDto(actor, employee, updated), temporaryPassword };
  }

  private async load(employeeId: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, email: true, firstName: true, lastName: true, status: true, user: true },
    });
    if (!employee) throw new NotFoundException('Employee not found');
    return { employee, login: employee.user };
  }

  private assertNotSelf(actor: AuthUser, employeeId: string) {
    if (actor.employeeId === employeeId) {
      throw new ForbiddenException("You can't change your own access. Ask another HR admin.");
    }
  }

  private assertGrantable(actor: AuthUser, role: Role) {
    if (!grantableRoles(actor.role).includes(role)) {
      throw new ForbiddenException(`Only an admin can grant the ${roleNames[role]} role.`);
    }
  }

  private assertCanManage(actor: AuthUser, login: User) {
    if (!grantableRoles(actor.role).includes(login.role)) {
      throw new ForbiddenException(`Only an admin can change a ${roleNames[login.role]} login.`);
    }
  }

  private toDto(
    actor: AuthUser,
    employee: { id: string; email: string },
    login: User | null,
  ): EmployeeAccess {
    const grantable = grantableRoles(actor.role);
    return {
      hasAccess: !!login,
      email: login?.email ?? employee.email,
      role: login?.role ?? null,
      isActive: login?.isActive ?? false,
      mustChangePassword: login?.mustChangePassword ?? false,
      lastLoginAt: login?.lastLoginAt?.toISOString() ?? null,
      grantedAt: login?.createdAt.toISOString() ?? null,
      canManage: actor.employeeId !== employee.id && (!login || grantable.includes(login.role)),
      grantableRoles: grantable,
    };
  }
}
