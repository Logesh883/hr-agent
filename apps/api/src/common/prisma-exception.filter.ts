import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@hr/db';
import type { ApiError } from '@hr/contracts';
import type { Response } from 'express';

/** Maps Prisma errors that slip past service-level checks to HTTP errors. */
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(error: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const body = toApiError(error);
    res.status(body.statusCode).json(body);
  }
}

function toApiError(error: Prisma.PrismaClientKnownRequestError): ApiError {
  switch (error.code) {
    case 'P2002': {
      const fields = uniqueFields(error);
      return {
        statusCode: HttpStatus.CONFLICT,
        message: fields.length
          ? `A record with this ${fields.join(', ')} already exists`
          : 'A record with these values already exists',
      };
    }
    case 'P2003':
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'A referenced record does not exist',
      };
    case 'P2025':
      return { statusCode: HttpStatus.NOT_FOUND, message: 'Record not found' };
    default:
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Database error',
      };
  }
}

/** Unique-constraint fields; location differs between engine and driver adapters. */
function uniqueFields(error: Prisma.PrismaClientKnownRequestError): string[] {
  const meta = error.meta as
    | {
        target?: string[] | string;
        driverAdapterError?: { cause?: { constraint?: { fields?: string[] } } };
      }
    | undefined;
  const target =
    meta?.target ?? meta?.driverAdapterError?.cause?.constraint?.fields;
  if (Array.isArray(target)) return target;
  return typeof target === 'string' ? [target] : [];
}
