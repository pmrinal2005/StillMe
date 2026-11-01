/**
 * Compare the app's estimated spend with the provider-reported figure.
 * Drift above the tolerance means the ledger under-counts (or over-counts) and limits must be revisited.
 */
export interface ReconcileResult {
  appUsd: number
  providerUsd: number | null
  driftUsd: number | null
  driftPct: number | null
  status: 'ok' | 'under_counted' | 'over_counted' | 'no_provider_figure'
}

export const RECONCILE_TOLERANCE = { pct: 0.1, usd: 0.25 }

export function reconcile(appUsd: number, providerUsd: number | null, tol = RECONCILE_TOLERANCE): ReconcileResult {
  if (providerUsd === null || !Number.isFinite(providerUsd)) return { appUsd, providerUsd: null, driftUsd: null, driftPct: null, status: 'no_provider_figure' }
  const drift = +(providerUsd - appUsd).toFixed(4)
  const pct = providerUsd === 0 ? (appUsd === 0 ? 0 : 1) : Math.abs(drift) / providerUsd
  const material = Math.abs(drift) > tol.usd && pct > tol.pct
  return {
    appUsd,
    providerUsd,
    driftUsd: drift,
    driftPct: +pct.toFixed(4),
    status: !material ? 'ok' : drift > 0 ? 'under_counted' : 'over_counted',
  }
}
