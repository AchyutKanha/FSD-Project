-- =====================================================================
-- EMP volume seed: 3,000 students, 40 examiners, 30 courses, 120 exams,
-- ~1,300 slots, ~7,400 bookings, ~13,000 booking events, ~5,300 evaluations, ~40,000 score rows.
-- Deterministic (no random()), so every run produces the same data.
-- Every row respects every constraint in schema.sql.
--
-- Run AFTER schema.sql (npm run db:seed creates the admin, then runs this file).
-- All seeded users have the password:  Password@123
-- =====================================================================
SET timezone = 'Asia/Kolkata';
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- crypt() produces bcrypt hashes bcryptjs can verify

BEGIN;

CREATE TEMP TABLE seed_pw ON COMMIT DROP AS
  SELECT crypt('Password@123', gen_salt('bf', 10)) AS hash;

-- ---------------- Courses (30) ----------------
INSERT INTO courses (code, name, description, department, credits, status)
SELECT
  d.prefix || '-' || (100 + n)::text,
  d.dept_name || ' ' || (ARRAY['Foundations','Systems','Design','Analytics','Applications','Advanced Topics'])[1 + (n % 6)],
  'Core course in ' || d.dept_name || ' (level ' || (1 + n % 4) || ')',
  d.dept_name,
  (2 + n % 3)::smallint,
  CASE WHEN n = 9 THEN 'Inactive' ELSE 'Active' END
FROM generate_series(1, 10) n
CROSS JOIN (VALUES ('CS','Computer Science'), ('EE','Electrical Engineering'), ('MA','Mathematics')) d(prefix, dept_name);

-- ---------------- Examiners (40) ----------------
WITH u AS (
  INSERT INTO users (email, password_hash, full_name, role)
  SELECT 'examiner' || n || '@emp.edu', (SELECT hash FROM seed_pw),
         (ARRAY['Dr. Asha','Prof. Ravi','Dr. Meera','Prof. Arjun','Dr. Kavya','Prof. Vikram','Dr. Nisha','Prof. Sanjay'])[1 + n % 8]
           || ' ' || (ARRAY['Iyer','Sharma','Nair','Rao','Menon','Gupta','Reddy','Das','Pillai','Bose'])[1 + (n / 8) % 10],
         'examiner'
  FROM generate_series(1, 40) n
  RETURNING id, email
)
INSERT INTO examiner_profiles (user_id, employee_code, phone, department, designation, specialization, status)
SELECT id,
       'FAC-' || lpad(substring(email from 'examiner(\d+)@'), 3, '0'),
       '+91 98' || lpad((10000000 + id * 7919 % 9000000)::text, 8, '0'),
       (ARRAY['Computer Science','Electrical Engineering','Mathematics'])[1 + id % 3],
       (ARRAY['Assistant Professor','Associate Professor','Professor'])[1 + id % 3],
       (ARRAY['Databases','Networks','Machine Learning','Signals','Algebra','Statistics'])[1 + id % 6],
       CASE WHEN id % 20 = 0 THEN 'On Leave' ELSE 'Active' END
FROM u;

-- ---------------- Students (3,000) ----------------
WITH u AS (
  INSERT INTO users (email, password_hash, full_name, role)
  SELECT 'student' || n || '@emp.edu', (SELECT hash FROM seed_pw),
         (ARRAY['Aarav','Diya','Vivaan','Ananya','Aditya','Ishita','Kabir','Saanvi','Rohan','Meera','Arnav','Tara'])[1 + n % 12]
           || ' ' || (ARRAY['Kumar','Singh','Patel','Shah','Joshi','Verma','Mehta','Kapoor','Chopra','Rao','Naidu','Banerjee'])[1 + (n / 12) % 12],
         'student'
  FROM generate_series(1, 3000) n
  RETURNING id, email
)
INSERT INTO student_profiles (user_id, roll_number, phone, department, program, year_of_study)
SELECT id,
       '21F' || lpad(substring(email from 'student(\d+)@'), 7, '0'),
       '+91 90' || lpad((10000000 + id * 104729 % 9000000)::text, 8, '0'),
       (ARRAY['Computer Science','Electrical Engineering','Mathematics'])[1 + id % 3],
       (ARRAY['BSc','BS','MTech'])[1 + id % 3],
       (1 + id % 4)::smallint
FROM u;

-- ---------------- Examinations (4 per course = 120) ----------------
-- status by (exam_no % 10): 0-4 Completed, 5 Closed, 6-7 Booking Open, 8 Slot Creation, 9 Draft
CREATE TEMP TABLE seed_exam_plan ON COMMIT DROP AS
SELECT c.id AS course_id, c.code, k, ((c.id - 1) * 4 + k) AS exam_no
FROM courses c CROSS JOIN generate_series(0, 3) k;

