import { Navigate, Route, Routes } from "react-router-dom";
import Landing from "@/pages/Landing";
import FAQ from "@/pages/FAQ";
import { BlogIndex, BlogPost } from "@/pages/Blog";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import Settings from "@/pages/Settings";
import PatientDashboard from "@/pages/patient/PatientDashboard";
import BookAppointment from "@/pages/patient/BookAppointment";
import MyAppointments from "@/pages/patient/MyAppointments";
import VisitSummary from "@/pages/patient/VisitSummary";
import DoctorDashboard from "@/pages/doctor/DoctorDashboard";
import Schedule from "@/pages/doctor/Schedule";
import AppointmentDetail from "@/pages/doctor/AppointmentDetail";
import LeaveRequest from "@/pages/doctor/LeaveRequest";
import AdminDashboard from "@/pages/admin/AdminDashboard";
import AdminDoctors from "@/pages/admin/AdminDoctors";
import AdminDoctorDetail from "@/pages/admin/AdminDoctorDetail";
import AdminHospitals from "@/pages/admin/AdminHospitals";
import AdminKnowledgeBase from "@/pages/admin/AdminKnowledgeBase";
import { ProtectedRoute } from "@/components/ProtectedRoute";

export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/" element={<Landing />} />
      <Route path="/faq" element={<FAQ />} />
      <Route path="/blog" element={<BlogIndex />} />
      <Route path="/blog/:slug" element={<BlogPost />} />
      <Route path="/register" element={<Register />} />
      {/* /login keeps working on its own -- ProtectedRoute redirects there, and
          old links/bookmarks still resolve. /login/:role only changes framing. */}
      <Route path="/login" element={<Login />} />
      <Route path="/login/:role" element={<Login />} />

      <Route
        path="/settings"
        element={
          <ProtectedRoute roles={["patient", "doctor", "admin"]}>
            <Settings />
          </ProtectedRoute>
        }
      />

      {/* Patient */}
      <Route
        path="/patient"
        element={
          <ProtectedRoute roles={["patient"]}>
            <PatientDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/patient/book"
        element={
          <ProtectedRoute roles={["patient"]}>
            <BookAppointment />
          </ProtectedRoute>
        }
      />
      <Route
        path="/patient/appointments"
        element={
          <ProtectedRoute roles={["patient"]}>
            <MyAppointments />
          </ProtectedRoute>
        }
      />
      <Route
        path="/patient/appointments/:appointmentId"
        element={
          <ProtectedRoute roles={["patient"]}>
            <VisitSummary />
          </ProtectedRoute>
        }
      />

      {/* Doctor */}
      <Route
        path="/doctor"
        element={
          <ProtectedRoute roles={["doctor"]}>
            <DoctorDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/doctor/schedule"
        element={
          <ProtectedRoute roles={["doctor"]}>
            <Schedule />
          </ProtectedRoute>
        }
      />
      <Route
        path="/doctor/appointments/:appointmentId"
        element={
          <ProtectedRoute roles={["doctor"]}>
            <AppointmentDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/doctor/leave"
        element={
          <ProtectedRoute roles={["doctor"]}>
            <LeaveRequest />
          </ProtectedRoute>
        }
      />

      {/* Admin */}
      <Route
        path="/admin"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AdminDashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/doctors"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AdminDoctors />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/doctors/:doctorId"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AdminDoctorDetail />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/hospitals"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AdminHospitals />
          </ProtectedRoute>
        }
      />
      <Route
        path="/admin/kb"
        element={
          <ProtectedRoute roles={["admin"]}>
            <AdminKnowledgeBase />
          </ProtectedRoute>
        }
      />

      {/* Unknown paths land on the public site, not a dead end. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
