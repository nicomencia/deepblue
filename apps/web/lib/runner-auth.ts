/**
 * Dev-grade runner auth: one shared bearer token from the environment.
 * Multi-user future: replace with per-runner tokens checked against the
 * runners table (tokenHash), which also yields the runner's userId scope.
 */
export function isAuthorizedRunner(req: Request): boolean {
  const token = process.env.RUNNER_TOKEN;
  if (!token) return false;
  return req.headers.get("authorization") === `Bearer ${token}`;
}
