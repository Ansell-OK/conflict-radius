import { getUser } from "../db.js";

export function showUser(id) {
  return getUser(id);
}
