// ---------------------------------------------------------------------------
// SecretScanStatus — shared type for the secret-scan backfill state
// (espejo de src/meta/status.ts)
//
// PARCHE-013 (D3) — además de `scan` (idle|running|done, sin cambios de
// nombre para no romper los callers existentes), se expone el estado del
// re-escaneo por cambio de versión de reglas para `/health`:
// `rulesVersion`/`pending`/`scanned` son opcionales para que los literales
// `{ scan: 'idle' }` ya existentes en tests sigan siendo válidos — nunca
// llevan rutas ni valores de secretos, solo un contador y una versión.
// ---------------------------------------------------------------------------

export interface SecretScanStatus {
  scan: 'idle' | 'running' | 'done';
  /** Versión de reglas (@chamba/core) con la que corre/corrió este escaneo. */
  rulesVersion?: string | null;
  /** Rutas que faltan por (re)escanear en la corrida actual/última. */
  pending?: number;
  /** Rutas ya (re)escaneadas en la corrida actual/última. */
  scanned?: number;
}
