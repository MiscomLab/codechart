import https from 'node:https';
// Dates in expectations are UTC; the machine's zone must not shift them.
process.env.TZ = 'UTC';
// No test may reach npm or write the real update cache; tests of the check pass their own env and fetch.
process.env.CODECHART_NO_UPDATE_CHECK = '1';
// A commit can start git's background maintenance, which repacks .git/objects while a test copies the repo.
const gitConfigs = Number(process.env.GIT_CONFIG_COUNT) || 0;
Object.assign(process.env, {
  GIT_CONFIG_COUNT: String(gitConfigs + 2),
  [`GIT_CONFIG_KEY_${gitConfigs}`]: 'maintenance.auto',
  [`GIT_CONFIG_VALUE_${gitConfigs}`]: 'false',
  [`GIT_CONFIG_KEY_${gitConfigs + 1}`]: 'gc.auto',
  [`GIT_CONFIG_VALUE_${gitConfigs + 1}`]: '0',
});
globalThis.fetch = (() => Promise.reject(new Error('network is off in tests'))) as typeof fetch;
const realGet = https.get;
https.get = ((url: unknown, ...rest: unknown[]) => {
  if (!['127.0.0.1', 'localhost'].includes(new URL(String(url)).hostname)) throw new Error('network is off in tests');
  return (realGet as (...a: unknown[]) => unknown)(url, ...rest);
}) as typeof https.get;
