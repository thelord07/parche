// ---------------------------------------------------------------------------
// SecretScanStatus — shared type for the secret-scan backfill state
// (espejo de src/meta/status.ts)
// ---------------------------------------------------------------------------

export interface SecretScanStatus {
  scan: 'idle' | 'running' | 'done';
}
