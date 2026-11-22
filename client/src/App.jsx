import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth, homeFor } from './auth';
import { Layout, RequireRole } from './components/Layout';
import { Loading } from './components/ui';
import { Login, Register, NotFound } from './pages/Auth';
import {
  StudentDashboard, StudentExams, StudentExamDetail, StudentBookings, StudentBookingDetail, StudentHistory, StudentResults, StudentProfile,
} from './pages/student/StudentPages';
import {
  ExaminerDashboard, ExaminerExams, ExaminerExamDetail, ExaminerSlots, ExaminerStudents, ExaminerEvaluate,
} from './pages/examiner/ExaminerPages';
import { AdminDashboard, AdminCourses, AdminExaminers, AdminStudents, AdminSearch } from './pages/admin/AdminPeople';
import { AdminExams, AdminExamDetail, AdminSlots, AdminBookings, AdminReports } from './pages/admin/AdminExams';

function Home() {
  const { user, checking } = useAuth();
  if (checking) return <Loading />;
  return <Navigate to={user ? homeFor(user.role) : '/login'} replace />;
}

const guarded = (roles) => <RequireRole roles={roles}><Layout /></RequireRole>;

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          <Route path="/admin" element={guarded(['admin'])}>
            <Route index element={<AdminDashboard />} />
            <Route path="courses" element={<AdminCourses />} />
            <Route path="exams" element={<AdminExams />} />
            <Route path="exams/:id" element={<AdminExamDetail />} />
            <Route path="examiners" element={<AdminExaminers />} />
            <Route path="students" element={<AdminStudents />} />
            <Route path="slots" element={<AdminSlots />} />
            <Route path="bookings" element={<AdminBookings />} />
            <Route path="reports" element={<AdminReports />} />
            <Route path="search" element={<AdminSearch />} />
          </Route>

          <Route path="/examiner" element={guarded(['examiner'])}>
            <Route index element={<ExaminerDashboard />} />
            <Route path="exams" element={<ExaminerExams />} />
            <Route path="exams/:id" element={<ExaminerExamDetail />} />
            <Route path="slots" element={<ExaminerSlots />} />
            <Route path="students" element={<ExaminerStudents />} />
            <Route path="evaluate/:bookingId" element={<ExaminerEvaluate />} />
          </Route>

          <Route path="/student" element={guarded(['student'])}>
            <Route index element={<StudentDashboard />} />
            <Route path="exams" element={<StudentExams />} />
            <Route path="exams/:id" element={<StudentExamDetail />} />
            <Route path="bookings" element={<StudentBookings />} />
            <Route path="bookings/:id" element={<StudentBookingDetail />} />
            <Route path="history" element={<StudentHistory />} />
            <Route path="results" element={<StudentResults />} />
            <Route path="profile" element={<StudentProfile />} />
          </Route>

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
