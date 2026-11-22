import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import {
  AsyncView, Badge, Card, ConfirmButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Pagination, SearchBox, Stat,
  fmtDate, fmtDateTime, fmtMarks, fmtSlot, useAction, useApi, useDebounced, useForm,
} from '../../components/ui';

// ================================================================== dashboard
export function AdminDashboard() {
  const state = useApi(() => api('/admin/dashboard'), []);
  return (
    <>
      <PageHeader title="Admin dashboard" actions={<Link className="btn btn-primary" to="/admin/exams?new=1">New examination</Link>} />
      <AsyncView state={state}>
        {(d) => (
          <>
            <div className="stats">
              <Stat label="Courses" value={d.totals.courses} />
              <Stat label="Examinations" value={d.totals.examinations} tone="blue" />
              <Stat label="Students" value={d.totals.students} />
              <Stat label="Examiners" value={d.totals.examiners} />
              <Stat label="Examination slots" value={d.totals.slots} tone="green" />
              <Stat label="Bookings" value={d.totals.bookings} hint={`${d.totals.active_bookings} active`} tone="purple" />
              <Stat label="Pending evaluations" value={d.totals.pending_evaluations} tone={d.totals.pending_evaluations ? 'amber' : undefined} />
            </div>
            <div className="grid-2">
              <Card title="Examinations by status">
                <ul className="list">
                  {Object.entries(d.exams_by_status).map(([s, n]) => (
                    <li key={s}><Link to={`/admin/exams?status=${encodeURIComponent(s)}`}><Badge>{s}</Badge></Link><strong>{n}</strong></li>
                  ))}
                </ul>
              </Card>
              <Card title="Open windows" actions={<Link to="/admin/exams">All examinations</Link>}>
                {d.active_windows.length === 0 ? <Empty title="No slot creation or booking windows are open" /> : (
                  <ul className="list">
                    {d.active_windows.map((e) => (
                      <li key={e.id}>
                        <Link to={`/admin/exams/${e.id}`}><strong>{e.name}</strong></Link>
                        <span className="muted">{e.course_code}</span>
                        <Badge>{e.status}</Badge>
                        <span className="small muted">closes {fmtDateTime(e.status === 'Booking Open' ? e.booking_end : e.slot_creation_end)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="Latest bookings" actions={<Link to="/admin/bookings">All bookings</Link>}>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Student</th><th>Examination</th><th>Slot</th><th>Status</th><th>Booked</th></tr></thead>
                  <tbody>
                    {d.recent_bookings.map((b) => (
                      <tr key={b.id}>
                        <td><Link to={`/admin/bookings?open=${b.id}`}>{b.student_name}</Link></td>
                        <td>{b.exam_name} <span className="muted small">{b.course_code}</span></td>
                        <td>{fmtSlot({ ...b, end_time: null })}</td>
                        <td><Badge>{b.status}</Badge></td>
                        <td>{fmtDateTime(b.booked_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}

// ================================================================== courses
function CourseForm({ course, onDone, onCancel }) {
  const { values, bind } = useForm({
    code: course?.code || '', name: course?.name || '', description: course?.description || '',
    department: course?.department || '', credits: course?.credits ?? '', status: course?.status || 'Active',
  });
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    const body = { ...values, credits: values.credits === '' ? null : Number(values.credits) };
    if (course) await api(`/admin/courses/${course.id}`, { method: 'PUT', body });
    else await api('/admin/courses', { method: 'POST', body });
    onDone(course ? 'Course updated.' : 'Course created.');
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Course code" required error={fe.code} hint="e.g. CS-101" {...bind('code')} />
        <Field label="Status" as="select" error={fe.status} {...bind('status')}>
          {['Active', 'Inactive', 'Archived'].map((s) => <option key={s}>{s}</option>)}
        </Field>
      </div>
      <Field label="Course name" required error={fe.name} {...bind('name')} />
      <div className="grid-2">
        <Field label="Department" error={fe.department} {...bind('department')} />
        <Field label="Credits" type="number" min="0" max="20" error={fe.credits} {...bind('credits')} />
      </div>
      <Field label="Description" as="textarea" rows={3} error={fe.description} {...bind('description')} />
      <div className="actions end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save course'}</button>
      </div>
    </form>
  );
}

export function AdminCourses() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status]);
  const state = useApi(() => api(`/admin/courses${qs({ q: dq, status, page })}`), [dq, status, page]);
  const [remove, , removeError] = useAction(async (c) => {
    await api(`/admin/courses/${c.id}`, { method: 'DELETE' });
    setNotice('Course deleted.');
    state.reload();
  });

  return (
    <>
      <PageHeader title="Courses" actions={<button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>New course</button>} />
      <Notice onClose={() => setNotice(null)}>{notice}</Notice>
      <ErrorBox error={removeError} />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search code, name, department" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>{['Active', 'Inactive', 'Archived'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No courses found" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Code</th><th>Name</th><th>Department</th><th>Credits</th><th>Exams</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {d.items.map((c) => (
                    <tr key={c.id}>
                      <td><strong>{c.code}</strong></td>
                      <td>{c.name}</td>
                      <td>{c.department || '—'}</td>
                      <td>{c.credits ?? '—'}</td>
                      <td><Link to={`/admin/exams?course_id=${c.id}`}>{c.exam_count}</Link></td>
                      <td><Badge>{c.status}</Badge></td>
                      <td className="actions">
                        <button type="button" className="btn btn-small" onClick={() => setEditing(c)}>Edit</button>
                        {c.exam_count === 0 && <ConfirmButton className="btn btn-small btn-danger" confirm="Delete?" onConfirm={() => remove(c)}>Delete</ConfirmButton>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {editing && (
        <Modal title={editing === 'new' ? 'New course' : `Edit ${editing.code}`} onClose={() => setEditing(null)}>
          <CourseForm course={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onDone={(m) => { setEditing(null); setNotice(m); state.reload(); }} />
        </Modal>
      )}
    </>
  );
}

// ================================================================== examiners
function ExaminerForm({ examiner, onDone, onCancel }) {
  const { values, bind } = useForm({
    full_name: examiner?.full_name || '', email: examiner?.email || '', password: '', employee_code: examiner?.employee_code || '',
    department: examiner?.department || '', phone: examiner?.phone || '', designation: examiner?.designation || '',
    specialization: examiner?.specialization || '', status: examiner?.status || 'Active',
  });
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    if (examiner) {
      const { employee_code: _ec, ...rest } = values;
      const body = { ...rest };
      if (!body.password) delete body.password;
      await api(`/admin/examiners/${examiner.id}`, { method: 'PUT', body });
    } else {
      const { status: _s, ...body } = values;
      await api('/admin/examiners', { method: 'POST', body });
    }
    onDone(examiner ? 'Examiner updated.' : 'Examiner account created. Share the email and password with them.');
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Full name" required error={fe.full_name} {...bind('full_name')} />
        <Field label="Employee code" required={!examiner} disabled={Boolean(examiner)} error={fe.employee_code} {...bind('employee_code')} />
      </div>
      <div className="grid-2">
        <Field label="Email (login)" type="email" required error={fe.email} {...bind('email')} />
        <Field label={examiner ? 'New password (optional)' : 'Initial password'} type="password" required={!examiner} error={fe.password} autoComplete="new-password" {...bind('password')} />
      </div>
      <div className="grid-2">
        <Field label="Department" required error={fe.department} {...bind('department')} />
        <Field label="Phone" error={fe.phone} {...bind('phone')} />
      </div>
      <div className="grid-2">
        <Field label="Designation" error={fe.designation} {...bind('designation')} />
        <Field label="Specialisation" error={fe.specialization} {...bind('specialization')} />
      </div>
      {examiner && (
        <Field label="Status" as="select" error={fe.status} {...bind('status')}>
          {['Active', 'On Leave', 'Inactive'].map((s) => <option key={s}>{s}</option>)}
        </Field>
      )}
      <div className="actions end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save examiner'}</button>
      </div>
    </form>
  );
}

export function AdminExaminers() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(null);
  const [viewing, setViewing] = useState(null);
  const [notice, setNotice] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status]);
  const state = useApi(() => api(`/admin/examiners${qs({ q: dq, status, page })}`), [dq, status, page]);
  const [toggle, , toggleError] = useAction(async (x) => {
    await api(`/admin/examiners/${x.id}`, { method: 'PUT', body: { is_active: !x.is_active } });
    setNotice(x.is_active ? `${x.full_name} can no longer log in.` : `${x.full_name} re-activated.`);
    state.reload();
  });

  return (
    <>
      <PageHeader title="Examiners" actions={<button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>Add examiner</button>} />
      <Notice onClose={() => setNotice(null)}>{notice}</Notice>
      <ErrorBox error={toggleError} />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search name, email, employee code" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>{['Active', 'On Leave', 'Inactive'].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No examiners found" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Examiner</th><th>Department</th><th>Exams</th><th>Slots</th><th>Evaluations</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {d.items.map((x) => (
                    <tr key={x.id}>
                      <td><button type="button" className="link" onClick={() => setViewing(x)}><strong>{x.full_name}</strong></button><div className="muted small">{x.employee_code} · {x.email}</div></td>
                      <td>{x.department}<div className="muted small">{x.designation}</div></td>
                      <td>{x.assigned_exams}</td>
                      <td>{x.slots}</td>
                      <td>{x.evaluations}</td>
                      <td><Badge>{x.status}</Badge> {!x.is_active && <Badge tone="red">Login disabled</Badge>}</td>
                      <td className="actions">
                        <button type="button" className="btn btn-small" onClick={() => setEditing(x)}>Edit</button>
                        <ConfirmButton className="btn btn-small" confirm={x.is_active ? 'Disable login?' : 'Enable login?'} onConfirm={() => toggle(x)}>
                          {x.is_active ? 'Deactivate' : 'Activate'}
                        </ConfirmButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {editing && (
        <Modal title={editing === 'new' ? 'Add examiner' : `Edit ${editing.full_name}`} onClose={() => setEditing(null)}>
          <ExaminerForm examiner={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onDone={(m) => { setEditing(null); setNotice(m); state.reload(); }} />
        </Modal>
      )}
      {viewing && <ExaminerDetail id={viewing.id} onClose={() => setViewing(null)} />}
    </>
  );
}

function ExaminerDetail({ id, onClose }) {
  const state = useApi(() => api(`/admin/examiners/${id}`), [id]);
  return (
    <Modal title="Examiner" onClose={onClose} wide>
      <AsyncView state={state}>
        {({ examiner: x, exams }) => (
          <>
            <dl className="dl">
              <dt>Name</dt><dd>{x.full_name}</dd><dt>Email</dt><dd>{x.email}</dd>
              <dt>Department</dt><dd>{x.department}</dd><dt>Phone</dt><dd>{x.phone || '—'}</dd>
              <dt>Last login</dt><dd>{fmtDateTime(x.last_login_at)}</dd>
            </dl>
            <h3>Assigned examinations</h3>
            {exams.length === 0 ? <Empty title="Not assigned to any examination" /> : (
              <table className="table compact">
                <thead><tr><th>Examination</th><th>Status</th><th>Slots</th></tr></thead>
                <tbody>{exams.map((e) => <tr key={e.id}><td><Link to={`/admin/exams/${e.id}`}>{e.name}</Link> <span className="muted small">{e.course_code}</span></td><td><Badge>{e.status}</Badge></td><td>{e.slots}</td></tr>)}</tbody>
              </table>
            )}
            <Link to={`/admin/slots?examiner_id=${x.id}`}>View all slots of this examiner →</Link>
          </>
        )}
      </AsyncView>
    </Modal>
  );
}

// ================================================================== students
export function AdminStudents() {
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [active, setActive] = useState('');
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, active]);
  const state = useApi(() => api(`/admin/students${qs({ q: dq, active, page })}`), [dq, active, page]);

  return (
    <>
      <PageHeader title="Students" />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search name, email, roll number" />
        <select value={active} onChange={(e) => setActive(e.target.value)} aria-label="Account">
          <option value="">All accounts</option><option value="true">Active</option><option value="false">Deactivated</option>
        </select>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No students found" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Student</th><th>Roll no.</th><th>Department</th><th>Year</th><th>Bookings</th><th>Account</th></tr></thead>
                <tbody>
                  {d.items.map((s) => (
                    <tr key={s.id}>
                      <td><button type="button" className="link" onClick={() => setViewing(s.id)}><strong>{s.full_name}</strong></button><div className="muted small">{s.email}</div></td>
                      <td>{s.roll_number}</td>
                      <td>{s.department || '—'}<div className="muted small">{s.program}</div></td>
                      <td>{s.year_of_study || '—'}</td>
                      <td>{s.bookings}</td>
                      <td>{s.is_active ? <Badge>Active</Badge> : <Badge tone="red">Deactivated</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {viewing && <StudentDetail id={viewing} onClose={() => setViewing(null)} onChanged={state.reload} />}
    </>
  );
}

function StudentDetail({ id, onClose, onChanged }) {
  const state = useApi(() => api(`/admin/students/${id}`), [id]);
  const [toggle, busy, error] = useAction(async (s) => {
    await api(`/admin/students/${s.id}/status`, { method: 'PUT', body: { is_active: !s.is_active } });
    state.reload();
    onChanged();
  });
  return (
    <Modal title="Student" onClose={onClose} wide>
      <AsyncView state={state}>
        {({ student: s, bookings }) => (
          <>
            <ErrorBox error={error} />
            <dl className="dl">
              <dt>Name</dt><dd>{s.full_name}</dd><dt>Roll number</dt><dd>{s.roll_number}</dd>
              <dt>Email</dt><dd>{s.email}</dd><dt>Phone</dt><dd>{s.phone || '—'}</dd>
              <dt>Department</dt><dd>{s.department || '—'} {s.program && `· ${s.program}`} {s.year_of_study && `· year ${s.year_of_study}`}</dd>
              <dt>Registered</dt><dd>{fmtDate(s.created_at)}</dd>
              <dt>Account</dt><dd>{s.is_active ? <Badge>Active</Badge> : <Badge tone="red">Deactivated</Badge>}{' '}
                <ConfirmButton className="btn btn-small" disabled={busy} confirm={s.is_active ? 'Deactivate?' : 'Activate?'} onConfirm={() => toggle(s)}>{s.is_active ? 'Deactivate' : 'Activate'}</ConfirmButton></dd>
            </dl>
            <h3>Examination history</h3>
            {bookings.length === 0 ? <Empty title="No bookings" /> : (
              <div className="table-wrap">
                <table className="table compact">
                  <thead><tr><th>Examination</th><th>Date</th><th>Examiner</th><th>Status</th><th>Marks</th></tr></thead>
                  <tbody>{bookings.map((b) => (
                    <tr key={b.id}>
                      <td>{b.exam_name} <span className="muted small">{b.course_code}</span></td>
                      <td>{fmtDate(b.slot_date)}</td>
                      <td>{b.examiner_name}</td>
                      <td><Badge>{b.status}</Badge></td>
                      <td>{b.evaluation_status === 'Absent' ? 'Absent' : fmtMarks(b.total_marks, b.max_marks)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
      </AsyncView>
    </Modal>
  );
}

// ================================================================== global search
export function AdminSearch() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q, 350);
  const state = useApi(() => (dq.trim().length >= 2 ? api(`/admin/search${qs({ q: dq.trim() })}`) : Promise.resolve(null)), [dq]);
  const total = state.data ? Object.values(state.data).reduce((s, a) => s + a.length, 0) : 0;
  return (
    <>
      <PageHeader title="Search" subtitle="Students, examiners, examinations and bookings in one place." />
      <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Type at least 2 characters — a name, email, roll number, course code or booking id" /></div>
      {dq.trim().length < 2 ? <Empty title="Start typing to search" /> : (
        <AsyncView state={state} isEmpty={() => total === 0} empty={<Empty title={`Nothing matches "${dq}"`} />}>
          {(d) => (
            <div className="grid-2">
              <Card title={`Students (${d.students.length})`}>
                <ul className="list">{d.students.map((s) => <li key={s.id}><Link to={`/admin/students?q=${encodeURIComponent(s.roll_number)}`}>{s.full_name}</Link><span className="muted">{s.roll_number} · {s.email}</span></li>)}</ul>
              </Card>
              <Card title={`Examiners (${d.examiners.length})`}>
                <ul className="list">{d.examiners.map((x) => <li key={x.id}><span>{x.full_name}</span><span className="muted">{x.department} · {x.email}</span></li>)}</ul>
              </Card>
              <Card title={`Examinations (${d.exams.length})`}>
                <ul className="list">{d.exams.map((e) => <li key={e.id}><Link to={`/admin/exams/${e.id}`}>{e.name}</Link><span className="muted">{e.course_code}</span><Badge>{e.status}</Badge></li>)}</ul>
              </Card>
              <Card title={`Bookings (${d.bookings.length})`}>
                <ul className="list">{d.bookings.map((b) => <li key={b.id}><Link to={`/admin/bookings?open=${b.id}`}>#{b.id} {b.student_name}</Link><span className="muted">{b.exam_name}</span><Badge>{b.status}</Badge></li>)}</ul>
              </Card>
            </div>
          )}
        </AsyncView>
      )}
    </>
  );
}
