import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import {
  AsyncView, Badge, Card, ConfirmButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Pagination, SearchBox, Stat,
  fmtDate, fmtDateTime, fmtMarks, fmtSlot, fmtTime, useAction, useApi, useDebounced, useForm,
} from '../../components/ui';

// ================================================================== dashboard
export function ExaminerDashboard() {
  const state = useApi(() => api('/examiner/dashboard'), []);
  return (
    <>
      <PageHeader title="Examiner dashboard" />
      <AsyncView state={state}>
        {(d) => (
          <>
            <div className="stats">
              <Stat label="Assigned examinations" value={d.counts.assigned_exams} />
              <Stat label="Slots created" value={d.counts.slots_created} hint={`${d.counts.upcoming_slots} upcoming`} tone="blue" />
              <Stat label="Booked students" value={d.counts.booked_students} tone="green" />
              <Stat label="Pending evaluations" value={d.counts.pending_evaluations} tone={d.counts.pending_evaluations ? 'amber' : undefined} />
            </div>
            <div className="grid-2">
              <Card title="Assigned examinations" actions={<Link to="/examiner/exams">All</Link>}>
                {d.exams.length === 0 ? <Empty title="No active assignments" /> : (
                  <ul className="list">
                    {d.exams.map((e) => (
                      <li key={e.id}>
                        <Link to={`/examiner/exams/${e.id}`}><strong>{e.name}</strong></Link>
                        <span className="muted">{e.course_code} · {e.my_slots} of my slots</span>
                        <Badge>{e.status}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="Pending evaluations" actions={<Link to="/examiner/students?evaluation=pending">All pending</Link>}>
                {d.pending.length === 0 ? <Empty title="Nothing to evaluate" /> : (
                  <ul className="list">
                    {d.pending.map((p) => (
                      <li key={p.booking_id}>
                        <Link to={`/examiner/evaluate/${p.booking_id}`}><strong>{p.student_name}</strong></Link>
                        <span className="muted">{p.roll_number} · {p.exam_name} · {fmtDate(p.slot_date)} {fmtTime(p.start_time)}</span>
                        {p.evaluation_status === 'Draft' && <Badge>Draft</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
            <Card title="My slots in the next 7 days">
              {d.upcoming_slots.length === 0 ? <Empty title="No upcoming slots" /> : (
                <ul className="list">
                  {d.upcoming_slots.map((s) => (
                    <li key={s.id}>
                      <strong>{s.exam_name}</strong>
                      <span>{fmtSlot(s)}</span>
                      <span className="muted">{s.booked_count}/{s.capacity} booked · {s.meeting_link ? 'online' : s.venue || '—'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </>
        )}
      </AsyncView>
    </>
  );
}

// ================================================================== assigned exams
export function ExaminerExams() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq]);
  const state = useApi(() => api(`/examiner/exams${qs({ q: dq, page })}`), [dq, page]);
  return (
    <>
      <PageHeader title="My examinations" />
      <div className="toolbar"><SearchBox value={q} onChange={setQ} placeholder="Search examinations" /></div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="You are not assigned to any examination yet" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Examination</th><th>Status</th><th>Slot creation</th><th>My slots</th><th>Booked</th><th>Pending</th><th /></tr></thead>
                <tbody>
                  {d.items.map((e) => (
                    <tr key={e.id}>
                      <td><strong>{e.name}</strong><div className="muted small">{e.course_code} · {e.exam_type} · {e.duration_minutes} min</div></td>
                      <td><Badge>{e.status}</Badge></td>
                      <td>{e.slot_creation_open ? <Badge tone="green">Open until {fmtDateTime(e.slot_creation_end)}</Badge> : <span className="muted">Closed</span>}</td>
                      <td>{e.my_slots}</td>
                      <td>{e.my_bookings}</td>
                      <td>{e.my_pending > 0 ? <Badge tone="amber">{e.my_pending}</Badge> : 0}</td>
                      <td><Link to={`/examiner/exams/${e.id}`}>Manage</Link></td>
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

function SlotForm({ examId, slot, onDone, onCancel }) {
  const { values, bind } = useForm({
    slot_date: slot?.slot_date || '', start_time: slot ? fmtTime(slot.start_time) : '', end_time: slot ? fmtTime(slot.end_time) : '',
    capacity: slot?.capacity ?? 1, venue: slot?.venue || '', meeting_link: slot?.meeting_link || '', notes: slot?.notes || '',
  });
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    const body = { ...values, capacity: Number(values.capacity) };
    if (slot) await api(`/examiner/slots/${slot.id}`, { method: 'PUT', body });
    else await api('/examiner/slots', { method: 'POST', body: { ...body, exam_id: Number(examId) } });
    onDone(slot ? 'Slot updated.' : 'Slot created.');
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <div className="grid-3">
        <Field label="Date" type="date" required error={fe.slot_date} {...bind('slot_date')} />
        <Field label="Start" type="time" required error={fe.start_time} {...bind('start_time')} />
        <Field label="End" type="time" required error={fe.end_time} {...bind('end_time')} />
      </div>
      <div className="grid-3">
        <Field label="Capacity" type="number" min="1" max="200" required error={fe.capacity} {...bind('capacity')} />
        <Field label="Venue" error={fe.venue} {...bind('venue')} />
        <Field label="Meeting link" placeholder="https://…" error={fe.meeting_link} {...bind('meeting_link')} />
      </div>
      <Field label="Notes" as="textarea" rows={2} error={fe.notes} {...bind('notes')} />
      <div className="actions end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : slot ? 'Save slot' : 'Create slot'}</button>
      </div>
    </form>
  );
}

export function ExaminerExamDetail() {
  const { id } = useParams();
  const state = useApi(() => api(`/examiner/exams/${id}`), [id]);
  const [editing, setEditing] = useState(null); // null | 'new' | slot
  const [viewing, setViewing] = useState(null);
  const [notice, setNotice] = useState(null);
  const [act, acting, actError] = useAction(async (fn, msg) => { await fn(); setNotice(msg); state.reload(); });

  return (
    <AsyncView state={state}>
      {({ exam, rubric, slots }) => (
        <>
          <PageHeader
            title={exam.name}
            subtitle={`${exam.course_code} — ${exam.course_name} · ${exam.exam_type} · ${exam.duration_minutes} min`}
            actions={(
              <>
                {exam.slot_creation_open && <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>New slot</button>}
                {exam.status === 'Closed' && (
                  <ConfirmButton className="btn" confirm="Complete all your slots for this exam?" disabled={acting}
                    onConfirm={() => act(() => api(`/examiner/exams/${id}/complete`, { method: 'POST' }), 'Your part of the examination is marked completed.')}>
                    Mark examination completed
                  </ConfirmButton>
                )}
              </>
            )}
          />
          <Notice onClose={() => setNotice(null)}>{notice}</Notice>
          <ErrorBox error={actError} />
          <div className="grid-2">
            <Card title="Timeline">
              <dl className="dl">
                <dt>Status</dt><dd><Badge>{exam.status}</Badge></dd>
                <dt>Slot creation</dt><dd>{fmtDateTime(exam.slot_creation_start)} → {fmtDateTime(exam.slot_creation_end)} {exam.slot_creation_open ? <Badge tone="green">open now</Badge> : <Badge tone="grey">closed</Badge>}</dd>
                <dt>Student booking</dt><dd>{fmtDateTime(exam.booking_start)} → {fmtDateTime(exam.booking_end)}</dd>
              </dl>
              <p className="muted small">You can create slots only while slot creation is open, and edit or remove them only until student booking begins.</p>
            </Card>
            <Card title="Rubric">
              {rubric.length === 0 ? <Empty title="No rubric yet" /> : (
                <table className="table compact">
                  <thead><tr><th>Criterion</th><th>Max</th><th>Weight</th></tr></thead>
                  <tbody>{rubric.map((r) => <tr key={r.id}><td>{r.criterion_name}</td><td>{r.max_marks}</td><td>{r.weightage}%</td></tr>)}</tbody>
                </table>
              )}
            </Card>
          </div>
          <Card title={`My slots (${slots.length})`}>
            {slots.length === 0 ? <Empty title="No slots yet">{exam.slot_creation_open ? 'Create your first slot.' : 'Slot creation is not open.'}</Empty> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Date</th><th>Time</th><th>Booked</th><th>Status</th><th>Where</th><th /></tr></thead>
                  <tbody>
                    {slots.map((s) => (
                      <tr key={s.id}>
                        <td>{fmtDate(s.slot_date)}</td>
                        <td>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</td>
                        <td>{s.booked_count} / {s.capacity}</td>
                        <td><Badge>{s.status}</Badge></td>
                        <td>{s.meeting_link ? <a href={s.meeting_link} target="_blank" rel="noreferrer">Online</a> : s.venue || '—'}</td>
                        <td className="actions">
                          <button type="button" className="btn btn-small" onClick={() => setViewing(s)}>Students</button>
                          {s.editable && <button type="button" className="btn btn-small" onClick={() => setEditing(s)}>Edit</button>}
                          {s.editable && (
                            <ConfirmButton className="btn btn-small btn-danger" confirm="Delete slot?"
                              onConfirm={() => act(() => api(`/examiner/slots/${s.id}`, { method: 'DELETE' }), 'Slot removed.')}>Delete</ConfirmButton>
                          )}
                          {s.has_started && ['Available', 'Full'].includes(s.status) && (
                            <button type="button" className="btn btn-small" disabled={acting}
                              onClick={() => act(() => api(`/examiner/slots/${s.id}/complete`, { method: 'POST' }), 'Slot marked completed.')}>Complete</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {editing && (
            <Modal title={editing === 'new' ? 'New slot' : 'Edit slot'} onClose={() => setEditing(null)}>
              <SlotForm examId={id} slot={editing === 'new' ? null : editing} onCancel={() => setEditing(null)}
                onDone={(m) => { setEditing(null); setNotice(m); state.reload(); }} />
            </Modal>
          )}
          {viewing && <SlotStudents slot={viewing} onClose={() => setViewing(null)} />}
        </>
      )}
    </AsyncView>
  );
}

function SlotStudents({ slot, onClose }) {
  const state = useApi(() => api(`/examiner/slots/${slot.id}/bookings`), [slot.id]);
  return (
    <Modal title={`Students · ${fmtSlot(slot)}`} onClose={onClose} wide>
      <AsyncView state={state} isEmpty={(d) => d.bookings.length === 0} empty={<Empty title="No students booked" />}>
        {(d) => (
          <table className="table">
            <thead><tr><th>Student</th><th>Roll no.</th><th>Booking</th><th>Evaluation</th><th /></tr></thead>
            <tbody>
              {d.bookings.map((b) => (
                <tr key={b.id}>
                  <td>{b.student_name}<div className="muted small">{b.email}</div></td>
                  <td>{b.roll_number}</td>
                  <td><Badge>{b.status}</Badge></td>
                  <td>{b.evaluation_status ? <Badge>{b.evaluation_status}</Badge> : <span className="muted">Not started</span>}</td>
                  <td>{d.slot.has_started && <Link to={`/examiner/evaluate/${b.id}`}>Evaluate</Link>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </AsyncView>
    </Modal>
  );
}

// ================================================================== all my slots
export function ExaminerSlots() {
  const [status, setStatus] = useState('');
  const [upcoming, setUpcoming] = useState(true);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [status, upcoming]);
  const state = useApi(() => api(`/examiner/slots${qs({ status, upcoming: upcoming ? 'true' : '', page })}`), [status, upcoming, page]);
  return (
    <>
      <PageHeader title="My slots" />
      <div className="toolbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>{['Available', 'Full', 'Completed', 'Cancelled'].map((s) => <option key={s}>{s}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={upcoming} onChange={(e) => setUpcoming(e.target.checked)} /> Upcoming only</label>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No slots" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Examination</th><th>Date</th><th>Time</th><th>Booked</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {d.items.map((s) => (
                    <tr key={s.id}>
                      <td>{s.exam_name}<div className="muted small">{s.course_code}</div></td>
                      <td>{fmtDate(s.slot_date)}</td>
                      <td>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</td>
                      <td>{s.booked_count}/{s.capacity}</td>
                      <td><Badge>{s.status}</Badge></td>
                      <td><Link to={`/examiner/exams/${s.exam_id}`}>Open exam</Link></td>
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

// ================================================================== booked students
export function ExaminerStudents() {
  const [params] = useSearchParams();
  const initial = params.get('evaluation') || '';
  const [q, setQ] = useState('');
  const [evaluation, setEvaluation] = useState(initial);
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, evaluation]);
  const state = useApi(() => api(`/examiner/bookings${qs({ q: dq, evaluation, page })}`), [dq, evaluation, page]);
  return (
    <>
      <PageHeader title="Booked students" />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search by name, roll number or email" />
        <div className="tabs">
          {[['', 'All'], ['pending', 'Pending'], ['done', 'Evaluated']].map(([v, l]) => (
            <button type="button" key={l} className={evaluation === v ? 'active' : ''} onClick={() => setEvaluation(v)}>{l}</button>
          ))}
        </div>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No students" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Student</th><th>Examination</th><th>Slot</th><th>Evaluation</th><th>Marks</th><th /></tr></thead>
                <tbody>
                  {d.items.map((b) => (
                    <tr key={b.id}>
                      <td><strong>{b.student_name}</strong><div className="muted small">{b.roll_number}</div></td>
                      <td>{b.exam_name}<div className="muted small">{b.course_code}</div></td>
                      <td>{fmtSlot(b)}</td>
                      <td>{b.evaluation_status ? <Badge>{b.evaluation_status}</Badge> : <span className="muted">Not started</span>}</td>
                      <td>{fmtMarks(b.total_marks, b.max_marks)}</td>
                      <td>{b.has_started ? <Link to={`/examiner/evaluate/${b.id}`}>{b.evaluation_status && b.evaluation_status !== 'Draft' ? 'View' : 'Evaluate'}</Link> : <span className="muted small">after slot starts</span>}</td>
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

// ================================================================== evaluation form
export function ExaminerEvaluate() {
  const { bookingId } = useParams();
  const state = useApi(() => api(`/examiner/bookings/${bookingId}/evaluation`), [bookingId]);
  // kept here so the message survives the form re-mounting on the new version
  const [notice, setNotice] = useState(null);
  return (
    <AsyncView state={state}>
      {(d) => <EvaluationForm key={d.evaluation?.version || 0} data={d} reload={state.reload} notice={notice} setNotice={setNotice} />}
    </AsyncView>
  );
}

function EvaluationForm({ data, reload, notice, setNotice }) {
  const { booking: b, rubric, evaluation, scores, versions } = data;
  const initial = useMemo(() => Object.fromEntries(rubric.map((r) => {
    const s = scores.find((x) => x.criterion_id === r.id);
    return [r.id, { marks: s ? String(s.marks) : '', comment: s?.comment || '' }];
  })), [rubric, scores]);
  const [marks, setMarks] = useState(initial);
  const [remarks, setRemarks] = useState(evaluation?.remarks || '');
  const [absentOpen, setAbsentOpen] = useState(false);
  const locked = b.results_published;

  const total = useMemo(() => {
    const w = rubric.reduce((s, r) => s + r.weightage, 0);
    if (!w) return 0;
    const sum = rubric.reduce((s, r) => s + ((Number(marks[r.id]?.marks) || 0) / r.max_marks) * r.weightage, 0);
    return Math.round((sum / w) * b.max_marks * 100) / 100;
  }, [marks, rubric, b.max_marks]);

  const localErrors = Object.fromEntries(rubric.map((r) => {
    const v = marks[r.id]?.marks;
    if (v === '' || v === undefined) return [r.id, null];
    const n = Number(v);
    return [r.id, Number.isNaN(n) || n < 0 ? 'Enter a number ≥ 0' : n > r.max_marks ? `Max ${r.max_marks}` : null];
  }));
  const hasErrors = Object.values(localErrors).some(Boolean);
  const complete = rubric.every((r) => marks[r.id]?.marks !== '');

  const [save, saving, error] = useAction(async (submit) => {
    const body = {
      scores: rubric.filter((r) => marks[r.id]?.marks !== '').map((r) => ({ criterion_id: r.id, marks: Number(marks[r.id].marks), comment: marks[r.id].comment || null })),
      remarks: remarks || null,
      submit,
      ...(evaluation ? { expected_version: evaluation.version } : {}),
    };
    await api(`/examiner/bookings/${b.id}/evaluation`, { method: 'PUT', body });
    setNotice(submit ? 'Evaluation submitted.' : 'Draft saved.');
    reload();
  });
  const [markAbsent, marking, absentError] = useAction(async () => {
    await api(`/examiner/bookings/${b.id}/absent`, { method: 'POST', body: { remarks: remarks || 'Absent', ...(evaluation ? { expected_version: evaluation.version } : {}) } });
    setAbsentOpen(false);
    setNotice('Student marked absent.');
    reload();
  });

  return (
    <>
      <PageHeader
        title={`Evaluate ${b.student_name}`}
        subtitle={`${b.roll_number} · ${b.exam_name} (${b.course_code}) · ${fmtSlot(b)}`}
        actions={<Link className="btn" to="/examiner/students">← Booked students</Link>}
      />
      <Notice onClose={() => setNotice(null)}>{notice}</Notice>
      {locked && <Notice kind="info">Results are published, so this evaluation is read-only.</Notice>}
      {evaluation && <Notice kind="info">Current status: <Badge>{evaluation.status}</Badge> · version {evaluation.version} · last saved {fmtDateTime(evaluation.updated_at)}</Notice>}
      <ErrorBox error={error || absentError} />
      {error?.status === 409 && /changed since/.test(error.message) && (
        <button type="button" className="btn" onClick={reload}>Load latest version</button>
      )}
      <Card title="Rubric scores">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Criterion</th><th>Weight</th><th style={{ width: 130 }}>Marks</th><th>Comment</th></tr></thead>
            <tbody>
              {rubric.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.criterion_name}</strong><div className="muted small">{r.description}</div></td>
                  <td>{r.weightage}%</td>
                  <td>
                    <div className={`field ${localErrors[r.id] ? 'has-error' : ''}`}>
                      <input type="number" min="0" max={r.max_marks} step="0.5" disabled={locked} aria-label={`Marks for ${r.criterion_name}`}
                        value={marks[r.id]?.marks ?? ''} onChange={(e) => setMarks((m) => ({ ...m, [r.id]: { ...m[r.id], marks: e.target.value } }))} />
                      <div className={localErrors[r.id] ? 'field-error' : 'field-hint'}>{localErrors[r.id] || `out of ${r.max_marks}`}</div>
                    </div>
                  </td>
                  <td><input type="text" disabled={locked} aria-label={`Comment for ${r.criterion_name}`} value={marks[r.id]?.comment ?? ''}
                    onChange={(e) => setMarks((m) => ({ ...m, [r.id]: { ...m[r.id], comment: e.target.value } }))} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="total-line">Weighted total: <strong>{fmtMarks(total, b.max_marks)}</strong> <span className="muted">(pass {b.pass_marks})</span></div>
        <Field label="Remarks / feedback for the student" as="textarea" rows={3} name="remarks" disabled={locked} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
        {!locked && (
          <div className="actions end">
            <button type="button" className="btn btn-danger-outline" onClick={() => setAbsentOpen(true)}>Mark absent</button>
            {(!evaluation || evaluation.status === 'Draft') && <button type="button" className="btn" disabled={saving || hasErrors} onClick={() => save(false)}>Save draft</button>}
            <button type="button" className="btn btn-primary" disabled={saving || hasErrors || !complete} onClick={() => save(true)}>
              {evaluation && evaluation.status !== 'Draft' ? 'Resubmit evaluation' : 'Submit evaluation'}
            </button>
          </div>
        )}
      </Card>
      {versions.length > 0 && (
        <Card title="Version history">
          <table className="table compact">
            <thead><tr><th>Version</th><th>Status</th><th>Total</th><th>Saved</th><th>By</th></tr></thead>
            <tbody>{versions.map((v) => <tr key={v.version}><td>{v.version}</td><td><Badge>{v.status}</Badge></td><td>{fmtMarks(v.total_marks)}</td><td>{fmtDateTime(v.created_at)}</td><td>{v.actor_name}</td></tr>)}</tbody>
          </table>
        </Card>
      )}
      {absentOpen && (
        <Modal title="Mark student absent" onClose={() => setAbsentOpen(false)}>
          <p>Record <strong>{b.student_name}</strong> as absent? Their total will be 0.</p>
          <div className="actions end">
            <button type="button" className="btn" onClick={() => setAbsentOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-danger" disabled={marking} onClick={markAbsent}>Mark absent</button>
          </div>
        </Modal>
      )}
    </>
  );
}
