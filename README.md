# Examination Management Portal (EMP)

A full-stack web application where an **admin** runs examinations end to end, **examiners** publish slots and evaluate against rubrics, and **students** book slots and receive results.

**Stack:** React 19 + React Router · Node.js + Express 5 · PostgreSQL 16 · Redis (cache + BullMQ job queue) · JWT + bcrypt · zod validation · Jest

| Brief asks for | Implemented with |
|---|---|
| Flask-Security / JWT, role-based access | JWT (`jsonwebtoken`) + bcrypt, one unified `users` table with a `role` column, `requireRole()` middleware on every route |
| Celery scheduled + async jobs | **BullMQ** on Redis (`npm run worker`): cron-scheduled daily reminders and monthly report; user-triggered CSV export |
| Redis caching with expiry | Read-through cache with TTLs and namespace invalidation for exams, slot schedules and rubrics |
| Admin created programmatically, only one | Created on server start / `npm run create-admin`; a **partial unique index** makes a second admin impossible |

---

## 1. The hard requirement: booking under concurrency

> *If two students book the last seat of a slot at the same moment, a naive version (read seats → check → insert → write seats + 1) lets both in.*

`server/src/services/bookings.js` runs every seat-changing operation as **one transaction** that first **locks the slot row**:

```sql
BEGIN;
SELECT ... FROM users WHERE id = $student FOR NO KEY UPDATE;            -- 1. serialise this student's requests
SELECT ... FROM slots s JOIN examinations e ON e.id = s.exam_id
 WHERE s.id = $slot FOR NO KEY UPDATE OF s FOR SHARE OF e;              -- 2. other bookers of this slot wait here
-- checks on the *committed* row: booking window open? seat left? already booked this exam? time clash?
INSERT INTO bookings (...);                                             -- 3. booking
UPDATE slots SET booked_count = booked_count + 1,
                 status = CASE WHEN booked_count + 1 >= capacity THEN 'Full' ELSE 'Available' END
 WHERE id = $slot;                                                      -- 4. counter, same transaction
INSERT INTO booking_events (...);                                       -- 5. append-only history
COMMIT;
```

The second request blocks on the lock until the first commits, then re-reads `booked_count` and receives **409 "This slot is full"**.

**Defence in depth.** Constraints in the database reject bad state even if the code were wrong:

| Rule | Enforced by |
|---|---|
| A slot is never overbooked | `CHECK (booked_count BETWEEN 0 AND capacity)` |
| `status` agrees with the counter | `CHECK ((status='Available' AND booked_count < capacity) OR (status='Full' AND booked_count = capacity) OR ...)` |
| One active booking per student per exam | `UNIQUE INDEX ... ON bookings (student_id, exam_id) WHERE status <> 'Cancelled'` |
| An examiner never has overlapping slots | `EXCLUDE USING gist (examiner_id WITH =, tsrange(start, end) WITH &&)` |
| A booking's exam matches its slot | composite FK `(slot_id, exam_id) → slots(id, exam_id)` |
| Examiner must be assigned to the exam | composite FK `(exam_id, examiner_id) → exam_examiners` |
| A score never exceeds its criterion max | trigger `check_score_within_max` |
| History is never rewritten | trigger `forbid_history_mutation` on `booking_events`, `slot_changes`, `evaluation_versions`, `exam_status_history` |
| Exactly one admin | `UNIQUE INDEX ... ON users ((role)) WHERE role = 'admin'` |

**Lock order** (documented in `services/locks.js`): student → slot(s) by ascending id → booking → evaluation. Every write path takes locks in this order, so no two transactions can wait on each other in a cycle. Deadlocks are therefore avoided by design, and `withTransaction()` still retries `40P01`/`40001` as a safety net.

**Multi-row transactions.** Admin *reschedule* and *reassign to another examiner* release the old seat, take the new seat, move the booking, write history and notify the student, all in one transaction. *Change a slot's examiner* is likewise a single transaction.

**Optimistic concurrency.** Every evaluation carries a `version`. Saving with a stale `expected_version` returns 409 instead of silently overwriting.

**Idempotent jobs.** A reminder is claimed with `INSERT INTO reminder_log ... ON CONFLICT DO NOTHING` before it is sent, so two workers or a retry never double-send. The monthly report is keyed by month, and an export job is claimed with a conditional `UPDATE`.

### See it for yourself

```bash
npm run race               # in server/, with the API running: 50 students, 1 seat, fired at once
# HTTP results: { '201': 1, '409': 49 }    Database: booked_count=1 active bookings=1 status=Full   ✅

# Now restart the API with NAIVE_BOOKING_DEMO=true (switches to services/naiveBooking.js) and run it again:
# HTTP results: { '201': 50 }              Database: booked_count=1 active bookings=50             ❌ OVERBOOKED
```

