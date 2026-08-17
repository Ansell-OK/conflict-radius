export async function fetchPatient(patientId: string): Promise<string> {
  const response = await fetch(`/patients/${patientId}`);
  const patient = await response.json() as { patientId: string; status: string };
  return `${patient.patientId}:${patient.status}`;
}
