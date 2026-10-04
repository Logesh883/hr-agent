import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@hr/db';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { from, lastValueFrom, Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const MAX_KEY_LENGTH = 200;

/**
 * `Idempotency-Key` on writes: the first request with a key runs and its response is
 * stored; a retry with the same key gets the stored response (and `Idempotent-Replayed:
 * true`) instead of acting again. Keys are per user.
 *
 * - The same key with a different request (method, path or body) is refused (422): a key
 *   names one intended action.
 * - While the first request is still running, a duplicate gets 409. The row is inserted
 *   *before* the handler runs, under a primary key, so two simultaneous requests can't
 *   both pass.
 * - A 5xx response isn't stored, so it can be retried; 2xx and 4xx are final.
 *
 * Requests without the header behave exactly as before.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<AuthenticatedRequest>();
    const res = http.getResponse<Response>();
    const key = req.header('idempotency-key');
    if (!key || !WRITE_METHODS.has(req.method) || !req.user)
      return next.handle();
    if (key.length > MAX_KEY_LENGTH) {
      throw new UnprocessableEntityException(
        `Idempotency-Key is longer than ${MAX_KEY_LENGTH} characters`,
      );
    }
    // Nest sets the route's status (201 for POST unless @HttpCode says otherwise) after
    // interceptors run, so read it from the route instead of the response.
    const status =
      this.reflector.get<number | undefined>(
        HTTP_CODE_METADATA,
        context.getHandler(),
      ) ?? (req.method === 'POST' ? 201 : 200);
    return from(this.handle(req, res, key, status, next));
  }

  private async handle(
    req: AuthenticatedRequest,
    res: Response,
    key: string,
    status: number,
    next: CallHandler,
  ): Promise<unknown> {
    const userId = req.user.id;
    const path = req.originalUrl.split('?')[0];
    const requestHash = createHash('sha256')
      .update(JSON.stringify([req.method, path, req.body ?? null]))
      .digest('hex');

    try {
      await this.prisma.idempotencyKey.create({
        data: {
          userId,
          key,
          method: req.method,
          path,
          requestHash,
          state: 'IN_PROGRESS',
        },
      });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      )
        throw error;
      return this.replay(userId, key, requestHash, res);
    }

    try {
      const body = await lastValueFrom(next.handle(), {
        defaultValue: undefined,
      });
      await this.complete(userId, key, status, body);
      return body;
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        await this.complete(
          userId,
          key,
          error.getStatus(),
          error.getResponse(),
          true,
        );
      } else {
        // Unknown outcome or server error: forget the key so the client can retry.
        await this.prisma.idempotencyKey.delete({
          where: { userId_key: { userId, key } },
        });
      }
      throw error;
    }
  }

  private async replay(
    userId: string,
    key: string,
    requestHash: string,
    res: Response,
  ): Promise<unknown> {
    const stored = await this.prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!stored || stored.state === 'IN_PROGRESS') {
      throw new ConflictException(
        'A request with this Idempotency-Key is still in progress. Retry shortly.',
      );
    }
    if (stored.requestHash !== requestHash) {
      throw new UnprocessableEntityException(
        'This Idempotency-Key was already used for a different request.',
      );
    }
    const response = stored.response as {
      error?: boolean;
      body: unknown;
    } | null;
    res.setHeader('Idempotent-Replayed', 'true');
    if (response?.error) {
      throw new HttpException(
        response.body as Record<string, unknown>,
        stored.statusCode ?? 400,
      );
    }
    return response?.body;
  }

  private async complete(
    userId: string,
    key: string,
    statusCode: number,
    body: unknown,
    error = false,
  ) {
    await this.prisma.idempotencyKey.update({
      where: { userId_key: { userId, key } },
      data: {
        state: 'COMPLETED',
        statusCode,
        response: { error, body: (body ?? null) as Prisma.InputJsonValue },
      },
    });
  }
}