The naive file is kept on purpose for the viva. It is unreachable when `NODE_ENV=production`.

---

## 2. Running it

**Prerequisites:** Node.js 20+, Docker (or local PostgreSQL 16 + Redis 7).

```bash
docker compose up -d                       # PostgreSQL :5432, Redis :6379, MailHog :1025 / UI http://localhost:8025

cd server
cp .env.example .env                       # then set JWT_SECRET to a long random string
npm install
npm run db:migrate                         # creates tables, constraints, indexes, triggers
npm run db:seed                            # creates the admin + 3,000 students and ~7,400 bookings
npm run dev                                # API on http://localhost:4000
npm run worker                             # second terminal: background jobs + schedules

cd ../client
npm install
npm run dev                                # UI on http://localhost:5173 (proxies /api to :4000)
```

To reset everything: `npm run db:reset && npm run db:seed`. For production, `cd client && npm run build`, then `npm start` in `server/` serves the built UI and the API together on :4000.

### Accounts

| Role | Email | Password |
|---|---|---|
| Admin | `admin@emp.edu` (from `.env`) | `Admin@12345` |
| Examiner | `examiner1@emp.edu` … `examiner40@emp.edu` | `Password@123` |
| Student | `student1@emp.edu` … `student3000@emp.edu` | `Password@123` |

Or register a new student at `/register`. Admins and examiners cannot self-register.

### Seed data (`server/db/seed.sql`, deterministic, ~1.5 s)

3,040 users · 30 courses · 120 examinations covering every status · 1,278 slots · 7,404 bookings · 13,025 booking events · 5,267 evaluations · ~40,000 score rows. It respects every constraint, and `booked_count` matches the active bookings for every slot. Some examinations are *Booking Open*, so you can book immediately; some are *Closed*, with students waiting to be evaluated; one in five completed exams has results not yet published, so you can try publishing.

---

## 3. Tests

```bash
cd server
npm test                                   # Jest; uses TEST_DATABASE_URL (recreated each run), Redis not needed
```

| File | What it proves |
|---|---|
| `tests/booking.race.test.js` | 30 students → 1 seat: exactly one 201. 40 → 5 seats: exactly five. A double-click across two slots gives one booking. Cancel-vs-rebook race. Admin-reschedule-vs-student race. Concurrent overlapping slot creation. After each: `booked_count = count(active bookings)` |
| `tests/rules.test.js` | 401/403 role checks, forged JWT, cannot register as admin, single-admin index, duplicate email, weak password, deactivated user locked out, malformed JSON / unknown fields / bad ids → 400, timeline ordering, rubric = 100 %, booking/cancellation windows, students can't touch others' bookings, slot window & edit rules, evaluation ownership / limits / versioning / publish lock, append-only history, examiner reassignment |
| `tests/jobs.test.js` | CSV export job (file, download, ownership, notification); reminders sent once even when two runs race; monthly report generated once unless forced |

**Postman:** import `docs/EMP.postman_collection.json` (set `baseUrl`). Folder 1 builds an exam and walks the whole booking flow, including the 409s. Folder 2 sends nine invalid requests that the UI would never send.

---

## 4. Indexes and performance

Each index exists for a query the app actually runs (`EXPLAIN ANALYZE` on the seeded data):

| Query | Index | Plan |
|---|---|---|
| "Does this student already hold a booking for this exam?" (every booking) | `bookings_one_active_per_exam_uq` (partial, unique) | Index Scan, 0.07 ms |
| Search users by name `ILIKE '%kumar%'` | `users_name_trgm_idx` (GIN, pg_trgm) | Bitmap Index Scan, 0.5 ms; a btree cannot serve `%term%` |
| A student's bookings, newest first | `bookings_student_idx (student_id, booked_at DESC)` | Index Scan 0.06 ms vs Seq Scan 0.47 ms |
| Monthly report / 6-month trend ranges | `bookings_booked_at_idx`, `evaluations_evaluated_at_idx` (partial) | The trend query went from ~165 ms (correlated sub-queries) to ~24 ms after a rewrite to one `GROUP BY` per table plus these indexes |
| Slot schedule of an exam | `slots_exam_idx (exam_id, slot_date, start_time)` | Index Scan |

**Caching** (`server/src/lib/cache.js`): the student exam list, exam detail, slot schedules and rubrics are cached in Redis with TTLs (120 s / 30 s / 600 s). Any write bumps a namespace version, so stale keys are skipped immediately and then expire. If Redis is down, the cache passes straight through. Correctness never depends on the cache, because every write re-checks in SQL under a lock. `/api/health` and the admin dashboard show the hit and miss counts.

---

## 5. Background jobs (BullMQ)

