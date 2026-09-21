export async function drainAndClose({ server, servers = [server], collectors, commands, inventory, store }) {
  const drained = Promise.all(servers.map(s => {
    const closing = new Promise(resolve => s.close(resolve));
    s.closeIdleConnections(); return closing;
  }));
  await Promise.allSettled([collectors.close(), commands.close(), drained]);
  await Promise.all(servers.map(s => s.drainHandlers()));
  await inventory.close();
  store.close();
}