INSERT INTO examinations (course_id, name, exam_type, description, instructions, duration_minutes,
                          max_marks, pass_marks, status)
SELECT course_id,
       (ARRAY['Mid-term Viva','Lab Practical','Project Demo','End-term Assessment'])[1 + k],
       (ARRAY['Viva','Practical','Project Demo','Assessment'])[1 + k],
       'Examination ' || (k + 1) || ' for ' || code,
       'Join 10 minutes early with your student ID card. Keep your project repository link ready.',
       (ARRAY[20, 45, 30, 60])[1 + k],
       100, 40,
       CASE
         WHEN exam_no % 10 < 5 THEN 'Completed'
         WHEN exam_no % 10 = 5 THEN 'Closed'
         WHEN exam_no % 10 IN (6, 7) THEN 'Booking Open'
         WHEN exam_no % 10 = 8 THEN 'Slot Creation'
         ELSE 'Draft'
       END
FROM seed_exam_plan
ORDER BY exam_no;

-- anchor date of each exam's slots
CREATE TEMP TABLE seed_exam_dates ON COMMIT DROP AS
SELECT e.id AS exam_id, e.status,
       CASE e.status
         WHEN 'Completed'     THEN current_date - (25 + (e.id * 11) % 150)::int
         WHEN 'Closed'        THEN current_date - (2 + e.id % 4)::int
         WHEN 'Booking Open'  THEN current_date + (4 + e.id % 10)::int
         WHEN 'Slot Creation' THEN current_date + (25 + e.id % 10)::int
         ELSE current_date + 60
       END AS anchor
FROM examinations e;

UPDATE examinations e SET
  slot_creation_start = CASE WHEN d.status = 'Booking Open'  THEN now() - interval '10 days'
                             WHEN d.status = 'Slot Creation' THEN now() - interval '2 days'
                             WHEN d.status = 'Draft'         THEN NULL
                             ELSE d.anchor - interval '30 days' END,
  slot_creation_end   = CASE WHEN d.status = 'Booking Open'  THEN now() - interval '3 days'
                             WHEN d.status = 'Slot Creation' THEN now() + interval '5 days'
                             WHEN d.status = 'Draft'         THEN NULL
                             ELSE d.anchor - interval '20 days' END,
  booking_start       = CASE WHEN d.status = 'Booking Open'  THEN now() - interval '2 days'
                             WHEN d.status = 'Slot Creation' THEN now() + interval '6 days'
                             WHEN d.status = 'Draft'         THEN NULL
                             ELSE d.anchor - interval '19 days' END,
  booking_end         = CASE WHEN d.status = 'Booking Open'  THEN now() + interval '2 days'
                             WHEN d.status = 'Slot Creation' THEN now() + interval '18 days'
                             WHEN d.status = 'Draft'         THEN NULL
                             ELSE d.anchor - interval '2 days' END
FROM seed_exam_dates d WHERE d.exam_id = e.id;

INSERT INTO exam_status_history (exam_id, from_status, to_status, note, created_at)
SELECT id, NULL, 'Draft', 'seed', created_at FROM examinations;
INSERT INTO exam_status_history (exam_id, from_status, to_status, note)
SELECT id, 'Draft', status, 'seed' FROM examinations WHERE status <> 'Draft';

-- ---------------- Examiner assignment (3 per exam) ----------------
INSERT INTO exam_examiners (exam_id, examiner_id)
SELECT e.id, ex.id
FROM examinations e
CROSS JOIN generate_series(0, 2) j
JOIN LATERAL (
  SELECT u.id FROM users u WHERE u.role = 'examiner'
  ORDER BY u.id OFFSET ((e.id * 3 + j * 13) % 40) LIMIT 1
) ex ON TRUE
ON CONFLICT DO NOTHING;

-- ---------------- Rubrics (4 criteria x 25% weightage, 10 marks each) ----------------
INSERT INTO rubric_criteria (exam_id, criterion_name, max_marks, weightage, description, position)
SELECT e.id,
       (ARRAY['Conceptual understanding','Problem solving','Communication','Implementation quality'])[p],
       10, 25,
       (ARRAY['Depth and accuracy of core concepts','Approach to unseen problems','Clarity of explanation','Correctness and code quality'])[p],
       p
FROM examinations e CROSS JOIN generate_series(1, 4) p
WHERE e.status <> 'Draft';

