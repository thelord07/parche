/**
 * ConfirmDialog — diálogo accesible para confirmar acciones destructivas.
 *
 * Requisitos de accesibilidad:
 *  - role="dialog" + aria-modal="true" + aria-labelledby
 *  - Foco inicial en el botón Cancelar (el botón "seguro")
 *  - Esc cancela
 *  - Foco atrapado dentro del diálogo mientras esté abierto
 */

import { useCallback, useEffect, useRef } from 'react';

export interface ConfirmDialogProps {
  /** Mensaje descriptivo a mostrar en el diálogo */
  message: string;
  /** Texto del botón de confirmación (destructivo) */
  confirmLabel?: string;
  /** Si es true, el botón de confirmar está en estado de carga */
  confirming?: boolean;
  /** Callback al confirmar */
  onConfirm: () => void;
  /** Callback al cancelar (también se llama al presionar Esc) */
  onCancel: () => void;
}

export function ConfirmDialog({
  message,
  confirmLabel = 'Confirmar',
  confirming = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  const confirmBtnRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Foco inicial en Cancelar
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);

  // Esc cancela
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  // Trampa de foco: Tab/Shift+Tab cicla solo dentro del diálogo
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;

    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled])');
    if (!focusable || focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!first || !last) return;

    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: overlay is a backdrop dismiss target, keyboard is handled via Esc on document
    // biome-ignore lint/a11y/useKeyWithClickEvents: same rationale; Esc handler on document covers keyboard users
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 16px',
        background: 'rgba(0,0,0,0.55)',
      }}
      onClick={onCancel}
    >
      {/* Dialog box */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 440,
          borderRadius: 8,
          border: '1px solid var(--border)',
          background: 'var(--card)',
          padding: 24,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
        }}
      >
        <p
          id="confirm-dialog-title"
          style={{
            margin: 0,
            fontSize: 15,
            lineHeight: 1.55,
            color: 'var(--text)',
          }}
        >
          {message}
        </p>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            ref={cancelBtnRef}
            type="button"
            onClick={onCancel}
            disabled={confirming}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: 5,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 13,
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancelar
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            onClick={onConfirm}
            disabled={confirming}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: 5,
              border: '1px solid transparent',
              background: 'var(--warn-text)',
              color: 'var(--bg)',
              fontSize: 13,
              fontWeight: 600,
              cursor: confirming ? 'not-allowed' : 'pointer',
              opacity: confirming ? 0.7 : 1,
            }}
          >
            {confirming ? 'Procesando…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
