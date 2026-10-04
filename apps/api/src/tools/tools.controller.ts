import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import {
  RISK_POLICY,
  TOOLS,
  TOOL_NAMES,
  roleHasPermission,
  type RiskLevel,
  type ToolCatalogEntry,
  type ToolInput,
  type ToolName,
} from '@hr/contracts';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { setCurrentToolName } from '../common/agent-context.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ToolsService } from './tools.service.js';

const jsonSchema = (schema: z.ZodType, io: 'input' | 'output') => {
  const { $schema: _, ...rest } = z.toJSONSchema(schema, {
    io,
    unrepresentable: 'any',
  });
  return rest;
};

/** Built once: the schemas don't change while the process runs. */
const CATALOG = TOOL_NAMES.map((name) => {
  const tool = TOOLS[name];
  const rule = (RISK_POLICY.tools as Record<string, { default: RiskLevel }>)[
    name
  ];
  return {
    name,
    description: tool.description,
    kind: tool.kind,
    permission: tool.permission,
    risk: tool.kind === 'write' ? (rule?.default ?? RISK_POLICY.default) : null,
    input: jsonSchema(tool.input, 'input'),
    output: jsonSchema(tool.output, 'output'),
  };
});

/**
 * T3.3: the Tool API.
 *
 *   GET  /tools          the catalog, with JSON Schemas, and whether the caller may use each
 *   POST /tools/:name    run one tool: body = its input, response = its output (200)
 *
 * Callers authenticate as themselves; the AI agent forwards the signed-in user's token
 * (T3.4), so the user's role and data scope apply. `Idempotency-Key` works as on any write
 * (T3.5), and every change is audited with the tool's name; with `X-Agent-Run-Id` it's
 * marked `AI` (T3.6).
 */
@Controller('tools')
export class ToolsController {
  constructor(private readonly tools: ToolsService) {}

  @Get()
  catalog(@CurrentUser() user: AuthUser): ToolCatalogEntry[] {
    return CATALOG.map((entry) => ({
      ...entry,
      allowed: roleHasPermission(user.role, entry.permission),
    }));
  }

  @Post(':name')
  @HttpCode(200)
  run(
    @Param('name') name: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthUser,
  ): Promise<unknown> {
    const tool = this.tools.definition(name);
    if (!roleHasPermission(user.role, tool.permission)) {
      throw new ForbiddenException(
        `Your role (${user.role}) lacks permission: ${tool.permission}`,
      );
    }
    const input = new ZodValidationPipe(tool.input).transform(body ?? {});
    setCurrentToolName(tool.name);
    return this.tools.run(
      tool.name as ToolName,
      user,
      input as ToolInput<ToolName>,
    );
  }
}
