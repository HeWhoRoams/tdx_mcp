import { join } from "node:path";

/**
 * Where the server's `.env` comes from, in order: `TDX_ENV_FILE`, then `TDX_HOME/.env` (the one
 * per-user file a packaged install uses, next to its tokens), then the project root (a clone).
 * The first file that exists wins; the rest are ignored.
 */
export function envFileCandidates(env: NodeJS.ProcessEnv, tdxHome: string, projectRoot: string): string[] {
  const explicit = env.TDX_ENV_FILE?.trim();
  if (explicit) return [explicit];
  return [join(tdxHome, ".env"), join(projectRoot, ".env")];
}

export function resolveEnvFile(
  env: NodeJS.ProcessEnv,
  tdxHome: string,
  projectRoot: string,
  exists: (path: string) => boolean
): string | undefined {
  return envFileCandidates(env, tdxHome, projectRoot).find(exists);
}

/**
 * A desktop-extension host substitutes `${user_config.x}` into the environment, and a field the user
 * left blank may come through as the literal placeholder. A placeholder is never a real value, so it
 * is removed and the setting reads as unset.
 */
export function dropUnfilledPlaceholders(env: NodeJS.ProcessEnv): string[] {
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && /^\$\{user_config\.[^}]*\}$/.test(value.trim())) {
      delete env[key];
      dropped.push(key);
    }
  }
  return dropped;
}
