export function crTsReadPatient(patientId: string): { patientId: string; active: boolean } {
  return { patientId, active: true };
}
