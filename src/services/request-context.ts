import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the MCP request that is running a tool offers the HTTP client: a way to learn the caller gave
 * up, and a way to tell the caller the call is still alive. Carried through AsyncLocalStorage so
 * handlers keep their signatures and `tdRequest` still sees it.
 */
export interface RequestContext {
  signal?: AbortSignal;
  /** Sends a progress notification. Present only when the caller asked for progress. */
  progress?: (message: string) => void;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext {
  return storage.getStore() ?? {};
}
