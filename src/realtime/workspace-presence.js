// Process-local proof that an authenticated phone workspace is still reachable.
// Multiple tabs are independent; closing one must not mark another offline.
const connections = new Map();
export function trackWorkspace(identity, socket, authorized = () => true) {
  const entry = { socket, authorized, seenAt: Date.now() };
  const entries = connections.get(identity) || new Set();
  entries.add(entry); connections.set(identity, entries);
  return {
    touch() { entry.seenAt = Date.now(); },
    close() { entries.delete(entry); if (!entries.size) connections.delete(identity); },
  };
}
export function workspaceOnline(identity, now = Date.now(), maxAgeMs = 45000) {
  return [...(connections.get(identity) || [])].some(entry => entry.socket.readyState === 1
    && now - entry.seenAt < maxAgeMs && entry.authorized());
}
