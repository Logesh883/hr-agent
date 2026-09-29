import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  DOCUMENT_UPLOAD_RULES,
  documentSearchSchema,
  flagDocumentSchema,
  uploadDocumentSchema,
  verifyDocumentSchema,
  type DocumentSearchQuery,
  type DocumentType,
  type EmployeeDocument,
  type FlagDocumentBody,
  type Paginated,
  type VerifyDocumentBody,
} from '@hr/contracts';
import type { Response } from 'express';
import { CurrentUser, RequirePermission } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth.types.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DocumentsService, type UploadedFile as StoredUpload } from './documents.service.js';

@Controller()
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get('documents')
  @RequirePermission('document:read')
  search(
    @Query(new ZodValidationPipe(documentSearchSchema)) query: DocumentSearchQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<Paginated<EmployeeDocument>> {
    return this.documents.search(user, query);
  }

  @Get('employees/:id/documents')
  @RequirePermission('document:read')
  forEmployee(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeDocument[]> {
    return this.documents.forEmployee(user, id);
  }

  @Post('employees/:id/documents')
  @RequirePermission('document:upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: DOCUMENT_UPLOAD_RULES.maxBytes, files: 1 } }),
  )
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file: StoredUpload | undefined,
    @Body(new ZodValidationPipe(uploadDocumentSchema)) body: { type: DocumentType },
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeDocument> {
    return this.documents.upload(user, id, body.type, file);
  }

  @Get('documents/:id')
  @RequirePermission('document:read')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeDocument> {
    return this.documents.get(user, id);
  }

  @Get('documents/:id/file')
  @RequirePermission('document:read')
  async file(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { doc, data } = await this.documents.readFile(user, id);
    res.set({
      'Content-Type': doc.mimeType,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(doc.fileName)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    return new StreamableFile(data);
  }

  @Post('documents/:id/verify')
  @HttpCode(200)
  @RequirePermission('document:verify')
  verify(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(verifyDocumentSchema)) body: VerifyDocumentBody,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeDocument> {
    return this.documents.review(user, id, 'VERIFIED', body.note);
  }

  @Post('documents/:id/flag')
  @HttpCode(200)
  @RequirePermission('document:verify')
  flag(
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(flagDocumentSchema)) body: FlagDocumentBody,
    @CurrentUser() user: AuthUser,
  ): Promise<EmployeeDocument> {
    return this.documents.review(user, id, 'FLAGGED', body.note);
  }
}
