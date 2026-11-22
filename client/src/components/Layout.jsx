import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, homeFor } from '../auth';
import { api } from '../api';
import { fmtDateTime, Loading } from './ui';

const NAV = {
  admin: [
    ['/admin', 'Dashboard', true], ['/admin/courses', 'Courses'], ['/admin/exams', 'Examinations'],
    ['/admin/examiners', 'Examiners'], ['/admin/students', 'Students'], ['/admin/slots', 'Slots'],
    ['/admin/bookings', 'Bookings'], ['/admin/reports', 'Reports'], ['/admin/search', 'Search'],
  ],
  examiner: [
    ['/examiner', 'Dashboard', true], ['/examiner/exams', 'My examinations'], ['/examiner/slots', 'My slots'],
    ['/examiner/students', 'Booked students'],
  ],
  student: [
    ['/student', 'Dashboard', true], ['/student/exams', 'Examinations'], ['/student/bookings', 'My bookings'],
    ['/student/history', 'History'], ['/student/results', 'Results'], ['/student/profile', 'Profile'],
  ],
};

function Notifications() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState({ items: [], unread: 0 });
  const navigate = useNavigate();

  const load = () => api('/notifications').then(setData).catch(() => {});
  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, []);

  const openItem = async (n) => {
    if (!n.is_read) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => {});
    setOpen(false);
    load();
    if (n.link) navigate(n.link);
  };
  const readAll = async () => { await api('/notifications/read-all', { method: 'POST' }).catch(() => {}); load(); };

  return (
    <div className="notif">
      <button type="button" className="btn btn-ghost" onClick={() => { setOpen(!open); if (!open) load(); }} aria-expanded={open}>
        Notifications{data.unread > 0 && <span className="pill">{data.unread}</span>}
      </button>
      {open && (
        <div className="notif-panel">
          <div className="notif-head">
            <strong>Notifications</strong>
            {data.unread > 0 && <button type="button" className="link" onClick={readAll}>Mark all read</button>}
          </div>
          {data.items.length === 0 && <div className="muted pad">You're all caught up.</div>}
          {data.items.map((n) => (
            <button type="button" key={n.id} className={`notif-item ${n.is_read ? '' : 'unread'}`} onClick={() => openItem(n)}>
              <strong>{n.title}</strong>
              <span>{n.message}</span>
              <small className="muted">{fmtDateTime(n.created_at)}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  useEffect(() => setMenu(false), [location.pathname]);
  const items = NAV[user.role] || [];

  return (
    <div className="shell">
      <header className="topbar">
        <button type="button" className="btn btn-ghost menu-toggle" onClick={() => setMenu(!menu)} aria-label="Menu">☰</button>
        <Link to={homeFor(user.role)} className="brand">EMP<span>Examination Portal</span></Link>
        <div className="topbar-right">
          <Notifications />
          <span className="who"><strong>{user.full_name}</strong><small>{user.role}</small></span>
          <button type="button" className="btn btn-small" onClick={logout}>Log out</button>
        </div>
      </header>
      <div className="body">
        <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main">
          {items.map(([to, label, end]) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => (isActive ? 'active' : undefined)}>{label}</NavLink>
          ))}
        </nav>
        <main className="content"><Outlet /></main>
      </div>
    </div>
  );
}

/** Route guard: must be logged in with one of `roles`. */
export function RequireRole({ roles, children }) {
  const { user, checking } = useAuth();
  const location = useLocation();
  if (checking) return <Loading label="Restoring your session…" />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  return children;
}
