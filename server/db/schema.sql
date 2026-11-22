-- =====================================================================
-- Examination Management Portal (EMP) — PostgreSQL schema
--
-- Design rules followed throughout:
--   * Every business rule that can be expressed declaratively is a
--     constraint (NOT NULL, CHECK, UNIQUE, FK, EXCLUDE), so the database
--     rejects bad data even if the API is bypassed.
--   * Rules that span rows under concurrency (seat capacity, one booking
--     per exam) are enforced by row locks in the API AND a constraint
--     here, so a bug in one layer is caught by the other.
--   * History tables are append-only: a trigger refuses UPDATE/DELETE.
--   * All timestamps are timestamptz; slot times are local (date + time)
--     in the institution's time zone (APP_TZ, default Asia/Kolkata).
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- EXCLUDE on (examiner, time range)
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fast ILIKE '%term%' search

-- ---------------------------------------------------------------------
-- Generic helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION forbid_history_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END $$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------
-- Users: one unified table, role column differentiates admin/examiner/student
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  email          TEXT        NOT NULL CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash  TEXT        NOT NULL CHECK (password_hash LIKE '$2%'),   -- bcrypt only
  full_name      TEXT        NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 120),
  role           TEXT        NOT NULL CHECK (role IN ('admin', 'examiner', 'student')),
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- lets child tables pin the role of the user they reference (composite FK)
  UNIQUE (id, role)
);
CREATE UNIQUE INDEX users_email_lower_uq ON users (lower(email));
-- Exactly one admin can ever exist: a unique index over a constant for admin rows.
CREATE UNIQUE INDEX users_single_admin_uq ON users ((role)) WHERE role = 'admin';
CREATE INDEX users_role_idx ON users (role);
CREATE INDEX users_name_trgm_idx ON users USING gin (full_name gin_trgm_ops);
CREATE INDEX users_email_trgm_idx ON users USING gin (email gin_trgm_ops);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE student_profiles (
  user_id          BIGINT PRIMARY KEY,
  user_role        TEXT   NOT NULL DEFAULT 'student' CHECK (user_role = 'student'),
  roll_number      TEXT   NOT NULL UNIQUE CHECK (roll_number ~ '^[A-Za-z0-9-]{3,20}$'),
  phone            TEXT   CHECK (phone ~ '^\+?[0-9 -]{7,20}$'),
  department       TEXT,
  program          TEXT,
  year_of_study    SMALLINT CHECK (year_of_study BETWEEN 1 AND 6),
  gchat_webhook_url TEXT  CHECK (gchat_webhook_url ~ '^https://chat\.googleapis\.com/'),
  email_reminders  BOOLEAN NOT NULL DEFAULT TRUE,
  FOREIGN KEY (user_id, user_role) REFERENCES users (id, role) ON DELETE CASCADE
);

CREATE TABLE examiner_profiles (
  user_id        BIGINT PRIMARY KEY,
  user_role      TEXT   NOT NULL DEFAULT 'examiner' CHECK (user_role = 'examiner'),
  employee_code  TEXT   NOT NULL UNIQUE CHECK (employee_code ~ '^[A-Za-z0-9-]{2,20}$'),
  phone          TEXT   CHECK (phone ~ '^\+?[0-9 -]{7,20}$'),
  department     TEXT   NOT NULL,
  designation    TEXT,
  specialization TEXT,
  status         TEXT   NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'On Leave', 'Inactive')),
  FOREIGN KEY (user_id, user_role) REFERENCES users (id, role) ON DELETE CASCADE
);
CREATE INDEX examiner_profiles_department_idx ON examiner_profiles (department);

-- ---------------------------------------------------------------------
-- Courses and examinations
-- ---------------------------------------------------------------------
CREATE TABLE courses (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{2,20}$'),
  name        TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 150),
  description TEXT,
  department  TEXT,
  credits     SMALLINT CHECK (credits BETWEEN 0 AND 20),
  status      TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive', 'Archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX courses_name_trgm_idx ON courses USING gin (name gin_trgm_ops);
