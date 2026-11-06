/**
 * E50: Content-Security-Policy. Pure (no `server-only`) so next.config.ts and the tests share it.
 *
 * What the app legitimately talks to:
 *   - itself (the browser never talks to Supabase: it is a server-side store only);  Google Fonts (CSS + font files);
 *   - LiveKit (wss signalling + https) — the host from LIVEKIT_URL, plus *.livekit.cloud as a safe default;
 *   - AssemblyAI streaming STT (browser-direct demo mode) over wss, US and EU zones;
 *   - blob: for the capture AudioWorklet (script-src governs addModule) and for message-bank / export blobs; data: for icons.
 * Next.js emits inline bootstrap scripts, so `script-src` keeps 'unsafe-inline' (a nonce would force every page dynamic);
 * 'unsafe-eval' is added in development only (React refresh).
 */
function hostOf(u: string | undefined): string | null {
  if (!u) return null
  try {
    return new URL(u).host
  } catch {
    return null
  }
}

export function buildCsp(opts: { dev?: boolean; livekitUrl?: string } = {}): string {
  const lk = hostOf(opts.livekitUrl?.replace(/^wss?:/, 'https:'))
  const connect = [
    "'self'",
    lk ? `https://${lk}` : null,
    lk ? `wss://${lk}` : null,
    'https://*.livekit.cloud',
    'wss://*.livekit.cloud',
    'wss://streaming.assemblyai.com',
    'wss://streaming.eu.assemblyai.com',
  ].filter((x): x is string => !!x)
  const d: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(opts.dev ? ["'unsafe-eval'"] : []), 'blob:'],
    'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
    'img-src': ["'self'", 'data:', 'blob:'],
    'media-src': ["'self'", 'blob:', 'mediastream:'],
    'connect-src': [...new Set(connect)],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'frame-ancestors': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'object-src': ["'none'"],
  }
  return Object.entries(d).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
}
