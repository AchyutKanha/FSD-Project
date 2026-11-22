import { useCallback, useEffect, useRef, useState } from 'react';

// ------------------------------------------------------------------ data loading
/**
 * useApi(loader, deps) -> { data, loading, error, reload }
 * Ignores responses from superseded requests, so fast typing in a search box
 * can never show results for an older query.
 */
export function useApi(loader, deps = []) {
  const [state, setState] = useState({ data: null, loading: true, error: null });
  const reqId = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loader();
      if (id === reqId.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (id === reqId.current) setState({ data: null, loading: false, error });
    }
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

/** Debounce a value (for search inputs). */
export function useDebounced(value, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Wrap an async action with busy/error state: const [run, busy, error] = useAction(fn) */
export function useAction(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (...args) => {
    setBusy(true);
    setError(null);
    try {
      return await fn(...args);
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return [run, busy, error, setError];
}

// ------------------------------------------------------------------ states
export function Loading({ label = 'Loading…' }) {
  return <div className="state state-loading" role="status"><span className="spinner" aria-hidden="true" />{label}</div>;
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  return (
    <div className="alert alert-error" role="alert">
      <div>
        {error.status === 0 && <strong>Connection problem</strong>}
        {(error.status === undefined || error.status >= 500) && <strong>Something went wrong</strong>}
        <div>{msg}</div>
        {error.errors?.length > 0 && (
          <ul className="error-list">{error.errors.map((e, i) => <li key={i}>{e.field ? <b>{e.field}: </b> : null}{e.message}</li>)}</ul>
        )}
      </div>
      {onRetry && <button type="button" className="btn btn-small" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ title = 'Nothing here yet', children }) {
  return <div className="state state-empty"><strong>{title}</strong>{children && <div className="muted">{children}</div>}</div>;
}

/** Renders loading / error / empty / content for a useApi() result. */
export function AsyncView({ state, isEmpty, empty, children }) {
  if (state.loading && !state.data) return <Loading />;
  if (state.error) return <ErrorBox error={state.error} onRetry={state.reload} />;
  if (!state.data) return null;
  if (isEmpty && isEmpty(state.data)) return empty || <Empty />;
  return <div className={state.loading ? 'refreshing' : undefined}>{children(state.data)}</div>;
}

export function Notice({ kind = 'success', children, onClose }) {
  if (!children) return null;
  return (
    <div className={`alert alert-${kind}`} role="status">
      <div>{children}</div>
      {onClose && <button type="button" className="link" onClick={onClose} aria-label="Dismiss">×</button>}
    </div>
  );
}

// ------------------------------------------------------------------ layout pieces
export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-header">
          {title && <h2>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

const BADGE_TONES = {
  Draft: 'grey', 'Slot Creation': 'blue', 'Booking Open': 'green', Closed: 'amber', Completed: 'purple',
  Available: 'green', Full: 'amber', Cancelled: 'red', Booked: 'blue', Submitted: 'green', Absent: 'red',
  Pending: 'grey', Present: 'green', Active: 'green', Inactive: 'grey', Archived: 'grey', 'On Leave': 'amber',
  Queued: 'grey', Processing: 'blue', Failed: 'red', Pass: 'green', Fail: 'red', Published: 'purple',
};
export function Badge({ children, tone }) {
  return <span className={`badge badge-${tone || BADGE_TONES[children] || 'grey'}`}>{children}</span>;
}

export function Pagination({ page, pages, total, onPage }) {
  if (!pages || pages <= 1) return total !== undefined ? <div className="pagination muted">{total} result{total === 1 ? '' : 's'}</div> : null;
  return (
    <div className="pagination">
      <span className="muted">{total} results · page {page} of {pages}</span>
      <div className="actions">
        <button type="button" className="btn btn-small" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Prev</button>
        <button type="button" className="btn btn-small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</button>
      </div>
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button type="button" className="link close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ forms
/** Labelled, controlled input. `as` = 'input' | 'select' | 'textarea'. */
export function Field({ label, error, hint, as = 'input', children, className = '', ...props }) {
  const Tag = as;
  const id = props.id || `f-${props.name}`;
  return (
    <div className={`field ${error ? 'has-error' : ''} ${className}`}>
      {label && <label htmlFor={id}>{label}{props.required && <span className="req"> *</span>}</label>}
      {as === 'select'
        ? <select id={id} {...props}>{children}</select>
        : <Tag id={id} {...props} />}
      {error ? <div className="field-error">{error}</div> : hint ? <div className="field-hint">{hint}</div> : null}
    </div>
  );
}

/** Keeps form state; `bind(name)` gives value/onChange for a Field. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const set = (name, value) => setValues((v) => ({ ...v, [name]: value }));
  const bind = (name, { type } = {}) => ({
    name,
    value: values[name] ?? '',
    onChange: (e) => set(name, type === 'checkbox' ? e.target.checked : e.target.value),
    ...(type === 'checkbox' ? { checked: Boolean(values[name]), type } : {}),
  });
  return { values, setValues, set, bind };
}

export function SearchBox({ value, onChange, placeholder = 'Search…' }) {
  return (
    <input
      type="search"
      className="search"
      value={value}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function ConfirmButton({ children, confirm, onConfirm, className = 'btn', disabled }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <span className="confirm">
        <span>{confirm || 'Are you sure?'}</span>
        <button type="button" className="btn btn-small btn-danger" onClick={() => { setAsking(false); onConfirm(); }}>Yes</button>
        <button type="button" className="btn btn-small" onClick={() => setAsking(false)}>No</button>
      </span>
    );
  }
  return <button type="button" className={className} disabled={disabled} onClick={() => setAsking(true)}>{children}</button>;
}

// ------------------------------------------------------------------ formatting
export const fmtDate = (d) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtTime = (t) => (t ? String(t).slice(0, 5) : '—');
export const fmtSlot = (s) => (s ? `${fmtDate(s.slot_date)}, ${fmtTime(s.start_time)}–${fmtTime(s.end_time)}` : '—');
export const fmtMarks = (m, max) => (m === null || m === undefined ? '—' : `${Number(m).toFixed(m % 1 ? 2 : 0)}${max ? ` / ${max}` : ''}`);

/** ISO string <-> value for <input type="datetime-local"> in the browser's time zone */
export const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

/** A small horizontal bar for report tables */
export function Bar({ value, max, label }) {
  const pct = max ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="bar" title={label || `${value}`}>
      <div className="bar-fill" style={{ width: `${pct}%` }} />
      <span className="bar-label">{label ?? value}</span>
    </div>
  );
}
