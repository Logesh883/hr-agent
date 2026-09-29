import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ApiError } from '@hr/contracts';
import type { z } from 'zod';

/**
 * Validates and transforms a request part with a schema from @hr/contracts.
 * Usage: `@Body(new ZodValidationPipe(createEmployeeSchema)) body: …`
 */
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const body: ApiError = {
        statusCode: 400,
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
      throw new BadRequestException(body);
    }
    return result.data;
  }
}