CREATE TRIGGER courses_updated_at BEFORE UPDATE ON courses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE examinations (
  id                   BIGSERIAL PRIMARY KEY,
  course_id            BIGINT  NOT NULL REFERENCES courses (id) ON DELETE RESTRICT,
  name                 TEXT    NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 150),
  exam_type            TEXT    NOT NULL CHECK (exam_type IN ('Viva', 'Practical', 'Project Demo', 'Assessment')),
  description          TEXT,
  instructions         TEXT,
  duration_minutes     INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 600),
  max_marks            NUMERIC(6,2) NOT NULL CHECK (max_marks > 0),
  pass_marks           NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (pass_marks >= 0),
  slot_creation_start  TIMESTAMPTZ,
  slot_creation_end    TIMESTAMPTZ,
  booking_start        TIMESTAMPTZ,
  booking_end          TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'Draft'
                       CHECK (status IN ('Draft', 'Slot Creation', 'Booking Open', 'Closed', 'Completed')),
  results_published    BOOLEAN NOT NULL DEFAULT FALSE,
  results_published_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (course_id, name),
  CHECK (pass_marks <= max_marks),
  CHECK (slot_creation_end IS NULL OR slot_creation_start IS NULL OR slot_creation_end > slot_creation_start),
  CHECK (booking_end IS NULL OR booking_start IS NULL OR booking_end > booking_start),
  CHECK (booking_start IS NULL OR slot_creation_end IS NULL OR booking_start >= slot_creation_end),
  CHECK (results_published = (results_published_at IS NOT NULL)),
  CHECK (NOT results_published OR status IN ('Closed', 'Completed'))
);
CREATE INDEX examinations_course_idx ON examinations (course_id);
CREATE INDEX examinations_status_idx ON examinations (status);
CREATE INDEX examinations_name_trgm_idx ON examinations USING gin (name gin_trgm_ops);
CREATE TRIGGER examinations_updated_at BEFORE UPDATE ON examinations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Which examiners are assigned to which exam (many-to-many)
CREATE TABLE exam_examiners (
  exam_id       BIGINT NOT NULL REFERENCES examinations (id) ON DELETE CASCADE,
  examiner_id   BIGINT NOT NULL,
  examiner_role TEXT   NOT NULL DEFAULT 'examiner' CHECK (examiner_role = 'examiner'),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (exam_id, examiner_id),
  FOREIGN KEY (examiner_id, examiner_role) REFERENCES users (id, role) ON DELETE RESTRICT
);
CREATE INDEX exam_examiners_examiner_idx ON exam_examiners (examiner_id);