| Job | When | What |
|---|---|---|
| `daily-reminders` | `REMINDER_CRON` (default 08:00 Asia/Kolkata) | For every active booking in the next `REMINDER_DAYS_AHEAD` day(s): exam name, date/time, examiner, venue/link and instructions, sent by **email** and to **Google Chat** (the student's own webhook, or `GCHAT_WEBHOOK_URL`) |
| `monthly-report` | `MONTHLY_REPORT_CRON` (default 09:00 on the 1st) | HTML report for the previous month emailed to the admin: exams conducted, students evaluated, completed bookings, pending evaluations, most active examiners, per-exam table. Also stored and viewable under *Reports* |
| `export-history` | Student clicks *Export as CSV* | CSV with Student ID, examination, course, date, examiner, marks (only if published) and booking status. The student is alerted by in-app notification and email (with the CSV attached); the UI polls until it is ready |

Run any job once without Redis: `npm run job -- reminders` or `npm run job -- monthly 2026-10`. Admins can also trigger both from *Reports*. If Redis is unreachable, the API runs a job inline instead of failing.

---

## 6. API overview

All routes are under `/api`, return JSON, and use standard codes: `201` created, `202` job accepted, `204` no content, `400` validation (with `errors: [{field, message}]`), `401` not logged in, `403` wrong role or deactivated, `404`, `409` conflicts with current state (full, duplicate, window closed, stale version).

- **Auth:** `POST /auth/register` (students only) · `POST /auth/login` · `GET /auth/me` · `POST /auth/change-password`
- **Admin** `/admin/…`: `dashboard`, `search?q=` · `courses` CRUD · `exams` CRUD, `exams/:id/status` (open/close phases), `exams/:id/examiners`, `exams/:id/rubrics`, `rubrics/:id`, `exams/:id/publish|unpublish`, `exams/:id/results` · `examiners` CRUD · `students`, `students/:id/status` · `slots`, `slots/:id` (reschedule), `slots/:id/examiner` (change examiner), `slots/:id/cancel` · `bookings`, `bookings/:id/reschedule`, `bookings/:id/cancel` · `reports/overview`, `reports/monthly[/:month]`, `jobs/monthly-report`, `jobs/daily-reminders`
- **Examiner** `/examiner/…`: `dashboard` · `exams`, `exams/:id`, `exams/:id/complete` · `slots` CRUD, `slots/:id/bookings`, `slots/:id/complete` · `bookings?evaluation=pending|done`, `bookings/:id/evaluation` (GET/PUT), `bookings/:id/absent`
- **Student** `/student/…`: `dashboard` · `exams?q&course_id&exam_type&status&open_only`, `exams/:id` · `bookings` (POST/GET), `bookings/:id`, `bookings/:id/cancel` · `history`, `results` · `profile` · `exports` (POST/GET), `exports/:id`, `exports/:id/download`
- **Any logged-in user:** `options`, `notifications`, `notifications/:id/read`, `notifications/read-all`

## 7. Examination lifecycle

`Draft → Slot Creation → Booking Open → Closed → Completed`, with *results published* as a separate switch.

- **Slot Creation** needs an active course and at least one assigned examiner. Examiners can create slots only while it is open and within the slot-creation dates.
- **Booking Open** needs rubric weightages totalling exactly 100 % and at least one future slot. Students book only inside the booking window; examiners can no longer edit slots.
- **Closed:** students can no longer book or cancel. The admin can still cancel or reschedule. Examiners evaluate (only their own students, only once the slot has started; `ALLOW_EARLY_EVALUATION=true` for demos).
- **Completed:** requires no student still awaiting evaluation. It happens automatically when the last examiner marks their part complete, or the admin can do it.
- **Publish** requires every booking evaluated or marked absent. Students then see marks, per-criterion scores and feedback, and evaluations lock.

## 8. Project layout

```
docker-compose.yml          PostgreSQL, Redis, MailHog
docs/                       PROPOSAL.md (the three questions), ER-DIAGRAM.md, Postman collection
server/
  db/schema.sql             every table, constraint, index, trigger
  db/seed.sql               volume seed (pure SQL, generate_series)
  src/services/             transactional logic — bookings.js (the hard part), slots.js, evaluations.js, exams.js, locks.js
  src/routes/               auth, admin, examiner, student, common (REST + zod validation)
  src/jobs/                 queue.js, worker.js, reminders.js, monthlyReport.js, exportCsv.js
  src/lib/                  cache, errors (PG error → HTTP), messaging (email, Google Chat)
  scripts/race-test.js      live concurrency demo
  tests/                    Jest suites
client/src/
  pages/admin|examiner|student   screens per role (loading / error / empty states everywhere)
  components/ui.jsx         useApi, forms, badges, modal, pagination
  api.js, auth.jsx          fetch wrapper with JWT; auth context
```
