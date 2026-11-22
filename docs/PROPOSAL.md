# Project proposal — Examination Management Portal (EMP)

## 1. What are you building?

A web application where an **admin** sets up courses, examinations, rubrics and examiners, and opens and closes each phase of an exam. **Examiners** publish time slots, then evaluate the students booked into them against the rubric. **Students** register, book one slot per examination, cancel before the deadline, and see their published results and feedback. Reminders, a monthly report and CSV exports run as background jobs.

## 2. What is your hard requirement?

Two of the three kinds apply. The main one is **Kind 1: concurrency**, and Kind 2 (multi-row transaction) and Kind 3 (append-only history) back it up.

> "If two students **book the last seat of a slot** at the same moment, a naive version would **let both in and leave the slot overbooked**, while the seat counter still says it is only full."

Related cases handled the same way:

- **The same student double-clicks Book, or uses two tabs.** They must not end up with two bookings for one exam.
- **The admin moves a booking into a slot while a student books that slot's last seat.** Only one of them may win.
- **An examiner creates two overlapping slots at the same instant.** Only one may be created.
- **A reschedule is a multi-row transaction.** It frees the old seat, takes the new seat, moves the booking and writes history, and either all of that happens or none of it does.
- **Bookings and evaluations keep an append-only history.** A database trigger refuses UPDATE and DELETE on those history rows.

## 3. How should we test it?

1. Create a slot with **capacity 1**, register 30 students, and send all 30 `POST /api/student/bookings` requests **at the same instant** (`Promise.all`).
   **Expected:** exactly one `201` and 29 `409`. In the database, `slots.booked_count = 1`, the slot's status is `Full`, and there is exactly 1 non-cancelled row in `bookings` for that slot.
2. Repeat with capacity 5 and 40 students. **Expected:** exactly 5 succeed.
3. One student sends 10 simultaneous requests across two slots of the same exam. **Expected:** exactly 1 booking exists.
4. After every test, check the invariant `booked_count = count(active bookings)` for each slot involved.

These are automated in `server/tests/booking.race.test.js`. You can also see it live with `npm run race`, which prints the database state after the race. Restarting the server with `NAIVE_BOOKING_DEMO=true` swaps in the tutorial version of the booking code, and the same command then shows 50 bookings for 1 seat.
