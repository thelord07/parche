// ---------------------------------------------------------------------------
// MetaStatus — shared type for file_meta backfill state
// ---------------------------------------------------------------------------

export interface MetaStatus {
  backfill: 'idle' | 'running' | 'done';
}
