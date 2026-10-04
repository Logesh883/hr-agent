import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Calls made by the AI agent carry `X-Agent-Run-Id: <ai.workflow_run id>`. The agent acts
 * with the signed-in user's own token, so permissions don't change; the header only labels
 * the audit trail: entries become `actorType: AI` with the run id, still attributed to the
 * user the agent acted for.
 */
interface AgentContext {
  agentRunId: string | null;
}

const storage = new AsyncLocalStorage<AgentContext>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The agent run behind the current request, if any. */
export function currentAgentRunId(): string | null {
  return storage.getStore()?.agentRunId ?? null;
}

@Injectable()
export class AgentContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const header = req.header('x-agent-run-id');
    // A malformed id is ignored rather than refused: it's a label, not a credential.
    const agentRunId =
      header && UUID.test(header) ? header.toLowerCase() : null;
    storage.run({ agentRunId }, next);
  }
}