-- ---------------- Slots (4 per assigned examiner, capacity 8) ----------------
-- Examiners teach several exams, so a candidate slot may overlap another one of theirs;
-- ON CONFLICT DO NOTHING silently skips those (the EXCLUDE constraint detects the clash).
INSERT INTO slots (exam_id, examiner_id, slot_date, start_time, end_time, capacity, status, meeting_link, venue)
SELECT ee.exam_id, ee.examiner_id,
       -- spread exams that share an anchor date and examiners across different days/times
       CASE WHEN d.status = 'Closed'                                   -- closed exams happened in the past
            THEN d.anchor - (s + ((ee.exam_id / 10) % 4)::int * 4)
            ELSE d.anchor + (s + ((ee.exam_id / 10) % 4)::int * 4) END,
       make_time((9 + 2 * ((ee.examiner_id + ee.exam_id / 40) % 4))::int, 0, 0),
       make_time((9 + 2 * ((ee.examiner_id + ee.exam_id / 40) % 4) + 2)::int, 0, 0),
       8,
       CASE WHEN d.status = 'Completed' THEN 'Completed' ELSE 'Available' END,
       'https://meet.google.com/emp-' || ee.exam_id || '-' || ee.examiner_id || '-' || s,
       'Block ' || chr(65 + (ee.examiner_id % 5)::int) || ', Room ' || (100 + s)
FROM exam_examiners ee
JOIN seed_exam_dates d ON d.exam_id = ee.exam_id
CROSS JOIN generate_series(0, 3) s
WHERE d.status <> 'Draft'
ON CONFLICT DO NOTHING;

INSERT INTO slot_changes (slot_id, change_type, new_date, new_start_time, new_end_time, new_examiner_id, new_capacity, reason)
SELECT id, 'CREATED', slot_date, start_time, end_time, examiner_id, capacity, 'seed' FROM slots;

-- ---------------- Bookings ----------------
-- Seat k of an exam goes to student (offset + 7k) mod 3000 — distinct within an exam
-- because gcd(7, 3000) = 1, so "one booking per exam" holds by construction.
CREATE TEMP TABLE seed_students ON COMMIT DROP AS
SELECT id, (row_number() OVER (ORDER BY id) - 1) AS idx FROM users WHERE role = 'student';

CREATE TEMP TABLE seed_seats ON COMMIT DROP AS
SELECT s.id AS slot_id, s.exam_id, d.status AS exam_status, d.anchor, seat,
       (row_number() OVER (PARTITION BY s.exam_id ORDER BY s.id, seat) - 1) AS exam_seat_no
FROM slots s
JOIN seed_exam_dates d ON d.exam_id = s.exam_id
CROSS JOIN generate_series(1, 8) seat
WHERE d.status IN ('Completed', 'Closed', 'Booking Open')
  -- fill: completed/closed slots ~ 6-8 seats, open slots 2-8 seats (some become Full)
  AND seat <= CASE WHEN d.status = 'Booking Open' THEN 2 + (s.id % 7) ELSE 6 + (s.id % 3) END;

INSERT INTO bookings (student_id, slot_id, exam_id, status, attendance, booked_at, cancelled_at, cancel_reason)
SELECT st.id, ss.slot_id, ss.exam_id,
       CASE WHEN ss.exam_seat_no % 23 = 5 THEN 'Cancelled'
            WHEN ss.exam_status = 'Completed' THEN 'Completed'
            ELSE 'Booked' END,
       CASE WHEN ss.exam_seat_no % 23 = 5 THEN 'Pending'
            WHEN ss.exam_status = 'Completed' AND ss.exam_seat_no % 19 = 3 THEN 'Absent'
            WHEN ss.exam_status = 'Completed' THEN 'Present'
            ELSE 'Pending' END,
       LEAST(now() - interval '1 hour', ss.anchor - interval '15 days' + (ss.exam_seat_no % 300) * interval '17 minutes'),
       CASE WHEN ss.exam_seat_no % 23 = 5 THEN LEAST(now(), ss.anchor - interval '14 days' + (ss.exam_seat_no % 300) * interval '17 minutes') END,
       CASE WHEN ss.exam_seat_no % 23 = 5 THEN 'Schedule conflict' END
FROM seed_seats ss
JOIN seed_students st ON st.idx = ((ss.exam_id * 37) + ss.exam_seat_no * 7) % 3000;

-- Keep the seat counter consistent with the bookings it summarises
UPDATE slots s SET
  booked_count = c.n,
  status = CASE WHEN s.status = 'Completed' THEN 'Completed'
                WHEN c.n >= s.capacity THEN 'Full' ELSE 'Available' END
FROM (SELECT slot_id, count(*)::int AS n FROM bookings WHERE status <> 'Cancelled' GROUP BY slot_id) c
WHERE c.slot_id = s.id;

