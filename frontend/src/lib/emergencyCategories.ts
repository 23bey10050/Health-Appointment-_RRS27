// Matches the `category` field on each entry in backend/app/safety/red_flags.yaml.
// Shared between the patient-facing EmergencyBanner and the doctor/admin emergency queue.
export const EMERGENCY_CATEGORY_LABEL: Record<string, string> = {
  cardiac: "Possible cardiac emergency",
  neuro: "Possible stroke or neurological emergency",
  respiratory: "Severe breathing difficulty",
  allergic: "Possible severe allergic reaction",
  trauma: "Serious injury or trauma",
  toxicology: "Suspected overdose or poisoning",
  obstetric: "Obstetric emergency",
  pediatric: "Pediatric emergency",
  abdominal: "Severe abdominal emergency",
  mental_health: "Immediate safety concern",
};
