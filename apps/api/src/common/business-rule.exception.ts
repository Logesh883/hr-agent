import { UnprocessableEntityException } from '@nestjs/common';
import type { ApiError } from '@hr/contracts';

/**
 * 422 for requests that are well-formed but break a business rule. Each
 * problem is a plain-language reason the caller (or the AI agent) can relay.
 */
export class BusinessRuleException extends UnprocessableEntityException {
  constructor(problems: { code: string; message: string }[]) {
    const body: ApiError = {
      statusCode: 422,
      message: problems.map((p) => p.message).join(' '),
      problems,
    };
    super(body);
  }
}
