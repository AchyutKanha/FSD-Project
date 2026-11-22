# Entity–relationship diagram

GitHub renders this Mermaid diagram directly. The full DDL, with every constraint, is in [`server/db/schema.sql`](../server/db/schema.sql).

```mermaid
erDiagram
  users ||--o| student_profiles : "role = student"
  users ||--o| examiner_profiles : "role = examiner"
  courses ||--o{ examinations : has
  examinations ||--o{ rubric_criteria : "evaluated by"
  examinations ||--o{ exam_examiners : assigns
  users ||--o{ exam_examiners : "examiner"
  exam_examiners ||--o{ slots : "creates (FK exam_id, examiner_id)"
  slots ||--o{ bookings : "seats"
  users ||--o{ bookings : "student"
  bookings ||--o| evaluations : "evaluated in"
  evaluations ||--o{ evaluation_scores : "per criterion"
  rubric_criteria ||--o{ evaluation_scores : ""
  evaluations ||--o{ evaluation_versions : "history (append-only)"
  evaluation_versions ||--o{ evaluation_version_scores : ""
  bookings ||--o{ booking_events : "history (append-only)"
  slots ||--o{ slot_changes : "history (append-only)"
  examinations ||--o{ exam_status_history : "history (append-only)"
  users ||--o{ notifications : receives
  users ||--o{ export_jobs : requests
  bookings ||--o{ reminder_log : "reminded (idempotent)"

  users { bigint id PK
    text email "UNIQUE lower(email)"
    text password_hash "bcrypt"
    text role "admin|examiner|student; only ONE admin (partial unique index)"
    bool is_active }
  courses { bigint id PK
    text code UK
    text name
    text status "Active|Inactive|Archived" }
  examinations { bigint id PK
    bigint course_id FK
    text exam_type "Viva|Practical|Project Demo|Assessment"
    int duration_minutes
    numeric max_marks
    timestamptz slot_creation_start_end
    timestamptz booking_start_end "CHECK ordered"
    text status "Draft|Slot Creation|Booking Open|Closed|Completed"
    bool results_published }
  rubric_criteria { bigint id PK
    bigint exam_id FK
    numeric max_marks
    numeric weightage "sum must be 100 to open booking" }
  slots { bigint id PK
    bigint exam_id FK
    bigint examiner_id FK
    date slot_date
    time start_end "EXCLUDE overlap per examiner"
    int capacity
    int booked_count "CHECK 0..capacity"
    int available_seats "GENERATED"
    text status "Available|Full|Cancelled|Completed; CHECK matches count" }
  bookings { bigint id PK
    bigint student_id FK
    bigint slot_id FK
    bigint exam_id "FK (slot_id, exam_id) keeps it consistent"
    text status "Booked|Cancelled|Completed"
    text attendance "UNIQUE (student, exam) WHERE not cancelled" }
  evaluations { bigint id PK
    bigint booking_id UK
    numeric total_marks
    text status "Draft|Submitted|Absent"
    int version "optimistic lock" }
```

## Normalisation notes

- The users table is **unified**. Role-specific data lives in `student_profiles` and `examiner_profiles`. Their composite foreign key `(user_id, user_role) → users(id, role)` makes it impossible to attach a student profile to an examiner.
- `bookings.exam_id` is the one deliberate denormalisation. It makes the partial unique index *one active booking per student per exam* possible. The composite foreign key `(slot_id, exam_id) → slots(id, exam_id)` guarantees it can never disagree with the slot.
- `slots.booked_count` is a counter, not the source of truth. The bookings are the source of truth. The counter is changed only inside the same locked transaction as the booking, and a `CHECK (booked_count <= capacity)` guards it. The tests assert `booked_count = count(active bookings)` after every race.
- No column holds lists or comma-separated values. Scores are rows in `evaluation_scores`, one per criterion.
