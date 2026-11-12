import { bindingOf } from "./identity-binding.js";
import { ssoTokenPath } from "./paths.js";
import {
  SsoLifecycle,
  type SsoAuditEvent,
  type SsoAuthorization,
  type SsoLifecycleOverrides,
} from "./sso-lifecycle.js";
import axios from "axios";
import { isServiceAuth, isSsoConfig, type Config, type SsoConfig } from "../config.js";
import { setCacheNamespace } from "../services/cache.js";
import { TeamDynamixAuthError } from "../services/errors.js";
import { logger } from "../services/logger.js";
import { SSO_ACTION_REQUIRED, SSO_RENEWAL_UNAVAILABLE, SsoUnavailableError, signInAction } from "./sso-errors.js";
import type { Authorization } from "./authorization.js";
import { ServiceAccountAuthorization } from "./service-account.js";
import { createServiceTokenStore, SsoTokenStore } from "./token-store.js";

/**
 * Composition root for credentials: builds the Authorization the HTTP client asks for its header.
 * A service account gets its own login adapter; SSO wires the token store, lifecycle and cache
 * namespace for one realm.
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

/** A request that is rejected this many times after fresh authorizations is not going to succeed. */
const MAX_SSO_REAUTHORIZATIONS = 2;

/**
 * Adapts what the SSO lifecycle offers to the Authorization the client asks for: sign-in problems
 * become the two canonical error codes, and a request that keeps being rejected ends in a sign-in prompt.
 */
export function adaptSsoAuthorization(handle: SsoAuthorization): Authorization {
  return {
    maxReauthorizations: MAX_SSO_REAUTHORIZATIONS,
    async authorize() {
      try {
        return await handle.authorize();
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        throw new TeamDynamixAuthError(
          `${error instanceof SsoUnavailableError ? SSO_RENEWAL_UNAVAILABLE : SSO_ACTION_REQUIRED}: ${message}`.trim()
        );
      }
    },
    reportUnauthorized: (fingerprint) => handle.reportUnauthorized(fingerprint),
    exhausted: () =>
      new TeamDynamixAuthError(
        `${SSO_ACTION_REQUIRED}: TeamDynamix kept rejecting the renewed sign-in. ${signInAction()}, then retry.`
      ),
    stop: () => handle.stop(),
  };
}

function createSsoHandle(config: SsoConfig, overrides: SsoLifecycleOverrides): SsoAuthorization {
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

export function createAuthorization(config: Config, overrides: SsoLifecycleOverrides = {}): Authorization {
  if (isSsoConfig(config)) return adaptSsoAuthorization(createSsoHandle(config, overrides));
  if (!isServiceAuth(config.auth)) throw new Error("unreachable: authentication is neither SSO nor a service account");
  // Logins are rare, so this does not need the client's pooled sockets.
  const http = axios.create({
    baseURL: config.apiBaseUrl,
    timeout: config.http.timeoutMs,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  return new ServiceAccountAuthorization(config.auth, http, createServiceTokenStore());
}
