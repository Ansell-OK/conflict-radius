export function getPatient(patientId: string): { patientId: string; status: string } {
  return { patientId, status: "active" };
}
