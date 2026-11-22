import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, homeFor } from '../auth';
import { ErrorBox, Field, useForm } from '../components/ui';

function AuthFrame({ title, children, footer }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand brand-lg">EMP<span>Examination Management Portal</span></div>
        <h1>{title}</h1>
        {children}
        <div className="auth-footer">{footer}</div>
      </div>
    </div>
  );
}

export function Login() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { values, bind } = useForm({ email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = await login(values.email.trim(), values.password);
      navigate(location.state?.from || homeFor(u.role), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Sign in" footer={<>New student? <Link to="/register">Create an account</Link></>}>
      <form onSubmit={submit} noValidate>
        <ErrorBox error={error} />
        <Field label="Email" type="email" autoComplete="username" required {...bind('email')} />
        <Field label="Password" type="password" autoComplete="current-password" required {...bind('password')} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !values.email || !values.password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="muted small">Admins and examiners sign in with the account the administrator created for them.</p>
      </form>
    </AuthFrame>
  );
}

export function Register() {
  const { user, register } = useAuth();
  const navigate = useNavigate();
  const { values, bind } = useForm({
    full_name: '', email: '', password: '', confirm: '', roll_number: '', phone: '', department: '', program: '', year_of_study: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});

  if (user) return <Navigate to={homeFor(user.role)} replace />;

  const submit = async (e) => {
    e.preventDefault();
    const fe = {};
    if (values.password !== values.confirm) fe.confirm = 'Passwords do not match';
    if (values.password.length < 8) fe.password = 'At least 8 characters, with a letter and a digit';
    setFieldErrors(fe);
    if (Object.keys(fe).length) return;
    setBusy(true);
    setError(null);
    try {
      const { confirm, ...body } = values;
      Object.keys(body).forEach((k) => { if (body[k] === '') delete body[k]; });
      if (body.year_of_study) body.year_of_study = Number(body.year_of_study);
      await register(body);
      navigate('/student', { replace: true });
    } catch (err) {
      setError(err);
      setFieldErrors(err.fieldErrors ? err.fieldErrors() : {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame title="Student registration" footer={<>Already registered? <Link to="/login">Sign in</Link></>}>
      <form onSubmit={submit} noValidate>
        <ErrorBox error={error} />
        <div className="grid-2">
          <Field label="Full name" required error={fieldErrors.full_name} {...bind('full_name')} />
          <Field label="Roll number" required error={fieldErrors.roll_number} hint="Letters, digits, hyphens" {...bind('roll_number')} />
        </div>
        <Field label="Email" type="email" required error={fieldErrors.email} {...bind('email')} />
        <div className="grid-2">
          <Field label="Password" type="password" required error={fieldErrors.password} autoComplete="new-password" {...bind('password')} />
          <Field label="Confirm password" type="password" required error={fieldErrors.confirm} autoComplete="new-password" {...bind('confirm')} />
        </div>
        <div className="grid-2">
          <Field label="Phone" error={fieldErrors.phone} {...bind('phone')} />
          <Field label="Department" error={fieldErrors.department} {...bind('department')} />
        </div>
        <div className="grid-2">
          <Field label="Programme" error={fieldErrors.program} {...bind('program')} />
          <Field label="Year of study" as="select" error={fieldErrors.year_of_study} {...bind('year_of_study')}>
            <option value="">—</option>
            {[1, 2, 3, 4, 5, 6].map((y) => <option key={y} value={y}>{y}</option>)}
          </Field>
        </div>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
    </AuthFrame>
  );
}

export function NotFound() {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Page not found</h1>
        <p className="muted">The page you are looking for does not exist.</p>
        <Link className="btn btn-primary" to="/">Go home</Link>
      </div>
    </div>
  );
}
