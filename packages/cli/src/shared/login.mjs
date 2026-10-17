// The signed-in client a command needs: config plus an API client built from it.

export async function getAuthenticated(dependencies) {
  const config = await dependencies.loadConfig(dependencies.configPath());
  const client = dependencies.clientFactory(config);
  return { config, client };
}