INSERT INTO booking_events (booking_id, event_type, to_slot_id, actor_id, created_at)
SELECT id, 'BOOKED', slot_id, student_id, booked_at FROM bookings;
INSERT INTO booking_events (booking_id, event_type, from_slot_id, actor_id, reason, created_at)
SELECT id, 'CANCELLED', slot_id, student_id, cancel_reason, cancelled_at FROM bookings WHERE status = 'Cancelled';

-- ---------------- Evaluations ----------------
-- Completed exams: everyone evaluated. Closed exams: about half evaluated, rest pending.
INSERT INTO evaluations (booking_id, exam_id, student_id, examiner_id, total_marks, remarks, status, evaluated_at)
SELECT b.id, b.exam_id, b.student_id, s.examiner_id, 0,
       CASE WHEN b.attendance = 'Absent' THEN 'Absent for the examination'
            ELSE (ARRAY['Good grasp of fundamentals.','Needs more practice on problem solving.',
                        'Excellent communication and clarity.','Satisfactory; revise core topics.',
                        'Strong implementation, explain trade-offs better.'])[1 + b.id % 5] END,
       CASE WHEN b.attendance = 'Absent' THEN 'Absent' ELSE 'Submitted' END,
       (s.slot_date + s.end_time)::timestamp AT TIME ZONE 'Asia/Kolkata'
FROM bookings b
JOIN slots s ON s.id = b.slot_id
JOIN examinations e ON e.id = b.exam_id
WHERE b.status <> 'Cancelled'
  AND (e.status = 'Completed' OR (e.status = 'Closed' AND b.id % 2 = 0));

-- Closed-exam evaluations mark the booking completed
UPDATE bookings b SET status = 'Completed', attendance = 'Present'
FROM evaluations ev WHERE ev.booking_id = b.id AND b.status = 'Booked';

INSERT INTO evaluation_scores (evaluation_id, criterion_id, marks, comment)
SELECT ev.id, rc.id,
       ((3 + (ev.id * 7 + rc.position * 3) % 8))::numeric,   -- 3..10
       NULL
FROM evaluations ev
JOIN rubric_criteria rc ON rc.exam_id = ev.exam_id
WHERE ev.status = 'Submitted';

-- total = max_marks * sum(marks/criterion_max * weightage) / 100
UPDATE evaluations ev SET total_marks = t.total
FROM (
  SELECT es.evaluation_id,
         round(e.max_marks * sum(es.marks / rc.max_marks * rc.weightage) / 100, 2) AS total
  FROM evaluation_scores es
  JOIN rubric_criteria rc ON rc.id = es.criterion_id
  JOIN evaluations ev2 ON ev2.id = es.evaluation_id
  JOIN examinations e ON e.id = ev2.exam_id
  GROUP BY es.evaluation_id, e.max_marks
) t WHERE t.evaluation_id = ev.id;

INSERT INTO evaluation_versions (evaluation_id, version, status, total_marks, remarks, actor_id, created_at)
SELECT id, 1, status, total_marks, remarks, examiner_id, evaluated_at FROM evaluations;
INSERT INTO evaluation_version_scores (version_id, criterion_id, marks, comment)
SELECT v.id, es.criterion_id, es.marks, es.comment
FROM evaluation_versions v JOIN evaluation_scores es ON es.evaluation_id = v.evaluation_id;

INSERT INTO booking_events (booking_id, event_type, from_slot_id, actor_id, created_at)
SELECT ev.booking_id, CASE WHEN ev.status = 'Absent' THEN 'MARKED_ABSENT' ELSE 'EVALUATED' END,
       b.slot_id, ev.examiner_id, ev.evaluated_at
FROM evaluations ev JOIN bookings b ON b.id = ev.booking_id;

-- Results published for completed exams except every fifth one (left for the demo)
UPDATE examinations SET results_published = TRUE, results_published_at = now() - interval '1 day'
WHERE status = 'Completed' AND id % 5 <> 0;

COMMIT;

ANALYZE;

SELECT 'users' AS table_name, count(*) FROM users
UNION ALL SELECT 'courses', count(*) FROM courses
UNION ALL SELECT 'examinations', count(*) FROM examinations
UNION ALL SELECT 'slots', count(*) FROM slots
UNION ALL SELECT 'bookings', count(*) FROM bookings
UNION ALL SELECT 'booking_events', count(*) FROM booking_events
UNION ALL SELECT 'evaluations', count(*) FROM evaluations
UNION ALL SELECT 'evaluation_scores', count(*) FROM evaluation_scores;
