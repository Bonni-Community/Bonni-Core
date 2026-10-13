// Existing credentials are preserved when a module is installed later.
export function planModuleRoutingExtension(activeDomains, existingConnections = {}) {
  const connections = structuredClone(existingConnections);
  const missingDomains = [];
  for (const domain of activeDomains) {
    const current = connections[domain];
    if (!current) {
      missingDomains.push(domain);
      continue;
    }
    if (!current.normal || !current.redundant) {
      throw new Error(`DATABASE_DOMAIN_EXISTING_ROUTING_INCOMPLETE:${domain}`);
    }
  }
  return { connections, missingDomains };
}
