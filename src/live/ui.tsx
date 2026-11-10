import type { ReactNode } from 'react';
import { X } from 'lucide-react';

export type Perform = (operation: () => Promise<unknown>, message?: string, refreshAfter?: boolean) => Promise<void>;

export function Dialog({ title, onClose, children, error, wide = false }: { title: string; onClose: () => void; children: ReactNode; error?: string; wide?: boolean }) {
  return <div className="modal-backdrop live-dialog-backdrop" onClick={onClose}>
    <section className={`modal live-dialog ${wide ? 'live-dialog-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}>
      <div className="live-panel-heading"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={onClose}><X size={20} /></button></div>
      {error && <div className="live-alert live-alert-error" role="alert">{error}</div>}
      {children}
    </section>
  </div>;
}

export const formatNumber = (value: number) => Number.isFinite(value) ? value.toLocaleString() : '0';
export const formatPercent = (value: number | null | undefined, digits = 1) => value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value.toFixed(digits)}%`;
export const share = (part: number, total: number) => total > 0 ? part / total * 100 : 0;

/** Amounts are stored in the currency's minor unit (for example cents). */
export function formatMinorCurrency(amount: number, currency: string) {
  try {
    const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amount / 10 ** digits);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency}`;
  }
}

export const formatDateTime = (value: string | null | undefined) => {
  if (!value) return '—';
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '—';
};

export function ShareBar({ value, label }: { value: number; label: string }) {
  const width = Math.max(0, Math.min(100, value));
  return <span className="live-bar" role="img" aria-label={`${label}: ${width.toFixed(1)}%`}><span style={{ width: `${width}%` }} /></span>;
}
