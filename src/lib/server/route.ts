import 'server-only'
import { logEvent } from './log'

/**
 * B7 — JSON error wrapper for EVERY API route.
 *
 * Bug: an exception thrown inside a route handler (provider SDK error, misconfiguration, a bug)
 * produced Next.js' default EMPTY HTTP 500. The client's `res.json()` then failed, so the UI showed a
 * meaningless `http_500`, and session-scoped routes could leak rooms/reservations without any trace.
 *
 * `withJsonErrors(name, handler)`:
 *  - always answers JSON (`{ error, message, requestId }`) with `cache-control: no-store`;
 *  - maps a missing approval secret (production fail-closed, see env.ts / B2) to 503
 *    `server_misconfigured` instead of a generic 500, so operators see what to fix;
 *  - stamps every response with `x-revoice-request-id` for correlation with logs;
 *  - logs only content-free metadata (route, error class, request id) — never bodies or messages,
 *    which may contain user text.
 */
export type RouteHandler<A extends unknown[]> = (...args: A) => Promise<Response> | Response

export function newRequestId(): string {
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function errorResponse(status: number, error: string, message: string, requestId: string): Response {
  return new Response(JSON.stringify({ error, message, requestId }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-revoice-request-id': requestId },
  })
}

/** Classify an unexpected exception into a stable, user-safe JSON error. */
export function classifyError(e: unknown): { status: number; error: string; message: string } {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.startsWith('approval_secret_unavailable')) {
    return { status: 503, error: 'server_misconfigured', message: 'The server is missing REVOICE_APPROVAL_SECRET (or LIVEKIT_API_SECRET / ASSEMBLYAI_API_KEY). Typing still works; speech and sessions need it.' }
  }
  if (/LiveKit not configured|LIVEKIT_URL not configured/.test(msg)) {
    return { status: 503, error: 'livekit_not_configured', message: 'Listening rooms are not configured on this server.' }
  }
  if (e instanceof SyntaxError) return { status: 400, error: 'invalid_request', message: 'The request body could not be read.' }
  return { status: 500, error: 'internal_error', message: 'Something went wrong on the server. Nothing was spoken. Please try again.' }
}

export function withJsonErrors<A extends unknown[]>(route: string, handler: RouteHandler<A>): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    const requestId = newRequestId()
    try {
      const res = await handler(...args)
      // Stamp the id where headers are mutable (streams keep theirs if immutable).
      try {
        if (!res.headers.has('x-revoice-request-id')) res.headers.set('x-revoice-request-id', requestId)
      } catch {}
      return res
    } catch (e) {
      const c = classifyError(e)
      logEvent({ evt: 'route_error', route, status: c.status, code: c.error, kind: e instanceof Error ? e.name : typeof e, req: requestId })
      return errorResponse(c.status, c.error, c.message, requestId)
    }
  }
}
