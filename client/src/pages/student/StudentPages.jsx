import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, download, qs } from '../../api';
import { useAuth } from '../../auth';
import {
  AsyncView, Badge, Card, ConfirmButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Pagination, SearchBox, Stat,
  fmtDate, fmtDateTime, fmtMarks, fmtSlot, fmtTime, useAction, useApi, useDebounced, useForm,
} from '../../components/ui';

// ================================================================== dashboard
export function StudentDashboard() {
  const state = useApi(() => api('/student/dashboard'), []);
  return (
    <>
      <PageHeader title="Dashboard" actions={<Link className="btn btn-primary" to="/student/exams?open=1">Book an examination</Link>} />
      <AsyncView state={state}>
        {(d) => (
          <>
            <div className="stats">
              <Stat label="Exams open for booking" value={d.counts.available_exams} tone="green" />
              <Stat label="Available slots" value={d.counts.available_slots} />
              <Stat label="Upcoming examinations" value={d.counts.upcoming} tone="blue" />
              <Stat label="Published results" value={d.counts.published_results} tone="purple" />
            </div>
            <div className="grid-2">
              <Card title="Upcoming examinations" actions={<Link to="/student/bookings">All bookings</Link>}>
                {d.upcoming.length === 0 ? <Empty title="No upcoming examinations">Browse open examinations to book a slot.</Empty> : (
                  <ul className="list">
                    {d.upcoming.map((b) => (
                      <li key={b.id}>
                        <Link to={`/student/bookings/${b.id}`}><strong>{b.exam_name}</strong></Link>
                        <span className="muted">{b.course_code} · {fmtSlot(b)} · {b.examiner_name}</span>
                        {b.meeting_link && <a href={b.meeting_link} target="_blank" rel="noreferrer">Meeting link</a>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Recent results" actions={<Link to="/student/results">All results</Link>}>
                {d.recent_results.length === 0 ? <Empty title="No published results yet" /> : (
                  <ul className="list">
                    {d.recent_results.map((r) => (
                      <li key={r.id}>
                        <strong>{r.exam_name}</strong>
                        <span className="muted">{r.course_code}</span>
                        <span>{r.evaluation_status === 'Absent' ? <Badge>Absent</Badge> : fmtMarks(r.marks, r.max_marks)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          </>
        )}
      </AsyncView>
    </>
  );
}

// ================================================================== browse exams
export function StudentExams() {
  const [params] = useSearchParams();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ course_id: '', exam_type: '', status: '', open_only: params.get('open') === '1' });
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, filters]);
  const options = useApi(() => api('/options'), []);
  const state = useApi(() => api(`/student/exams${qs({ q: dq, page, ...filters })}`), [dq, page, filters]);
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <>
      <PageHeader title="Examinations" subtitle="Search and filter examinations, then pick a slot." />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search by exam, course name or code" />
        <select value={filters.course_id} onChange={setF('course_id')} aria-label="Course">
          <option value="">All courses</option>
          {options.data?.courses.filter((c) => c.status === 'Active').map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </select>
        <select value={filters.exam_type} onChange={setF('exam_type')} aria-label="Type">
          <option value="">All types</option>
          {options.data?.exam_types.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={filters.status} onChange={setF('status')} aria-label="Status">
          <option value="">Any status</option>
          {['Slot Creation', 'Booking Open', 'Closed', 'Completed'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={filters.open_only} onChange={setF('open_only')} /> Open for booking</label>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No examinations match">Try clearing a filter.</Empty>}>
        {(d) => (
          <>
            <div className="cards">
              {d.items.map((e) => (
                <Link key={e.id} to={`/student/exams/${e.id}`} className="exam-card">
                  <div className="exam-card-top">
                    {e.booking_open ? <Badge tone="green">Booking open</Badge> : <Badge>{e.status}</Badge>}
                    {e.my_booking && <Badge tone="blue">Booked</Badge>}
                  </div>
                  <h3>{e.name}</h3>
                  <div className="muted">{e.course_code} — {e.course_name}</div>
                  <div className="meta">
                    <span>{e.exam_type}</span><span>{e.duration_minutes} min</span><span>{e.max_marks} marks</span>
                  </div>
                  <div className="meta">
                    {e.booking_open
                      ? <span>{e.available_slots} slot{e.available_slots === 1 ? '' : 's'} · {e.available_seats} seats left{e.booking_end ? ` · closes ${fmtDateTime(e.booking_end)}` : ''}</span>
                      : e.status === 'Slot Creation' && e.booking_start ? <span>Booking opens {fmtDateTime(e.booking_start)}</span>
                        : e.first_date ? <span>{fmtDate(e.first_date)}{e.last_date !== e.first_date ? ` – ${fmtDate(e.last_date)}` : ''}</span> : null}
                  </div>
                </Link>
              ))}
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </>
        )}
      </AsyncView>
    </>
  );
}

export function StudentExamDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const state = useApi(() => api(`/student/exams/${id}`), [id]);
  const [confirmSlot, setConfirmSlot] = useState(null);
  const [book, booking, bookError, setBookError] = useAction(async (slotId) => {
    const r = await api('/student/bookings', { method: 'POST', body: { slot_id: slotId } });
    navigate(`/student/bookings/${r.booking.id}`, { state: { justBooked: true } });
  });

  return (
    <AsyncView state={state}>
      {({ exam, rubric, slots, my_booking: mine }) => (
        <>
          <PageHeader
            title={exam.name}
            subtitle={`${exam.course_code} — ${exam.course_name}`}
            actions={<Link className="btn" to="/student/exams">← All examinations</Link>}
          />
          <div className="grid-2">
            <Card title="About this examination">
              <dl className="dl">
                <dt>Type</dt><dd>{exam.exam_type}</dd>
                <dt>Status</dt><dd><Badge>{exam.status}</Badge></dd>
                <dt>Duration</dt><dd>{exam.duration_minutes} minutes</dd>
                <dt>Marks</dt><dd>{exam.max_marks} (pass {exam.pass_marks})</dd>
                <dt>Booking window</dt><dd>{exam.booking_start || exam.booking_end ? `${fmtDateTime(exam.booking_start)} → ${fmtDateTime(exam.booking_end)}` : 'Set by the administrator'}</dd>
              </dl>
              {exam.instructions && <><h3>Instructions</h3><p className="pre">{exam.instructions}</p></>}
            </Card>
            <Card title="Evaluation rubric">
              {rubric.length === 0 ? <Empty title="Rubric not published yet" /> : (
                <table className="table compact">
                  <thead><tr><th>Criterion</th><th>Max</th><th>Weight</th></tr></thead>
                  <tbody>{rubric.map((r) => <tr key={r.id}><td>{r.criterion_name}<div className="muted small">{r.description}</div></td><td>{r.max_marks}</td><td>{r.weightage}%</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          </div>

          {mine && (
            <Notice kind="info">
              You are booked for {fmtSlot(mine)} with {mine.examiner_name}. <Link to={`/student/bookings/${mine.id}`}>View booking</Link>
            </Notice>
          )}
          {!exam.booking_open && !mine && <Notice kind="info">Booking is not open for this examination right now.</Notice>}

          <Card title="Slots">
            {slots.length === 0 ? <Empty title="No slots yet">Examiners have not published slots for this examination.</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Time</th><th>Examiner</th><th>Mode</th><th>Seats</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {slots.map((s) => {
                      const canBook = exam.booking_open && !mine && s.status === 'Available' && !s.has_started;
                      return (
                        <tr key={s.id} className={mine?.slot_id === s.id ? 'row-highlight' : ''}>
                          <td>{fmtDate(s.slot_date)}</td>
                          <td>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</td>
                          <td>{s.examiner_name}</td>
                          <td>{s.online ? 'Online' : s.venue || 'In person'}</td>
                          <td>{s.available_seats} / {s.capacity}</td>
                          <td><Badge>{s.status}</Badge></td>
                          <td>{canBook && <button type="button" className="btn btn-small btn-primary" onClick={() => { setBookError(null); setConfirmSlot(s); }}>Book</button>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {confirmSlot && (
            <Modal title="Confirm booking" onClose={() => { setConfirmSlot(null); state.reload(); }}>
              <p>Book <strong>{exam.name}</strong> on <strong>{fmtSlot(confirmSlot)}</strong> with {confirmSlot.examiner_name}?</p>
              <p className="muted small">You can hold only one booking per examination. You may cancel until booking closes{exam.booking_end ? ` (${fmtDateTime(exam.booking_end)})` : ''}.</p>
              <ErrorBox error={bookError} />
              {bookError?.status === 409 && <p className="muted small">Someone may have taken the last seat a moment ago — close this and pick another slot.</p>}
              <div className="actions end">
                <button type="button" className="btn" onClick={() => { setConfirmSlot(null); state.reload(); }}>Cancel</button>
                <button type="button" className="btn btn-primary" disabled={booking} onClick={() => book(confirmSlot.id)}>{booking ? 'Booking…' : 'Confirm booking'}</button>
              </div>
            </Modal>
          )}
        </>
      )}
    </AsyncView>
  );
}

// ================================================================== bookings
export function StudentBookings() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status]);
  const state = useApi(() => api(`/student/bookings${qs({ status, page })}`), [status, page]);
  return (
    <>
      <PageHeader title="My bookings" />
      <div className="toolbar">
        <div className="tabs">
          {['', 'Booked', 'Completed', 'Cancelled'].map((s) => (
            <button type="button" key={s || 'all'} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s || 'All'}</button>
          ))}
        </div>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No bookings">Your bookings will appear here.</Empty>}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Examination</th><th>Slot</th><th>Examiner</th><th>Status</th><th>Marks</th><th /></tr></thead>
                <tbody>
                  {d.items.map((b) => (
                    <tr key={b.id}>
                      <td><strong>{b.exam_name}</strong><div className="muted small">{b.course_code} · {b.exam_type}</div></td>
                      <td>{fmtSlot(b)}</td>
                      <td>{b.examiner_name}</td>
                      <td><Badge>{b.status}</Badge></td>
                      <td>{b.results_published ? (b.evaluation_status === 'Absent' ? 'Absent' : fmtMarks(b.marks, b.max_marks)) : <span className="muted">—</span>}</td>
                      <td><Link to={`/student/bookings/${b.id}`}>Details</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
    </>
  );
}

const EVENT_LABEL = {
  BOOKED: 'Booked', CANCELLED: 'Cancelled', RESCHEDULED: 'Rescheduled', EXAMINER_CHANGED: 'Examiner changed',
  MARKED_ABSENT: 'Marked absent', EVALUATED: 'Evaluated', COMPLETED: 'Completed',
};

export function BookingTimeline({ events }) {
  return (
    <ol className="timeline">
      {events.map((e) => (
        <li key={e.id}>
          <strong>{EVENT_LABEL[e.event_type] || e.event_type}</strong>
          <span className="muted small"> · {fmtDateTime(e.created_at)}{e.actor_name ? ` · by ${e.actor_name}${e.actor_role ? ` (${e.actor_role})` : ''}` : ''}</span>
          {(e.event_type === 'RESCHEDULED' || e.event_type === 'EXAMINER_CHANGED') && (
            <div className="small">
              {e.from_date && e.to_date && (e.from_date !== e.to_date || e.from_start !== e.to_start) && <>From {fmtDate(e.from_date)} {fmtTime(e.from_start)} to {fmtDate(e.to_date)} {fmtTime(e.to_start)}. </>}
              {e.from_examiner && e.to_examiner && e.from_examiner !== e.to_examiner && <>Examiner {e.from_examiner} → {e.to_examiner}. </>}
            </div>
          )}
          {e.reason && <div className="small muted">Reason: {e.reason}</div>}
        </li>
      ))}
    </ol>
  );
}

export function StudentBookingDetail() {
  const { id } = useParams();
  const location = useLocation();
  const state = useApi(() => api(`/student/bookings/${id}`), [id]);
  const [notice, setNotice] = useState(location.state?.justBooked ? 'Booking confirmed.' : null);
  const [reason, setReason] = useState('');
  const [cancel, cancelling, cancelError] = useAction(async () => {
    await api(`/student/bookings/${id}/cancel`, { method: 'POST', body: reason ? { reason } : {} });
    setNotice('Booking cancelled. The seat has been released.');
    state.reload();
  });

  return (
    <AsyncView state={state}>
      {({ booking: b, events, scores }) => (
        <>
          <PageHeader title={b.exam_name} subtitle={`${b.course_code} — ${b.course_name}`} actions={<Link className="btn" to="/student/bookings">← My bookings</Link>} />
          <Notice onClose={() => setNotice(null)}>{notice}</Notice>
          <div className="grid-2">
            <Card title="Booking">
              <dl className="dl">
                <dt>Status</dt><dd><Badge>{b.status}</Badge> {b.attendance !== 'Pending' && <Badge>{b.attendance}</Badge>}</dd>
                <dt>Date & time</dt><dd>{fmtSlot(b)}</dd>
                <dt>Examiner</dt><dd>{b.examiner_name}</dd>
                <dt>Where</dt><dd>{b.meeting_link ? <a href={b.meeting_link} target="_blank" rel="noreferrer">{b.meeting_link}</a> : b.venue || '—'}</dd>
                <dt>Booked on</dt><dd>{fmtDateTime(b.booked_at)}</dd>
                {b.cancelled_at && <><dt>Cancelled</dt><dd>{fmtDateTime(b.cancelled_at)}{b.cancel_reason ? ` — ${b.cancel_reason}` : ''}</dd></>}
              </dl>
              {b.instructions && b.status === 'Booked' && <><h3>Instructions</h3><p className="pre">{b.instructions}</p></>}
              {b.can_cancel && (
                <div className="cancel-box">
                  <ErrorBox error={cancelError} />
                  <Field label="Reason for cancelling (optional)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <ConfirmButton className="btn btn-danger" confirm="Cancel this booking?" onConfirm={cancel} disabled={cancelling}>
                    {cancelling ? 'Cancelling…' : 'Cancel booking'}
                  </ConfirmButton>
                  <p className="muted small">{b.booking_end ? `You can cancel until ${fmtDateTime(b.booking_end)}.` : 'You can cancel while booking is open.'}</p>
                </div>
              )}
            </Card>
            <Card title="History">
              <BookingTimeline events={events} />
            </Card>
          </div>
          {b.results_published && b.evaluation_status && (
            <Card title="Result">
              <ResultBreakdown result={{ total_marks: b.marks, max_marks: b.max_marks, pass_marks: b.pass_marks, remarks: b.remarks, status: b.evaluation_status, scores }} />
            </Card>
          )}
        </>
      )}
    </AsyncView>
  );
}

// ================================================================== history + export
export function StudentHistory() {
  const state = useApi(() => api('/student/history'), []);
  const exports = useApi(() => api('/student/exports'), []);
  const [job, setJob] = useState(null);
  const timer = useRef(null);
  const [start, starting, startError] = useAction(async () => {
    const r = await api('/student/exports', { method: 'POST' });
    setJob(r.job);
  });

  // poll the job until it finishes (the alert arrives as a notification + email too)
  useEffect(() => {
    if (!job || ['Completed', 'Failed'].includes(job.status)) return undefined;
    timer.current = setTimeout(async () => {
      const r = await api(`/student/exports/${job.id}`).catch(() => null);
      if (r) setJob(r.job);
      if (r && ['Completed', 'Failed'].includes(r.job.status)) exports.reload();
    }, 1200);
    return () => clearTimeout(timer.current);
  }, [job]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHeader
        title="Examination history"
        actions={<button type="button" className="btn btn-primary" onClick={start} disabled={starting || (job && !['Completed', 'Failed'].includes(job.status))}>Export as CSV</button>}
      />
      <ErrorBox error={startError} />
      {job && (
        <Notice kind={job.status === 'Failed' ? 'error' : job.status === 'Completed' ? 'success' : 'info'} onClose={() => setJob(null)}>
          {job.status === 'Completed'
            ? <>Export ready ({job.row_count} rows). <button type="button" className="link" onClick={() => download(`/student/exports/${job.id}/download`, 'history.csv')}>Download CSV</button></>
            : job.status === 'Failed' ? `Export failed: ${job.error || 'unknown error'}` : 'Preparing your export in the background… You will also get a notification and an email.'}
        </Notice>
      )}
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No examination history yet" />}>
        {(d) => (
          <>
            <div className="stats">
              <Stat label="Bookings" value={d.summary.total} />
              <Stat label="Completed" value={d.summary.completed} tone="green" />
              <Stat label="Cancelled" value={d.summary.cancelled} />
              <Stat label="Average score" value={d.summary.average_percent !== null ? `${d.summary.average_percent}%` : '—'} tone="purple" />
            </div>
            <Card>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Examination</th><th>Course</th><th>Examiner</th><th>Booking</th><th>Marks</th></tr></thead>
                  <tbody>
                    {d.items.map((b) => (
                      <tr key={b.id}>
                        <td>{fmtDate(b.slot_date)}</td>
                        <td><Link to={`/student/bookings/${b.id}`}>{b.exam_name}</Link></td>
                        <td>{b.course_code}</td>
                        <td>{b.examiner_name}</td>
                        <td><Badge>{b.status}</Badge></td>
                        <td>{b.results_published ? (b.evaluation_status === 'Absent' ? 'Absent' : fmtMarks(b.marks, b.max_marks)) : <span className="muted">Not published</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </AsyncView>
      {exports.data?.items.length > 0 && (
        <Card title="Previous exports">
          <ul className="list">
            {exports.data.items.map((x) => (
              <li key={x.id}>
                <span>{fmtDateTime(x.created_at)}</span> <Badge>{x.status}</Badge>
                {x.status === 'Completed' && <button type="button" className="link" onClick={() => download(`/student/exports/${x.id}/download`, x.file_name)}>Download ({x.row_count} rows)</button>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

// ================================================================== results
function ResultBreakdown({ result: r }) {
  const passed = r.status === 'Submitted' && r.total_marks >= r.pass_marks;
  return (
    <div>
      <div className="result-head">
        <div className="result-score">{r.status === 'Absent' ? 'Absent' : fmtMarks(r.total_marks, r.max_marks)}</div>
        {r.status === 'Submitted' && <Badge>{passed ? 'Pass' : 'Fail'}</Badge>}
      </div>
      {r.scores?.length > 0 && (
        <table className="table compact">
          <thead><tr><th>Criterion</th><th>Marks</th><th>Weight</th><th>Comment</th></tr></thead>
          <tbody>{r.scores.map((s) => <tr key={s.criterion_name}><td>{s.criterion_name}</td><td>{fmtMarks(s.marks, s.max_marks)}</td><td>{s.weightage}%</td><td>{s.comment || '—'}</td></tr>)}</tbody>
        </table>
      )}
      {r.remarks && <><h3>Examiner feedback</h3><p className="pre">{r.remarks}</p></>}
    </div>
  );
}

export function StudentResults() {
  const state = useApi(() => api('/student/results'), []);
  return (
    <>
      <PageHeader title="Results" subtitle="Results appear here once the administrator publishes them." />
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No published results yet" />}>
        {(d) => d.items.map((r) => (
          <Card key={r.evaluation_id} title={`${r.exam_name}`} actions={<span className="muted">{r.course_code} · {fmtDate(r.slot_date)} · {r.examiner_name}</span>}>
            <ResultBreakdown result={r} />
          </Card>
        ))}
      </AsyncView>
    </>
  );
}

// ================================================================== profile
export function StudentProfile() {
  const { setUser, user } = useAuth();
  const state = useApi(() => api('/student/profile'), []);
  return (
    <>
      <PageHeader title="Profile" />
      <AsyncView state={state}>
        {(d) => (
          <div className="grid-2">
            <ProfileForm profile={d.profile} onSaved={(p) => setUser({ ...user, full_name: p.full_name })} />
            <PasswordForm />
          </div>
        )}
      </AsyncView>
    </>
  );
}

function ProfileForm({ profile, onSaved }) {
  const { values, bind } = useForm({
    full_name: profile.full_name, phone: profile.phone || '', department: profile.department || '', program: profile.program || '',
    year_of_study: profile.year_of_study || '', gchat_webhook_url: profile.gchat_webhook_url || '', email_reminders: profile.email_reminders,
  });
  const [ok, setOk] = useState(null);
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    const body = { ...values, year_of_study: values.year_of_study ? Number(values.year_of_study) : null };
    const r = await api('/student/profile', { method: 'PUT', body });
    setOk('Profile saved.');
    onSaved(r.profile);
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <Card title="Your details">
      <form onSubmit={save}>
        <Notice onClose={() => setOk(null)}>{ok}</Notice>
        <ErrorBox error={error} />
        <dl className="dl"><dt>Email</dt><dd>{profile.email}</dd><dt>Roll number</dt><dd>{profile.roll_number}</dd></dl>
        <Field label="Full name" required error={fe.full_name} {...bind('full_name')} />
        <div className="grid-2">
          <Field label="Phone" error={fe.phone} {...bind('phone')} />
          <Field label="Department" error={fe.department} {...bind('department')} />
        </div>
        <div className="grid-2">
          <Field label="Programme" error={fe.program} {...bind('program')} />
          <Field label="Year of study" as="select" error={fe.year_of_study} {...bind('year_of_study')}>
            <option value="">—</option>{[1, 2, 3, 4, 5, 6].map((y) => <option key={y} value={y}>{y}</option>)}
          </Field>
        </div>
        <Field label="Google Chat webhook (optional)" error={fe.gchat_webhook_url} hint="Daily reminders are posted here if set" {...bind('gchat_webhook_url')} />
        <label className="check"><input {...bind('email_reminders', { type: 'checkbox' })} /> Email me examination reminders</label>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button>
      </form>
    </Card>
  );
}

export function PasswordForm() {
  const { values, bind, setValues } = useForm({ current_password: '', new_password: '' });
  const [ok, setOk] = useState(null);
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    await api('/auth/change-password', { method: 'POST', body: values });
    setValues({ current_password: '', new_password: '' });
    setOk('Password changed.');
  });
  return (
    <Card title="Change password">
      <form onSubmit={save}>
        <Notice onClose={() => setOk(null)}>{ok}</Notice>
        <ErrorBox error={error} />
        <Field label="Current password" type="password" autoComplete="current-password" {...bind('current_password')} />
        <Field label="New password" type="password" autoComplete="new-password" hint="At least 8 characters with a letter and a digit" {...bind('new_password')} />
        <button type="submit" className="btn" disabled={saving || !values.current_password || !values.new_password}>Change password</button>
      </form>
    </Card>
  );
}