-- Append-only log of every status transition (open/close slot creation, booking, ...)
CREATE TABLE exam_status_history (
  id          BIGSERIAL PRIMARY KEY,
  exam_id     BIGINT NOT NULL REFERENCES examinations (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT   NOT NULL,
  actor_id    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exam_status_history_exam_idx ON exam_status_history (exam_id, created_at);
CREATE TRIGGER exam_status_history_append_only BEFORE UPDATE OR DELETE ON exam_status_history
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)  -- depth>0 only for FK cascades
  EXECUTE FUNCTION forbid_history_mutation();

-- ---------------------------------------------------------------------
-- Rubric criteria
-- ---------------------------------------------------------------------
CREATE TABLE rubric_criteria (
  id             BIGSERIAL PRIMARY KEY,
  exam_id        BIGINT NOT NULL REFERENCES examinations (id) ON DELETE CASCADE,
  criterion_name TEXT   NOT NULL CHECK (length(btrim(criterion_name)) BETWEEN 2 AND 120),
  max_marks      NUMERIC(6,2) NOT NULL CHECK (max_marks > 0),
  weightage      NUMERIC(5,2) NOT NULL CHECK (weightage > 0 AND weightage <= 100),
  description    TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (exam_id, criterion_name)
);
CREATE INDEX rubric_criteria_exam_idx ON rubric_criteria (exam_id, position);

-- ---------------------------------------------------------------------
-- Slots
-- ---------------------------------------------------------------------
CREATE TABLE slots (
  id            BIGSERIAL PRIMARY KEY,
  exam_id       BIGINT  NOT NULL REFERENCES examinations (id) ON DELETE RESTRICT,
  examiner_id   BIGINT  NOT NULL,
  slot_date     DATE    NOT NULL,
  start_time    TIME    NOT NULL,
  end_time      TIME    NOT NULL,
  capacity      INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 200),
  booked_count  INTEGER NOT NULL DEFAULT 0,
  available_seats INTEGER GENERATED ALWAYS AS (capacity - booked_count) STORED,
  status        TEXT    NOT NULL DEFAULT 'Available'
                CHECK (status IN ('Available', 'Full', 'Cancelled', 'Completed')),
  meeting_link  TEXT    CHECK (meeting_link ~ '^https?://'),
  venue         TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT slots_end_after_start CHECK (end_time > start_time),
  -- Second line of defence against overbooking: the counter can never pass capacity.
  CONSTRAINT slots_seats_within_capacity CHECK (booked_count >= 0 AND booked_count <= capacity),
  -- Status must agree with the counter: "Full" exactly when no seat is left.
  CONSTRAINT slots_status_matches_seats CHECK (
       (status = 'Available' AND booked_count <  capacity)
    OR (status = 'Full'      AND booked_count =  capacity)
    OR  status IN ('Cancelled', 'Completed')
  ),
  -- A cancelled slot holds no active bookings.
  CHECK (status <> 'Cancelled' OR booked_count = 0),
  -- The examiner must be assigned to this exam.
  FOREIGN KEY (exam_id, examiner_id) REFERENCES exam_examiners (exam_id, examiner_id) ON DELETE RESTRICT,
  UNIQUE (id, exam_id),
  -- One examiner can never be in two overlapping slots, even when two requests race.
  CONSTRAINT slots_no_examiner_overlap EXCLUDE USING gist (
    examiner_id WITH =,
    tsrange(slot_date + start_time, slot_date + end_time, '[)') WITH &&
  ) WHERE (status <> 'Cancelled')
);
CREATE INDEX slots_exam_idx ON slots (exam_id, slot_date, start_time);
CREATE INDEX slots_examiner_idx ON slots (examiner_id, slot_date);
CREATE INDEX slots_date_idx ON slots (slot_date);
CREATE TRIGGER slots_updated_at BEFORE UPDATE ON slots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only history of slot changes (reschedules, examiner changes, cancellation)
CREATE TABLE slot_changes (
  id               BIGSERIAL PRIMARY KEY,
  slot_id          BIGINT NOT NULL REFERENCES slots (id) ON DELETE CASCADE,
  change_type      TEXT   NOT NULL CHECK (change_type IN
                     ('CREATED', 'UPDATED', 'RESCHEDULED', 'EXAMINER_CHANGED', 'CANCELLED', 'COMPLETED')),
  old_date         DATE,  new_date       DATE,
  old_start_time   TIME,  new_start_time TIME,
  old_end_time     TIME,  new_end_time   TIME,
  old_examiner_id  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  new_examiner_id  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  old_capacity     INTEGER, new_capacity INTEGER,
  actor_id         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX slot_changes_slot_idx ON slot_changes (slot_id, created_at);
CREATE TRIGGER slot_changes_append_only BEFORE UPDATE OR DELETE ON slot_changes
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)  -- depth>0 only for FK cascades
  EXECUTE FUNCTION forbid_history_mutation();

