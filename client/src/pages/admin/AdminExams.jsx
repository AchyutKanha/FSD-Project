import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api';
import { BookingTimeline } from '../student/StudentPages';
import {
  AsyncView, Badge, Bar, Card, ConfirmButton, Empty, ErrorBox, Field, Modal, Notice, PageHeader, Pagination, SearchBox, Stat,
  fmtDate, fmtDateTime, fmtMarks, fmtSlot, fmtTime, fromLocalInput, toLocalInput, useAction, useApi, useDebounced, useForm,
} from '../../components/ui';

const EXAM_TYPES = ['Viva', 'Practical', 'Project Demo', 'Assessment'];
const EXAM_STATUSES = ['Draft', 'Slot Creation', 'Booking Open', 'Closed', 'Completed'];

// ================================================================== exam form
function ExamForm({ exam, courses, onDone, onCancel }) {
  const { values, bind } = useForm({
    course_id: exam?.course_id || '', name: exam?.name || '', exam_type: exam?.exam_type || 'Viva',
    description: exam?.description || '', instructions: exam?.instructions || '',
    duration_minutes: exam?.duration_minutes ?? 30, max_marks: exam?.max_marks ?? 100, pass_marks: exam?.pass_marks ?? 40,
    slot_creation_start: toLocalInput(exam?.slot_creation_start), slot_creation_end: toLocalInput(exam?.slot_creation_end),
    booking_start: toLocalInput(exam?.booking_start), booking_end: toLocalInput(exam?.booking_end),
  });
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    const body = {
      ...values,
      course_id: Number(values.course_id),
      duration_minutes: Number(values.duration_minutes),
      max_marks: Number(values.max_marks),
      pass_marks: Number(values.pass_marks),
      slot_creation_start: fromLocalInput(values.slot_creation_start),
      slot_creation_end: fromLocalInput(values.slot_creation_end),
      booking_start: fromLocalInput(values.booking_start),
      booking_end: fromLocalInput(values.booking_end),
    };
    const r = exam
      ? await api(`/admin/exams/${exam.id}`, { method: 'PUT', body })
      : await api('/admin/exams', { method: 'POST', body });
    onDone(r.exam, exam ? 'Examination updated.' : 'Examination created as a draft.');
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <form onSubmit={save}>
      <ErrorBox error={error} />
      <div className="grid-2">
        <Field label="Course" as="select" required error={fe.course_id} disabled={exam && exam.status !== 'Draft'} {...bind('course_id')}>
          <option value="">Select a course</option>
          {courses.filter((c) => c.status === 'Active' || c.id === exam?.course_id).map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
        </Field>
        <Field label="Type" as="select" required error={fe.exam_type} {...bind('exam_type')}>
          {EXAM_TYPES.map((t) => <option key={t}>{t}</option>)}
        </Field>
      </div>
      <Field label="Examination name" required error={fe.name} {...bind('name')} />
      <div className="grid-3">
        <Field label="Duration (minutes)" type="number" min="5" max="600" required error={fe.duration_minutes} {...bind('duration_minutes')} />
        <Field label="Maximum marks" type="number" min="1" required error={fe.max_marks} {...bind('max_marks')} />
        <Field label="Pass marks" type="number" min="0" error={fe.pass_marks} {...bind('pass_marks')} />
      </div>
      <fieldset>
        <legend>Timeline</legend>
        <div className="grid-2">
          <Field label="Slot creation starts" type="datetime-local" error={fe.slot_creation_start} {...bind('slot_creation_start')} />
          <Field label="Slot creation ends" type="datetime-local" error={fe.slot_creation_end} {...bind('slot_creation_end')} />
          <Field label="Booking starts" type="datetime-local" error={fe.booking_start} {...bind('booking_start')} />
          <Field label="Booking ends (cancellation deadline)" type="datetime-local" error={fe.booking_end} {...bind('booking_end')} />
        </div>
        <p className="muted small">Leave a date empty for no limit. Opening/closing each phase is done with the status buttons.</p>
      </fieldset>
      <Field label="Description" as="textarea" rows={2} error={fe.description} {...bind('description')} />
      <Field label="Instructions for students (sent in reminders)" as="textarea" rows={3} error={fe.instructions} {...bind('instructions')} />
      <div className="actions end">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save examination'}</button>
      </div>
    </form>
  );
}

