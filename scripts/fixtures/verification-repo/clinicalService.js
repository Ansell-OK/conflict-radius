import { crReadClinicalRecord } from './clinicalRepository.js';

export function crPrepareClinicalView(patientId) {
  return crReadClinicalRecord(patientId);
}
