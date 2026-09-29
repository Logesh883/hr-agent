import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  POLICY_UPLOAD_RULES,
  publishPolicySchema,
  type Policy,
  type PolicyVersion,
  type PublishPolicyBody,
} from '@hr/contracts';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { UploadedFile as StoredUpload } from '../documents/documents.service.js';
import { PoliciesService } from './policies.service.js';

@Controller('policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @Get()
  @RequirePermission('policy:read')
  list(): Promise<Policy[]> {
    return this.policies.list();
  }

  @Post()
  @RequirePermission('policy:manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: POLICY_UPLOAD_RULES.maxBytes, files: 1 } }))
  publish(
    @UploadedFile() file: StoredUpload | undefined,
    @Body(new ZodValidationPipe(publishPolicySchema)) body: PublishPolicyBody,
    @CurrentUser() user: AuthUser,
  ): Promise<PolicyVersion> {
    return this.policies.publish(user, body, file);
  }

  @Get(':id/file')
  @RequirePermission('policy:read')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { doc, data } = await this.policies.readFile(id);
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(data);
  }
}
