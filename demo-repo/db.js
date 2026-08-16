const users = new Map([
  ["user-1", { id: "user-1", name: "Ada" }],
]);

export function getUser(id) {
  return users.get(id) ?? null;
}
