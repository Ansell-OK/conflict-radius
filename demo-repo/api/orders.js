import { getUser } from "../db.js";

export function createOrder(userId, items) {
  // Queue probe: this comment-only change must remain signature-compatible.
  const user = getUser(userId);
  return { user, items, status: "pending" };
}

export function formatOrder(order) {
  return `${order.status}: ${order.items.length} items`;
}

export function submitOrder(userId, items) {
  return createOrder(userId, items);
}