-- ---------------------------------------------------------------------
-- Bookings
-- ---------------------------------------------------------------------
CREATE TABLE bookings (
  id            BIGSERIAL PRIMARY KEY,
  student_id    BIGINT NOT NULL,
  student_role  TEXT   NOT NULL DEFAULT 'student' CHECK (student_role = 'student'),
  slot_id       BIGINT NOT NULL,
  exam_id       BIGINT NOT NULL,
  status        TEXT   NOT NULL DEFAULT 'Booked' CHECK (status IN ('Booked', 'Cancelled', 'Completed')),
  attendance    TEXT   NOT NULL DEFAULT 'Pending' CHECK (attendance IN ('Pending', 'Present', 'Absent')),
  booked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ,
  cancel_reason TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (student_id, student_role) REFERENCES users (id, role) ON DELETE RESTRICT,
  -- exam_id is denormalised so the "one booking per exam" index below is possible;
  -- this FK guarantees it always matches the slot's exam.
  FOREIGN KEY (slot_id, exam_id) REFERENCES slots (id, exam_id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CHECK ((status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (status <> 'Cancelled' OR attendance = 'Pending')
);
-- A student holds at most ONE non-cancelled booking per examination.
-- This is what makes a double-click or two tabs safe: the second insert fails.
CREATE UNIQUE INDEX bookings_one_active_per_exam_uq ON bookings (student_id, exam_id)
  WHERE status <> 'Cancelled';
CREATE INDEX bookings_slot_active_idx ON bookings (slot_id) WHERE status <> 'Cancelled';
CREATE INDEX bookings_student_idx ON bookings (student_id, booked_at DESC);
CREATE INDEX bookings_exam_status_idx ON bookings (exam_id, status);
CREATE INDEX bookings_booked_at_idx ON bookings (booked_at);              -- monthly report / trend ranges
CREATE TRIGGER bookings_updated_at BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Append-only booking ledger: every state change of every booking, forever.
CREATE TABLE booking_events (
  id               BIGSERIAL PRIMARY KEY,
  booking_id       BIGINT NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  event_type       TEXT   NOT NULL CHECK (event_type IN
                     ('BOOKED', 'CANCELLED', 'RESCHEDULED', 'EXAMINER_CHANGED',
                      'MARKED_ABSENT', 'EVALUATED', 'COMPLETED')),
  from_slot_id     BIGINT REFERENCES slots (id) ON DELETE SET NULL,
  to_slot_id       BIGINT REFERENCES slots (id) ON DELETE SET NULL,
  from_examiner_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  to_examiner_id   BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_id         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  reason           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, created_at);
CREATE TRIGGER booking_events_append_only BEFORE UPDATE OR DELETE ON booking_events
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)  -- depth>0 only for FK cascades
  EXECUTE FUNCTION forbid_history_mutation();

-- ---------------------------------------------------------------------
-- Evaluations: current state + append-only versions
-- ---------------------------------------------------------------------
CREATE TABLE evaluations (
  id           BIGSERIAL PRIMARY KEY,
  booking_id   BIGINT NOT NULL UNIQUE REFERENCES bookings (id) ON DELETE RESTRICT,
  exam_id      BIGINT NOT NULL REFERENCES examinations (id) ON DELETE RESTRICT,
  student_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  examiner_id  BIGINT NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  total_marks  NUMERIC(6,2) NOT NULL DEFAULT 0 CHECK (total_marks >= 0),
  remarks      TEXT,
  status       TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Submitted', 'Absent')),
  version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),   -- optimistic concurrency token
  evaluated_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status = 'Draft' OR evaluated_at IS NOT NULL)
);
CREATE INDEX evaluations_exam_idx ON evaluations (exam_id, status);
CREATE INDEX evaluations_examiner_idx ON evaluations (examiner_id, evaluated_at);
CREATE INDEX evaluations_student_idx ON evaluations (student_id);
CREATE INDEX evaluations_evaluated_at_idx ON evaluations (evaluated_at) WHERE status <> 'Draft';
CREATE TRIGGER evaluations_updated_at BEFORE UPDATE ON evaluations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE evaluation_scores (
  evaluation_id BIGINT NOT NULL REFERENCES evaluations (id) ON DELETE CASCADE,
  criterion_id  BIGINT NOT NULL REFERENCES rubric_criteria (id) ON DELETE RESTRICT,
  marks         NUMERIC(6,2) NOT NULL CHECK (marks >= 0),
  comment       TEXT,
  PRIMARY KEY (evaluation_id, criterion_id)
);

