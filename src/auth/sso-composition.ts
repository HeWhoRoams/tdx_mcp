import { bindingOf } from "./identity-binding.js";
import { ssoTokenPath } from "./paths.js";
import {
  SsoLifecycle,
  type SsoAuditEvent,
  type SsoAuthorization,
  type SsoLifecycleOverrides,
} from "./sso-lifecycle.js";
import { isSsoConfig, type Config, type SsoConfig } from "../config.js";
import { setCacheNamespace } from "../services/cache.js";
import { logger } from "../services/logger.js";
import { SsoTokenStore } from "../services/token-store.js";

/**
 * Composition root for SSO: wires the token store, lifecycle and cache namespace for one
 * realm and hands the HTTP client an opaque SsoAuthorization. Returns undefined for the
 * service-account methods, which have no per-user state.
 */
/** The lifecycle for one realm and expected user, not yet started. The login CLI and scripts use this directly. */
export function buildSsoLifecycle(
  config: SsoConfig,
  audit: (event: SsoAuditEvent, fields?: Record<string, unknown>) => void = () => undefined,
  overrides: SsoLifecycleOverrides = {}
): SsoLifecycle {
  const store = new SsoTokenStore(ssoTokenPath(bindingOf(config.apiBaseUrl, config.auth.expectedUser)));
  return new SsoLifecycle(config, store, audit, overrides);
}

export function createSsoAuthorization(
  config: Config,
  overrides: SsoLifecycleOverrides = {}
): SsoAuthorization | undefined {
  if (!isSsoConfig(config)) return undefined;
  const { expectedUser } = config.auth;
  const lifecycle = buildSsoLifecycle(
    config,
    (event, fields) => logger.info("sso lifecycle", { event, realm: config.apiBaseUrl, expectedUser, ...fields }),
    overrides
  );
  setCacheNamespace(() => lifecycle.cacheNamespace());
  lifecycle.start();
  return {
    authorize: () => lifecycle.authorize(),
    reportUnauthorized: (fingerprint) => lifecycle.reportUnauthorized(fingerprint),
    stop: () => {
      lifecycle.stop();
      setCacheNamespace(undefined);
    },
  };
}
