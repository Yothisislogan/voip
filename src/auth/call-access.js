export const canAccessCall = (agent, call) => Boolean(agent && call && (agent.role === 'admin' ||
  (agent.identity && call.agent_identity === agent.identity) || (!call.agent_identity && call.route_targets?.includes(agent.identity))));