-- Every save of an evaluation is recorded; earlier marks are never lost.
CREATE TABLE evaluation_versions (
  id            BIGSERIAL PRIMARY KEY,
  evaluation_id BIGINT NOT NULL REFERENCES evaluations (id) ON DELETE RESTRICT,
  version       INTEGER NOT NULL,
  status        TEXT    NOT NULL,
  total_marks   NUMERIC(6,2) NOT NULL,
  remarks       TEXT,
  actor_id      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, version)
);
CREATE TABLE evaluation_version_scores (
  version_id   BIGINT NOT NULL REFERENCES evaluation_versions (id) ON DELETE RESTRICT,
  criterion_id BIGINT NOT NULL REFERENCES rubric_criteria (id) ON DELETE RESTRICT,
  marks        NUMERIC(6,2) NOT NULL,
  comment      TEXT,
  PRIMARY KEY (version_id, criterion_id)
);
CREATE TRIGGER evaluation_versions_append_only BEFORE UPDATE OR DELETE ON evaluation_versions
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)  -- depth>0 only for FK cascades
  EXECUTE FUNCTION forbid_history_mutation();
CREATE TRIGGER evaluation_version_scores_append_only BEFORE UPDATE OR DELETE ON evaluation_version_scores
  FOR EACH ROW WHEN (pg_trigger_depth() = 0)  -- depth>0 only for FK cascades
  EXECUTE FUNCTION forbid_history_mutation();

-- A score may never exceed its criterion's maximum (cross-table rule => trigger).
CREATE OR REPLACE FUNCTION check_score_within_max() RETURNS trigger AS $$
DECLARE
  crit_max NUMERIC;
  crit_exam BIGINT;
  eval_exam BIGINT;
BEGIN
  SELECT max_marks, exam_id INTO crit_max, crit_exam FROM rubric_criteria WHERE id = NEW.criterion_id;
  SELECT exam_id INTO eval_exam FROM evaluations WHERE id = NEW.evaluation_id;
  IF crit_exam IS DISTINCT FROM eval_exam THEN
    RAISE EXCEPTION 'criterion % does not belong to the evaluated exam', NEW.criterion_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.marks > crit_max THEN
    RAISE EXCEPTION 'marks % exceed criterion maximum %', NEW.marks, crit_max
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER evaluation_scores_within_max BEFORE INSERT OR UPDATE ON evaluation_scores
  FOR EACH ROW EXECUTE FUNCTION check_score_within_max();

-- ---------------------------------------------------------------------
-- Notifications, exports, job idempotency
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT   NOT NULL,
  message    TEXT   NOT NULL,
  link       TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, is_read, created_at DESC);

CREATE TABLE export_jobs (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status       TEXT   NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Processing', 'Completed', 'Failed')),
  file_name    TEXT,
  row_count    INTEGER CHECK (row_count >= 0),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CHECK (status <> 'Completed' OR (file_name IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX export_jobs_user_idx ON export_jobs (user_id, created_at DESC);

-- A reminder is sent at most once per booking per channel per day, even if the
-- job is retried or two workers run it at the same time (INSERT ... ON CONFLICT).
CREATE TABLE reminder_log (
  booking_id BIGINT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  channel    TEXT   NOT NULL CHECK (channel IN ('email', 'gchat')),
  sent_on    DATE   NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (booking_id, channel, sent_on)
);

CREATE TABLE monthly_reports (
  report_month DATE PRIMARY KEY CHECK (extract(day FROM report_month) = 1),
  sent_to      TEXT,
  html         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