// ================================================================== exam list
export function AdminExams() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({ course_id: params.get('course_id') || '', status: params.get('status') || '', exam_type: '' });
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(params.get('new') === '1');
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, filters]);
  const options = useApi(() => api('/options'), []);
  const state = useApi(() => api(`/admin/exams${qs({ q: dq, page, ...filters })}`), [dq, page, filters]);
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Examinations" actions={<button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>New examination</button>} />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search exam, course" />
        <select value={filters.course_id} onChange={setF('course_id')} aria-label="Course">
          <option value="">All courses</option>
          {options.data?.courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
        </select>
        <select value={filters.status} onChange={setF('status')} aria-label="Status">
          <option value="">Any status</option>{EXAM_STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
        <select value={filters.exam_type} onChange={setF('exam_type')} aria-label="Type">
          <option value="">Any type</option>{EXAM_TYPES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No examinations match" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Examination</th><th>Type</th><th>Status</th><th>Examiners</th><th>Slots</th><th>Bookings</th><th>Rubric</th><th>Results</th></tr></thead>
                <tbody>
                  {d.items.map((e) => (
                    <tr key={e.id}>
                      <td><Link to={`/admin/exams/${e.id}`}><strong>{e.name}</strong></Link><div className="muted small">{e.course_code} — {e.course_name}</div></td>
                      <td>{e.exam_type}</td>
                      <td><Badge>{e.status}</Badge></td>
                      <td>{e.examiner_count}</td>
                      <td>{e.slot_count}</td>
                      <td>{e.booking_count}</td>
                      <td>{e.rubric_weightage === 100 ? <Badge tone="green">100%</Badge> : <Badge tone="amber">{`${e.rubric_weightage}%`}</Badge>}</td>
                      <td>{e.results_published ? <Badge>Published</Badge> : <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {creating && options.data && (
        <Modal title="New examination" wide onClose={() => { setCreating(false); setParams({}); }}>
          <ExamForm courses={options.data.courses} onCancel={() => { setCreating(false); setParams({}); }} onDone={(exam) => navigate(`/admin/exams/${exam.id}`)} />
        </Modal>
      )}
    </>
  );
}

// ================================================================== exam detail
export function AdminExamDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [notice, setNotice] = useState(null);
  const [editing, setEditing] = useState(false);
  const state = useApi(() => api(`/admin/exams/${id}`), [id]);
  const options = useApi(() => api('/options'), []);
  const [act, acting, actError, setActError] = useAction(async (fn, msg) => { await fn(); setNotice(msg); state.reload(); });

  return (
    <AsyncView state={state}>
      {(d) => {
        const e = d.exam;
        return (
          <>
            <PageHeader
              title={e.name}
              subtitle={`${e.course_code} — ${e.course_name} · ${e.exam_type} · ${e.duration_minutes} min · ${e.max_marks} marks`}
              actions={<><Badge>{e.status}</Badge>{e.results_published && <Badge>Published</Badge>}<button type="button" className="btn" onClick={() => setEditing(true)} disabled={e.status === 'Completed'}>Edit details & timeline</button></>}
            />
            <Notice onClose={() => setNotice(null)}>{notice}</Notice>
            <ErrorBox error={actError} />

            <Card title="Workflow">
              <ol className="steps">
                {EXAM_STATUSES.map((s) => <li key={s} className={s === e.status ? 'current' : EXAM_STATUSES.indexOf(s) < EXAM_STATUSES.indexOf(e.status) ? 'done' : ''}>{s}</li>)}
              </ol>
              <div className="actions">
                {d.transitions.map((t) => (
                  <ConfirmButton key={t.to} className={`btn ${t.to === 'Draft' || (t.to === 'Closed' && e.status === 'Completed') ? '' : 'btn-primary'}`} disabled={acting}
                    confirm={`${t.label}?`} onConfirm={() => { setActError(null); act(() => api(`/admin/exams/${id}/status`, { method: 'POST', body: { status: t.to } }), `${t.label}: done.`); }}>
                    {t.label}
                  </ConfirmButton>
                ))}
                {['Closed', 'Completed'].includes(e.status) && !e.results_published && (
                  <ConfirmButton className="btn btn-primary" confirm="Publish results to students?" disabled={acting}
                    onConfirm={() => act(() => api(`/admin/exams/${id}/publish`, { method: 'POST' }), 'Results published. Students have been notified.')}>Publish results</ConfirmButton>
                )}
                {e.results_published && (
                  <ConfirmButton className="btn" confirm="Hide results from students?" disabled={acting}
                    onConfirm={() => act(() => api(`/admin/exams/${id}/unpublish`, { method: 'POST' }), 'Results unpublished.')}>Unpublish results</ConfirmButton>
                )}
                {e.status === 'Draft' && e.slot_count === 0 && (
                  <ConfirmButton className="btn btn-danger" confirm="Delete this draft?"
                    onConfirm={() => act(async () => { await api(`/admin/exams/${id}`, { method: 'DELETE' }); navigate('/admin/exams'); }, 'Deleted')}>Delete draft</ConfirmButton>
                )}
              </div>
            </Card>

            <div className="tabs tabs-underline">
              {[['overview', 'Overview'], ['examiners', `Examiners (${d.examiners.length})`], ['rubric', `Rubric (${e.rubric_weightage}%)`], ['slots', `Slots (${e.slot_count})`], ['results', 'Results']].map(([k, l]) => (
                <button type="button" key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>

            {tab === 'overview' && (
              <>
                <div className="stats">
                  <Stat label="Active bookings" value={d.stats.booked} tone="blue" />
                  <Stat label="Completed" value={d.stats.completed} tone="green" />
                  <Stat label="Cancelled" value={d.stats.cancelled} />
                  <Stat label="Evaluated" value={d.stats.evaluated} hint={`${d.stats.absent} absent · ${d.stats.drafts} drafts`} />
                  <Stat label="Average marks" value={d.stats.average ?? '—'} hint={d.stats.highest !== null ? `high ${d.stats.highest} · low ${d.stats.lowest}` : undefined} tone="purple" />
                </div>
                <div className="grid-2">
                  <Card title="Timeline">
                    <dl className="dl">
                      <dt>Slot creation</dt><dd>{fmtDateTime(e.slot_creation_start)} → {fmtDateTime(e.slot_creation_end)}</dd>
                      <dt>Student booking</dt><dd>{fmtDateTime(e.booking_start)} → {fmtDateTime(e.booking_end)}</dd>
                      <dt>Pass marks</dt><dd>{e.pass_marks} / {e.max_marks}</dd>
                    </dl>
                    {e.instructions && <><h3>Instructions</h3><p className="pre">{e.instructions}</p></>}
                  </Card>
                  <Card title="Status history">
                    <ol className="timeline">
                      {d.history.map((h) => (
                        <li key={h.id}><strong>{h.from_status && h.from_status !== h.to_status ? `${h.from_status} → ` : ''}{h.to_status}</strong>
                          <span className="muted small"> · {fmtDateTime(h.created_at)}{h.actor_name ? ` · ${h.actor_name}` : ''}</span>
                          {h.note && <div className="small muted">{h.note}</div>}</li>
                      ))}
                    </ol>
                  </Card>
                </div>
              </>
            )}
            {tab === 'examiners' && <ExamExaminers exam={e} assigned={d.examiners} onChanged={(m) => { setNotice(m); state.reload(); }} />}
            {tab === 'rubric' && <RubricEditor exam={e} rubric={d.rubric} onChanged={() => state.reload()} />}
            {tab === 'slots' && <SlotsTable fixedExamId={e.id} />}
            {tab === 'results' && <ExamResults examId={e.id} maxMarks={e.max_marks} />}

            {editing && options.data && (
              <Modal title="Edit examination" wide onClose={() => setEditing(false)}>
                <ExamForm exam={e} courses={options.data.courses} onCancel={() => setEditing(false)} onDone={(_x, m) => { setEditing(false); setNotice(m); state.reload(); }} />
              </Modal>
            )}
          </>
        );
      }}
    </AsyncView>
  );
}

function ExamExaminers({ exam, assigned, onChanged }) {
  const all = useApi(() => api('/admin/examiners?all=true&status=Active'), []);
  const [selected, setSelected] = useState(() => new Set(assigned.map((x) => x.id)));
  const [filter, setFilter] = useState('');
  const [save, saving, error] = useAction(async () => {
    const r = await api(`/admin/exams/${exam.id}/examiners`, { method: 'PUT', body: { examiner_ids: [...selected] } });
    onChanged(`Examiners saved (${r.added} added, ${r.removed} removed).`);
  });
  const toggle = (xid) => setSelected((s) => { const n = new Set(s); if (n.has(xid)) n.delete(xid); else n.add(xid); return n; });
  return (
    <Card title="Assigned examiners" actions={<button type="button" className="btn btn-primary" onClick={save} disabled={saving || exam.status === 'Completed'}>{saving ? 'Saving…' : 'Save assignment'}</button>}>
      <ErrorBox error={error} />
      <p className="muted small">Examiners who already have slots for this examination cannot be removed; move or reassign their slots first.</p>
      <SearchBox value={filter} onChange={setFilter} placeholder="Filter examiners" />
      <AsyncView state={all}>
        {(d) => (
          <div className="checklist">
            {d.items.filter((x) => !filter || `${x.full_name} ${x.department}`.toLowerCase().includes(filter.toLowerCase())).map((x) => {
              const a = assigned.find((y) => y.id === x.id);
              return (
                <label key={x.id} className="check">
                  <input type="checkbox" checked={selected.has(x.id)} onChange={() => toggle(x.id)} />
                  <span><strong>{x.full_name}</strong> <span className="muted small">{x.department}{a ? ` · ${a.slots} slots` : ''}</span></span>
                </label>
              );
            })}
          </div>
        )}
      </AsyncView>
    </Card>
  );
}

function RubricEditor({ exam, rubric, onChanged }) {
  const blank = { criterion_name: '', max_marks: 10, weightage: '', description: '' };
  const [editing, setEditing] = useState(null);
  const total = rubric.reduce((s, r) => s + r.weightage, 0);
  const { values, bind, setValues } = useForm(blank);
  const [save, saving, error, setError] = useAction(async (e) => {
    e.preventDefault();
    const body = { ...values, max_marks: Number(values.max_marks), weightage: Number(values.weightage), description: values.description || null };
    if (editing && editing !== 'new') await api(`/admin/rubrics/${editing.id}`, { method: 'PUT', body });
    else await api(`/admin/exams/${exam.id}/rubrics`, { method: 'POST', body });
    setEditing(null);
    onChanged();
  });
  const [remove, , removeError] = useAction(async (r) => { await api(`/admin/rubrics/${r.id}`, { method: 'DELETE' }); onChanged(); });
  const open = (r) => { setError(null); setValues(r === 'new' ? { ...blank, weightage: Math.max(0, 100 - total) || '' } : { criterion_name: r.criterion_name, max_marks: r.max_marks, weightage: r.weightage, description: r.description || '' }); setEditing(r); };
  const fe = error?.fieldErrors ? error.fieldErrors() : {};

  return (
    <Card title="Evaluation rubric" actions={<button type="button" className="btn btn-primary" onClick={() => open('new')} disabled={total >= 100}>Add criterion</button>}>
      <ErrorBox error={removeError} />
      <div className={`weight-meter ${total === 100 ? 'ok' : ''}`}>
        <Bar value={total} max={100} label={`Total weightage ${total}% ${total === 100 ? '✓' : '(must be exactly 100% before booking opens)'}`} />
      </div>
      {rubric.length === 0 ? <Empty title="No criteria yet" /> : (
        <table className="table">
          <thead><tr><th>Criterion</th><th>Max marks</th><th>Weightage</th><th /></tr></thead>
          <tbody>
            {rubric.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.criterion_name}</strong><div className="muted small">{r.description}</div></td>
                <td>{r.max_marks}</td>
                <td>{r.weightage}%</td>
                <td className="actions">
                  <button type="button" className="btn btn-small" onClick={() => open(r)}>Edit</button>
                  <ConfirmButton className="btn btn-small btn-danger" confirm="Remove?" onConfirm={() => remove(r)}>Remove</ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">Total marks = maximum marks × Σ(score ÷ criterion max × weightage) ÷ 100. The rubric locks once any evaluation is recorded.</p>
      {editing && (
        <Modal title={editing === 'new' ? 'Add criterion' : 'Edit criterion'} onClose={() => setEditing(null)}>
          <form onSubmit={save}>
            <ErrorBox error={error} />
            <Field label="Criterion" required error={fe.criterion_name} {...bind('criterion_name')} />
            <div className="grid-2">
              <Field label="Maximum marks" type="number" min="0.5" step="0.5" required error={fe.max_marks} {...bind('max_marks')} />
              <Field label="Weightage (%)" type="number" min="1" max="100" required error={fe.weightage} {...bind('weightage')} />
            </div>
            <Field label="Description" as="textarea" rows={2} error={fe.description} {...bind('description')} />
            <div className="actions end">
              <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>Save</button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}

function ExamResults({ examId, maxMarks }) {
  const state = useApi(() => api(`/admin/exams/${examId}/results`), [examId]);
  return (
    <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No bookings yet" />}>
      {(d) => (
        <Card title={`Results (${d.items.filter((r) => r.evaluation_status && r.evaluation_status !== 'Draft').length} of ${d.items.length} evaluated)`}>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Student</th><th>Examiner</th><th>Slot</th><th>Evaluation</th><th>Marks</th><th>Remarks</th><th /></tr></thead>
              <tbody>
                {d.items.map((r) => (
                  <tr key={r.booking_id}>
                    <td>{r.student_name}<div className="muted small">{r.roll_number}</div></td>
                    <td>{r.examiner_name}</td>
                    <td>{fmtDate(r.slot_date)} {fmtTime(r.start_time)}</td>
                    <td>{r.evaluation_status ? <Badge>{r.evaluation_status}</Badge> : <Badge tone="amber">Pending</Badge>}</td>
                    <td>{fmtMarks(r.total_marks, maxMarks)}</td>
                    <td className="small">{r.remarks || '—'}</td>
                    <td><Link to={`/admin/bookings?open=${r.booking_id}`}>Booking</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </AsyncView>
  );
}

// ================================================================== slots (all examiners)
function SlotsTable({ fixedExamId }) {
  const [params] = useSearchParams();
  const [filters, setFilters] = useState({ status: '', date_from: '', date_to: '', examiner_id: params.get('examiner_id') || '' });
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, filters]);
  const state = useApi(() => api(`/admin/slots${qs({ q: dq, page, exam_id: fixedExamId, ...filters })}`), [dq, page, filters, fixedExamId]);
  const setF = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));
  return (
    <>
      <div className="toolbar">
        {!fixedExamId && <SearchBox value={q} onChange={setQ} placeholder="Search exam, course, examiner" />}
        <select value={filters.status} onChange={setF('status')} aria-label="Status"><option value="">Any status</option>{['Available', 'Full', 'Cancelled', 'Completed'].map((s) => <option key={s}>{s}</option>)}</select>
        <label className="inline">From <input type="date" value={filters.date_from} onChange={setF('date_from')} /></label>
        <label className="inline">To <input type="date" value={filters.date_to} onChange={setF('date_to')} /></label>
        {filters.examiner_id && <button type="button" className="btn btn-small" onClick={() => setFilters((f) => ({ ...f, examiner_id: '' }))}>Clear examiner filter ×</button>}
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No slots" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr>{!fixedExamId && <th>Examination</th>}<th>Examiner</th><th>Date</th><th>Time</th><th>Booked</th><th>Status</th><th /></tr></thead>
                <tbody>
                  {d.items.map((s) => (
                    <tr key={s.id}>
                      {!fixedExamId && <td><Link to={`/admin/exams/${s.exam_id}`}>{s.exam_name}</Link><div className="muted small">{s.course_code}</div></td>}
                      <td>{s.examiner_name}</td>
                      <td>{fmtDate(s.slot_date)}</td>
                      <td>{fmtTime(s.start_time)}–{fmtTime(s.end_time)}</td>
                      <td>{s.booked_count}/{s.capacity}</td>
                      <td><Badge>{s.status}</Badge></td>
                      <td><button type="button" className="btn btn-small" onClick={() => setOpen(s.id)}>Manage</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {open && <SlotManager slotId={open} onClose={() => { setOpen(null); state.reload(); }} />}
    </>
  );
}

export function AdminSlots() {
  return (
    <>
      <PageHeader title="All examiner slots" subtitle="Reschedule a slot, hand it to another examiner, or cancel an empty slot." />
      <SlotsTable />
    </>
  );
}

function SlotManager({ slotId, onClose }) {
  const state = useApi(() => api(`/admin/slots/${slotId}`), [slotId]);
  const [mode, setMode] = useState(null);
  const [notice, setNotice] = useState(null);
  return (
    <Modal title="Manage slot" wide onClose={onClose}>
      <AsyncView state={state}>
        {({ slot: s, bookings, changes }) => {
          const editable = !['Cancelled', 'Completed'].includes(s.status);
          return (
            <>
              <Notice onClose={() => setNotice(null)}>{notice}</Notice>
              <dl className="dl">
                <dt>Examination</dt><dd>{s.exam_name} ({s.course_code})</dd>
                <dt>Examiner</dt><dd>{s.examiner_name}</dd>
                <dt>When</dt><dd>{fmtSlot(s)}</dd>
                <dt>Seats</dt><dd>{s.booked_count} / {s.capacity} <Badge>{s.status}</Badge></dd>
                <dt>Where</dt><dd>{s.meeting_link || s.venue || '—'}</dd>
              </dl>
              {editable && (
                <div className="actions">
                  <button type="button" className={`btn ${mode === 'reschedule' ? 'btn-primary' : ''}`} onClick={() => setMode('reschedule')}>Reschedule</button>
                  <button type="button" className={`btn ${mode === 'examiner' ? 'btn-primary' : ''}`} onClick={() => setMode('examiner')}>Change examiner</button>
                  {s.booked_count === 0 && <button type="button" className={`btn btn-danger-outline ${mode === 'cancel' ? 'active' : ''}`} onClick={() => setMode('cancel')}>Cancel slot</button>}
                </div>
              )}
              {mode === 'reschedule' && <SlotReschedule slot={s} onDone={(m) => { setMode(null); setNotice(m); state.reload(); }} />}
              {mode === 'examiner' && <SlotExaminer slot={s} onDone={(m) => { setMode(null); setNotice(m); state.reload(); }} />}
              {mode === 'cancel' && <SlotCancel slot={s} onDone={(m) => { setMode(null); setNotice(m); state.reload(); }} />}
              <h3>Students ({bookings.length})</h3>
              {bookings.length === 0 ? <Empty title="No bookings" /> : (
                <table className="table compact">
                  <thead><tr><th>Student</th><th>Booking</th><th>Evaluation</th><th /></tr></thead>
                  <tbody>{bookings.map((b) => <tr key={b.id}><td>{b.student_name} <span className="muted small">{b.roll_number}</span></td><td><Badge>{b.status}</Badge></td><td>{b.evaluation_status ? <Badge>{b.evaluation_status}</Badge> : '—'}</td><td><Link to={`/admin/bookings?open=${b.id}`}>Open</Link></td></tr>)}</tbody>
                </table>
              )}
              <h3>Change history</h3>
              <ol className="timeline">
                {changes.map((c) => (
                  <li key={c.id}><strong>{c.change_type.replace('_', ' ').toLowerCase()}</strong>
                    <span className="muted small"> · {fmtDateTime(c.created_at)}{c.actor_name ? ` · ${c.actor_name}` : ''}</span>
                    {c.change_type === 'RESCHEDULED' && <div className="small">{fmtDate(c.old_date)} {fmtTime(c.old_start_time)} → {fmtDate(c.new_date)} {fmtTime(c.new_start_time)}</div>}
                    {c.change_type === 'EXAMINER_CHANGED' && <div className="small">{c.old_examiner} → {c.new_examiner}</div>}
                    {c.reason && <div className="small muted">{c.reason}</div>}
                  </li>
                ))}
              </ol>
            </>
          );
        }}
      </AsyncView>
    </Modal>
  );
}

function SlotReschedule({ slot, onDone }) {
  const { values, bind } = useForm({
    slot_date: slot.slot_date, start_time: fmtTime(slot.start_time), end_time: fmtTime(slot.end_time), capacity: slot.capacity,
    venue: slot.venue || '', meeting_link: slot.meeting_link || '', reason: '',
  });
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    await api(`/admin/slots/${slot.id}`, { method: 'PUT', body: { ...values, capacity: Number(values.capacity) } });
    onDone('Slot updated. Booked students and the examiner were notified.');
  });
  const fe = error?.fieldErrors ? error.fieldErrors() : {};
  return (
    <form onSubmit={save} className="subform">
      <ErrorBox error={error} />
      <div className="grid-3">
        <Field label="Date" type="date" required error={fe.slot_date} {...bind('slot_date')} />
        <Field label="Start" type="time" required error={fe.start_time} {...bind('start_time')} />
        <Field label="End" type="time" required error={fe.end_time} {...bind('end_time')} />
      </div>
      <div className="grid-3">
        <Field label="Capacity" type="number" min={Math.max(1, slot.booked_count)} required error={fe.capacity} {...bind('capacity')} />
        <Field label="Venue" error={fe.venue} {...bind('venue')} />
        <Field label="Meeting link" error={fe.meeting_link} {...bind('meeting_link')} />
      </div>
      <Field label="Reason (shown to students)" required error={fe.reason} {...bind('reason')} />
      <div className="actions end"><button type="submit" className="btn btn-primary" disabled={saving}>Save changes</button></div>
    </form>
  );
}

function SlotExaminer({ slot, onDone }) {
  const all = useApi(() => api('/admin/examiners?all=true&status=Active'), []);
  const [examinerId, setExaminerId] = useState('');
  const [reason, setReason] = useState('');
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    const r = await api(`/admin/slots/${slot.id}/examiner`, { method: 'PUT', body: { examiner_id: Number(examinerId), reason } });
    onDone(`Examiner changed. ${r.students_notified} student(s) notified.`);
  });
  return (
    <form onSubmit={save} className="subform">
      <ErrorBox error={error} />
      <Field label="New examiner" as="select" required name="examiner_id" value={examinerId} onChange={(e) => setExaminerId(e.target.value)}>
        <option value="">Select…</option>
        {all.data?.items.filter((x) => x.id !== slot.examiner_id && x.is_active).map((x) => <option key={x.id} value={x.id}>{x.full_name} — {x.department}</option>)}
      </Field>
      <Field label="Reason" required name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <p className="muted small">The new examiner is assigned to the examination automatically. Their other slots must not overlap this time.</p>
      <div className="actions end"><button type="submit" className="btn btn-primary" disabled={saving || !examinerId || reason.length < 3}>Change examiner</button></div>
    </form>
  );
}

function SlotCancel({ slot, onDone }) {
  const [reason, setReason] = useState('');
  const [save, saving, error] = useAction(async (e) => {
    e.preventDefault();
    await api(`/admin/slots/${slot.id}/cancel`, { method: 'POST', body: { reason } });
    onDone('Slot cancelled.');
  });
  return (
    <form onSubmit={save} className="subform">
      <ErrorBox error={error} />
      <Field label="Reason" required name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <div className="actions end"><button type="submit" className="btn btn-danger" disabled={saving || reason.length < 3}>Cancel slot</button></div>
    </form>
  );
}

// ================================================================== bookings
export function AdminBookings() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') || '');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const dq = useDebounced(q);
  useEffect(() => setPage(1), [dq, status]);
  const state = useApi(() => api(`/admin/bookings${qs({ q: dq, status, page })}`), [dq, status, page]);
  const openId = params.get('open');

  return (
    <>
      <PageHeader title="Bookings" subtitle="Search all bookings; open one to reschedule, reassign or cancel it." />
      <div className="toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search student name, roll number, email or examination" />
        <div className="tabs">
          {['', 'Booked', 'Completed', 'Cancelled'].map((s) => <button type="button" key={s || 'all'} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>{s || 'All'}</button>)}
        </div>
      </div>
      <AsyncView state={state} isEmpty={(d) => d.items.length === 0} empty={<Empty title="No bookings match" />}>
        {(d) => (
          <Card>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>#</th><th>Student</th><th>Examination</th><th>Slot</th><th>Examiner</th><th>Status</th><th>Evaluation</th><th /></tr></thead>
                <tbody>
                  {d.items.map((b) => (
                    <tr key={b.id}>
                      <td className="muted">{b.id}</td>
                      <td>{b.student_name}<div className="muted small">{b.roll_number}</div></td>
                      <td>{b.exam_name}<div className="muted small">{b.course_code}</div></td>
                      <td>{fmtSlot(b)}</td>
                      <td>{b.examiner_name}</td>
                      <td><Badge>{b.status}</Badge></td>
                      <td>{b.evaluation_status ? <Badge>{b.evaluation_status}</Badge> : '—'}</td>
                      <td><button type="button" className="btn btn-small" onClick={() => setParams({ open: b.id })}>Open</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={d.page} pages={d.pages} total={d.total} onPage={setPage} />
          </Card>
        )}
      </AsyncView>
      {openId && <BookingManager id={openId} onClose={() => { setParams({}); state.reload(); }} />}
    </>
  );
}

function BookingManager({ id, onClose }) {
  const state = useApi(() => api(`/admin/bookings/${id}`), [id]);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState(null);
  const [move, moving, moveError] = useAction(async () => {
    const r = await api(`/admin/bookings/${id}/reschedule`, { method: 'POST', body: { slot_id: Number(target), reason } });
    setNotice(r.examiner_changed ? 'Student moved to another examiner\'s slot.' : 'Booking rescheduled.');
    setTarget(''); setReason('');
    state.reload();
  });
  const [cancel, cancelling, cancelError] = useAction(async () => {
    await api(`/admin/bookings/${id}/cancel`, { method: 'POST', body: { reason } });
    setNotice('Booking cancelled and the seat released.');
    state.reload();
  });
  return (
    <Modal title={`Booking #${id}`} wide onClose={onClose}>
      <AsyncView state={state}>
        {({ booking: b, events, alternatives, evaluation_versions: versions }) => (
          <>
            <Notice onClose={() => setNotice(null)}>{notice}</Notice>
            <div className="grid-2">
              <dl className="dl">
                <dt>Student</dt><dd>{b.student_name} ({b.roll_number})<div className="muted small">{b.student_email}</div></dd>
                <dt>Examination</dt><dd>{b.exam_name} · {b.course_code} <Badge>{b.exam_status}</Badge></dd>
                <dt>Slot</dt><dd>{fmtSlot(b)}</dd>
                <dt>Examiner</dt><dd>{b.examiner_name}</dd>
                <dt>Status</dt><dd><Badge>{b.status}</Badge> <Badge>{b.attendance}</Badge></dd>
                <dt>Evaluation</dt><dd>{b.evaluation_status ? <><Badge>{b.evaluation_status}</Badge> {fmtMarks(b.total_marks)} (v{b.version})</> : '—'}</dd>
              </dl>
              <div>
                <h3>History</h3>
                <BookingTimeline events={events} />
              </div>
            </div>
            {b.status === 'Booked' && !b.evaluation_status && (
              <div className="subform">
                <h3>Reschedule or reassign</h3>
                <ErrorBox error={moveError || cancelError} />
                {alternatives.length === 0 ? <p className="muted">No other future slots with free seats for this examination.</p> : (
                  <Field label="Move to slot" as="select" name="target" value={target} onChange={(e) => setTarget(e.target.value)}>
                    <option value="">Select a slot…</option>
                    {alternatives.map((s) => <option key={s.id} value={s.id}>{fmtSlot(s)} — {s.examiner_name} ({s.available_seats} free)</option>)}
                  </Field>
                )}
                <Field label="Reason (required, shown to the student)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                <div className="actions end">
                  <ConfirmButton className="btn btn-danger-outline" disabled={cancelling || reason.length < 3} confirm="Cancel this booking?" onConfirm={cancel}>Cancel booking</ConfirmButton>
                  <button type="button" className="btn btn-primary" disabled={moving || !target || reason.length < 3} onClick={move}>{moving ? 'Moving…' : 'Move booking'}</button>
                </div>
              </div>
            )}
            {versions.length > 0 && (
              <>
                <h3>Evaluation versions</h3>
                <table className="table compact">
                  <thead><tr><th>Version</th><th>Status</th><th>Total</th><th>Saved</th><th>By</th></tr></thead>
                  <tbody>{versions.map((v) => <tr key={v.version}><td>{v.version}</td><td><Badge>{v.status}</Badge></td><td>{fmtMarks(v.total_marks)}</td><td>{fmtDateTime(v.created_at)}</td><td>{v.actor_name}</td></tr>)}</tbody>
                </table>
              </>
            )}
          </>
        )}
      </AsyncView>
    </Modal>
  );
}

// ================================================================== reports
export function AdminReports() {
  const state = useApi(() => api('/admin/reports/overview?months=6'), []);
  const monthly = useApi(() => api('/admin/reports/monthly'), []);
  const [notice, setNotice] = useState(null);
  const [month, setMonth] = useState('');
  const [run, running, runError] = useAction(async (path, body, msg) => {
    const r = await api(path, { method: 'POST', body });
    setNotice(`${msg} (${r.mode === 'queued' ? 'queued for the worker' : 'ran immediately'}).`);
    setTimeout(monthly.reload, 1500);
  });
  const openReport = async (m) => {
    const res = await api(`/admin/reports/monthly/${m}`, { raw: true });
    const html = await res.text();
    const w = window.open('', '_blank');
    if (w) { w.document.write(html); w.document.close(); }
  };

  return (
    <>
      <PageHeader title="Reports & statistics" />
      <Notice onClose={() => setNotice(null)}>{notice}</Notice>
      <ErrorBox error={runError} />
      <AsyncView state={state}>
        {(d) => {
          const maxTrend = Math.max(1, ...d.trend.map((t) => Math.max(t.bookings, t.evaluations)));
          const maxEval = Math.max(1, ...d.examiners.map((x) => x.evaluations));
          return (
            <>
              <div className="grid-2">
                <Card title="Last 6 months">
                  <table className="table compact">
                    <thead><tr><th>Month</th><th>Bookings</th><th>Evaluations</th><th>Cancelled</th></tr></thead>
                    <tbody>{d.trend.map((t) => (
                      <tr key={t.month}><td>{t.month}</td><td><Bar value={t.bookings} max={maxTrend} /></td><td><Bar value={t.evaluations} max={maxTrend} /></td><td>{t.cancellations}</td></tr>
                    ))}</tbody>
                  </table>
                </Card>
                <Card title="Most active examiners">
                  <table className="table compact">
                    <thead><tr><th>Examiner</th><th>Evaluations</th><th>Slots</th><th>Pending</th></tr></thead>
                    <tbody>{d.examiners.map((x) => (
                      <tr key={x.id}><td>{x.full_name}<div className="muted small">{x.department}</div></td><td><Bar value={x.evaluations} max={maxEval} /></td><td>{x.slots}</td><td>{x.pending || 0}</td></tr>
                    ))}</tbody>
                  </table>
                </Card>
              </div>
              <div className="grid-2">
                <Card title="Bookings by status">
                  <ul className="list">{d.booking_status.map((s) => <li key={s.status}><Badge>{s.status}</Badge><strong>{s.count}</strong></li>)}</ul>
                </Card>
                <Card title="Examinations by type">
                  <ul className="list">{d.exam_types.map((s) => <li key={s.exam_type}><span>{s.exam_type}</span><strong>{s.count}</strong></li>)}</ul>
                </Card>
              </div>
              <Card title="Per-examination statistics">
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Examination</th><th>Status</th><th>Bookings</th><th>Evaluated</th><th>Pending</th><th>Average</th><th>Pass rate</th></tr></thead>
                    <tbody>{d.exams.map((e) => (
                      <tr key={e.id}>
                        <td><Link to={`/admin/exams/${e.id}`}>{e.name}</Link><div className="muted small">{e.course_code} · {e.exam_type}</div></td>
                        <td><Badge>{e.status}</Badge></td><td>{e.bookings}</td><td>{e.evaluated}</td><td>{e.pending}</td>
                        <td>{e.average_marks ?? '—'}</td><td>{e.pass_rate !== null ? <Bar value={e.pass_rate} max={100} label={`${e.pass_rate}%`} /> : '—'}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </Card>
            </>
          );
        }}
      </AsyncView>
      <Card title="Scheduled jobs">
        <div className="grid-2">
          <div>
            <h3>Monthly report</h3>
            <p className="muted small">Runs automatically on the 1st of every month and is emailed to the admin. Generate one now:</p>
            <div className="actions">
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
              <button type="button" className="btn" disabled={running} onClick={() => run('/admin/jobs/monthly-report', month ? { month, force: true } : { force: true }, 'Monthly report generated')}>Generate & email</button>
            </div>
            <AsyncView state={monthly} isEmpty={(m) => m.items.length === 0} empty={<p className="muted small">No reports generated yet.</p>}>
              {(m) => <ul className="list">{m.items.map((r) => <li key={r.month}><button type="button" className="link" onClick={() => openReport(r.month)}>{r.month}</button><span className="muted small">sent to {r.sent_to} · {fmtDateTime(r.created_at)}</span></li>)}</ul>}
            </AsyncView>
          </div>
          <div>
            <h3>Daily reminders</h3>
            <p className="muted small">Sent every morning to students with an examination in the next day, by email and Google Chat. Each booking is reminded at most once per day.</p>
            <button type="button" className="btn" disabled={running} onClick={() => run('/admin/jobs/daily-reminders', undefined, 'Reminder job started')}>Send today's reminders now</button>
          </div>
        </div>
      </Card>
    </>
  );
}
