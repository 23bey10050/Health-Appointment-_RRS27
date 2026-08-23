export type UserRole = "patient" | "doctor" | "admin";

export interface UserOut {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: UserRole;
  is_active: boolean;
  created_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export type EmergencyQueueStatus = "active" | "acknowledged" | "resolved";

export interface DifferentialConsideration {
  consideration: string;
  supporting_features: string[];
  features_against: string[];
  cannot_exclude_because: string[];
  time_criticality: string;
  suggested_workup: string[];
  source_refs: string[];
}

export interface EmergencyBriefContent {
  presentation_summary: string;
  vital_concerns: string[];
  differential_considerations: DifferentialConsideration[];
  immediate_actions_to_consider: string[];
  information_needed_urgently: string[];
  confidence: number;
  limitations: string;
}

export interface Hospital {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  phone: string | null;
  has_emergency_dept: boolean;
}

export interface HospitalCreate {
  name: string;
  address?: string | null;
  city?: string | null;
  phone?: string | null;
  has_emergency_dept: boolean;
}

export type HospitalUpdate = Partial<HospitalCreate>;

export interface DoctorListItem {
  user_id: string;
  full_name: string;
  specialisation: string;
  hospital_id: string | null;
  hospital_name: string | null;
  consultation_fee: number | null;
  years_experience: number | null;
  accepts_emergency: boolean;
  next_available: string | null;
}

export interface Doctor {
  user_id: string;
  full_name: string;
  hospital_id: string | null;
  specialisation: string;
  sub_specialisations: string[];
  qualifications: string | null;
  years_experience: number | null;
  bio: string | null;
  consultation_fee: number | null;
  slot_duration_min: number;
  accepts_emergency: boolean;
  is_accepting: boolean;
}

export interface AvailabilityOut {
  doctor_id: string;
  slot_duration_min: number;
  slots: string[];
}

export type AppointmentStatus = "held" | "confirmed" | "cancelled" | "completed" | "no_show" | "rescheduled";
export type AppointmentKind = "routine" | "follow_up" | "emergency";
export type UrgencyLevel = "low" | "medium" | "high" | "critical";

export interface Appointment {
  id: string;
  doctor_id: string;
  doctor_name: string | null;
  patient_id: string;
  patient_name: string | null;
  hospital_id: string | null;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  kind: AppointmentKind;
  urgency: UrgencyLevel | null;
  booking_channel: string;
  reason_text: string | null;
  hold_expires_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
}

export interface EmergencyQueueEntry {
  id: string;
  patient_id: string | null;
  patient_name: string | null;
  hospital_id: string | null;
  category: string;
  severity: string;
  summary: string | null;
  status: EmergencyQueueStatus;
  oncall_doctor_id: string | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
  brief: EmergencyBriefContent | null;
  brief_state: string | null;
  ambulance_required: boolean | null;
  callback_name: string | null;
  callback_phone: string | null;
  appointment_id: string | null;
}

// -- Summaries (pre-visit / post-visit / emergency brief) -------------------

export type SummaryKind = "pre_visit" | "post_visit" | "emergency_brief";
export type SummaryState = "draft" | "approved" | "edited" | "rejected" | "failed";

export interface SummaryOut {
  id: string;
  kind: SummaryKind;
  appointment_id: string | null;
  encounter_id: string | null;
  state: SummaryState;
  content: Record<string, unknown>;
  content_edited: Record<string, unknown> | null;
  model_provider: string | null;
  model_name: string | null;
  prompt_version: string | null;
  generation_error: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface SymptomTimelineEntry {
  when: string;
  what: string;
}

export interface PreVisitSummaryContent {
  chief_complaint: string;
  urgency: UrgencyLevel;
  hpi: string;
  symptom_timeline: SymptomTimelineEntry[];
  relevant_history: string[];
  current_medications: string[];
  allergies: string[];
  red_flags_noted: string[];
  red_flags_explicitly_denied: string[];
  questions_for_doctor: string[];
  information_gaps: string[];
  patient_own_words: string;
}

export interface MedicationScheduleEntry {
  drug: string;
  dose: string;
  when: string;
  with_food: string;
  for_how_long: string;
  why: string;
}

export interface PatientQuestion {
  q: string;
  a: string;
}

export interface PostVisitSummaryContent {
  what_we_discussed: string;
  what_the_doctor_found: string;
  medication_schedule: MedicationScheduleEntry[];
  things_to_do: string[];
  things_to_avoid: string[];
  come_back_if: string[];
  next_appointment: string | null;
  questions_you_might_have: PatientQuestion[];
}

// -- Encounters / prescriptions ----------------------------------------------

export interface PrescriptionIn {
  drug_name: string;
  strength?: string | null;
  form?: string | null;
  frequency_code: string;
  relation_to_food?: string | null;
  duration_days: number;
  start_date: string;
  instructions?: string | null;
}

export interface PrescriptionOut {
  id: string;
  drug_name: string;
  strength: string | null;
  form: string | null;
  frequency_code: string;
  relation_to_food: string | null;
  duration_days: number;
  start_date: string;
  instructions: string | null;
  is_active: boolean;
}

export interface EncounterCreate {
  appointment_id: string;
  clinical_notes?: string | null;
  diagnosis?: string | null;
  vitals?: Record<string, unknown> | null;
  follow_up_after_days?: number | null;
  prescriptions: PrescriptionIn[];
}

export interface EncounterOut {
  id: string;
  appointment_id: string;
  clinical_notes: string | null;
  diagnosis: string | null;
  vitals: Record<string, unknown> | null;
  follow_up_after_days: number | null;
  submitted_at: string | null;
  prescriptions: PrescriptionOut[];
}

// -- Leave --------------------------------------------------------------

export interface LeaveRequest {
  start_date: string;
  end_date: string;
  reason?: string | null;
}

export interface AlternativeSlot {
  doctor_id: string;
  doctor_name: string;
  start_at: string;
}

export interface AffectedAppointmentOut {
  appointment_id: string;
  patient_name: string;
  start_at: string;
  alternatives: AlternativeSlot[];
}

export interface LeaveImpactPreview {
  doctor_id: string;
  start_date: string;
  end_date: string;
  affected_count: number;
  affected: AffectedAppointmentOut[];
}

export interface LeaveOut {
  id: string;
  doctor_id: string;
  start_date: string;
  end_date: string;
  reason: string | null;
  affected_appointments_handled: boolean;
}

// -- Admin: doctors / hospitals / KB / health --------------------------------

export interface WorkingHours {
  weekday: number; // 0=Monday .. 6=Sunday
  start_time: string; // "HH:MM:SS"
  end_time: string;
}

export interface AdminDoctorOut {
  user_id: string;
  email: string;
  full_name: string;
  phone: string | null;
  is_active: boolean;
  hospital_id: string | null;
  hospital_name: string | null;
  specialisation: string;
  sub_specialisations: string[];
  qualifications: string | null;
  registration_no: string | null;
  years_experience: number | null;
  bio: string | null;
  consultation_fee: number | null;
  slot_duration_min: number;
  buffer_min: number;
  max_daily_appointments: number | null;
  accepts_emergency: boolean;
  is_accepting: boolean;
  working_hours: WorkingHours[];
}

export interface DoctorCreate {
  email: string;
  full_name: string;
  password: string;
  phone?: string | null;
  hospital_id?: string | null;
  specialisation: string;
  sub_specialisations?: string[];
  qualifications?: string | null;
  registration_no?: string | null;
  years_experience?: number | null;
  bio?: string | null;
  consultation_fee?: number | null;
  slot_duration_min?: number;
  buffer_min?: number;
  max_daily_appointments?: number | null;
  accepts_emergency?: boolean;
  is_accepting?: boolean;
  working_hours?: WorkingHours[];
}

export type DoctorUpdate = Partial<Omit<DoctorCreate, "email" | "password" | "working_hours">> & {
  is_active?: boolean;
};

export interface KBDocumentUpload {
  namespace: string;
  audience: string;
  title: string;
  source_type?: string;
  content: string;
}

export interface KBDocumentOut {
  id: string;
  namespace: string;
  audience: string;
  title: string;
  source_uri: string | null;
  source_type: string | null;
  version: number;
  is_active: boolean;
  created_at: string;
  chunk_count: number;
}

export interface LatencyStats {
  stage: string;
  p50_ms: number | null;
  p95_ms: number | null;
  sample_count: number;
}

export interface LLMProviderStatus {
  tier: string;
  provider: string;
  model: string;
  circuit_state: "closed" | "open" | "half_open";
  consecutive_failures: number;
  requests_last_minute: number;
  rpm_limit: number;
  requests_today: number;
  rpd_limit: number | null;
}

export interface AdminHealthOut {
  outbox_backlog: Record<string, number>;
  voice_sessions_total: number;
  voice_sessions_emergency: number;
  red_flag_fire_rate: number;
  red_flag_categories: Record<string, number>;
  voice_latency: LatencyStats[];
  llm_provider_status: LLMProviderStatus[];
}

export interface CalendarStatus {
  connected: boolean;
  connected_at: string | null;
}
