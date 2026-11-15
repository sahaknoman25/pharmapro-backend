// Shared handler plumbing for all actions.
import { AuthContext } from '../auth';

export interface HandlerCtx {
  auth: AuthContext | null;
}

export type Handler = (ctx: HandlerCtx, body: Record<string, unknown>) => Promise<unknown>;

export interface HandlerDef {
  /** If true, a valid session token is required before the handler runs. */
  auth: boolean;
  /** If set, the caller's role must be one of these (checked after auth). */
  roles?: string[];
  /** If true, the caller must be an SWM platform admin. */
  swm?: boolean;
  handler: Handler;
}
