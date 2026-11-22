class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const badRequest = (msg, details) => new ApiError(400, msg, details);
const unauthorized = (msg = 'Authentication required') => new ApiError(401, msg);
const forbidden = (msg = 'You do not have permission to perform this action') => new ApiError(403, msg);
const notFound = (what = 'Resource') => new ApiError(404, `${what} not found`);
const conflict = (msg, details) => new ApiError(409, msg, details);

// Friendly messages for constraint names defined in db/schema.sql
const CONSTRAINT_MESSAGES = {
  users_email_lower_uq: [409, 'An account with this email already exists'],
  users_single_admin_uq: [409, 'Only one admin account may exist'],
  student_profiles_roll_number_key: [409, 'This roll number is already registered'],
  examiner_profiles_employee_code_key: [409, 'This employee code is already in use'],
  courses_code_key: [409, 'A course with this code already exists'],
  examinations_course_id_name_key: [409, 'An examination with this name already exists for the course'],
  rubric_criteria_exam_id_criterion_name_key: [409, 'This rubric already has a criterion with that name'],
  bookings_one_active_per_exam_uq: [409, 'You already have a booking for this examination'],
  slots_no_examiner_overlap: [409, 'The examiner already has a slot that overlaps this time'],
  slots_exam_id_examiner_id_fkey: [409, 'The examiner is not assigned to this examination'],
  slots_seats_within_capacity: [409, 'The slot does not have enough seats'],
  slots_end_after_start: [400, 'End time must be after start time'],
  exam_examiners_examiner_id_examiner_role_fkey: [400, 'Examiner not found'],
};

/** Translate PostgreSQL errors into HTTP errors without leaking internals. */
function fromPgError(err) {
  if (!err || !err.code) return null;
  if (err.code === '23503' && err.constraint === 'slots_exam_id_examiner_id_fkey' && /still referenced/.test(err.message)) {
    return new ApiError(409, 'This examiner already has slots for this examination and cannot be unassigned');
  }
  const mapped = err.constraint && CONSTRAINT_MESSAGES[err.constraint];
  if (mapped) return new ApiError(mapped[0], mapped[1]);
  switch (err.code) {
    case '23505': return new ApiError(409, 'A record with these details already exists');
    case '23503':
      return err.message.includes('still referenced')
        ? new ApiError(409, 'This record is in use by other records and cannot be removed')
        : new ApiError(400, 'A referenced record does not exist');
    case '23514': return new ApiError(400, err.message.startsWith('marks') || err.message.startsWith('criterion') ? err.message : 'A value violates a data rule');
    case '23P01': return new ApiError(409, 'This conflicts with an existing overlapping record');
    case '23502': return new ApiError(400, 'A required value is missing');
    case '22P02': case '22007': case '22008': case '22003': return new ApiError(400, 'A value has an invalid format');
    case '23001': return new ApiError(409, err.message);
    case '40P01': case '40001': return new ApiError(503, 'The server is busy, please retry');
    default: return null;
  }
}

module.exports = { ApiError, badRequest, unauthorized, forbidden, notFound, conflict, fromPgError };
