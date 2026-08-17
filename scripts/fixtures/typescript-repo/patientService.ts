import { crTsReadPatient } from "./patientRepository.js";

export const crTsBuildPatientSummary = (patientId: string, includeStatus = true): string => {
  const patient = crTsReadPatient(patientId);
  return includeStatus ? `${patient.patientId}:${patient.active}` : patient.patientId;
};
