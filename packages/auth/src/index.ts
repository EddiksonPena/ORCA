import type { IncomingMessage } from "node:http";

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AppConfig } from "@orca/config";

export interface AuthorizationResult {
  authorized: boolean;
  reason?: string;
  principal?: string;
  mechanism?: "api-key" | "jwt" | "none";
}

const parseScopes = (payload: Record<string, unknown>): string[] => {
  const scope = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
  const scp = Array.isArray(payload.scp) ? payload.scp.filter((entry): entry is string => typeof entry === "string") : [];
  return Array.from(new Set([...scope, ...scp].filter(Boolean)));
};

export const createRequestAuthorizer = (config: AppConfig) => {
  const jwksUrl = config.orcaJwksUrl
    ?? (config.orcaJwtIssuer ? new URL("/.well-known/jwks.json", config.orcaJwtIssuer).toString() : undefined);
  const jwks = jwksUrl ? createRemoteJWKSet(new URL(jwksUrl)) : undefined;

  const authorizeApiKey = (req: IncomingMessage): AuthorizationResult => {
    if (!config.orcaApiKey) {
      return { authorized: false, reason: "api_key_not_configured" };
    }

    const apiKey = req.headers["x-api-key"];
    if (apiKey === config.orcaApiKey) {
      return { authorized: true, principal: "api-key", mechanism: "api-key" };
    }

    const authorization = req.headers.authorization ?? "";
    if (authorization === `Bearer ${config.orcaApiKey}`) {
      return { authorized: true, principal: "api-key", mechanism: "api-key" };
    }

    return { authorized: false, reason: "invalid_api_key" };
  };

  const authorizeJwt = async (req: IncomingMessage): Promise<AuthorizationResult> => {
    if (!jwks) {
      return { authorized: false, reason: "jwks_not_configured" };
    }

    const authorization = req.headers.authorization ?? "";
    if (!authorization.startsWith("Bearer ")) {
      return { authorized: false, reason: "missing_bearer_token" };
    }

    const token = authorization.slice("Bearer ".length).trim();
    if (!token) {
      return { authorized: false, reason: "missing_bearer_token" };
    }

    try {
      const verification = await jwtVerify(token, jwks, {
        ...(config.orcaJwtIssuer ? { issuer: config.orcaJwtIssuer } : {}),
        ...(config.orcaJwtAudience ? { audience: config.orcaJwtAudience } : {}),
      });

      const scopes = parseScopes(verification.payload as Record<string, unknown>);
      const missingScopes = config.orcaJwtRequiredScopes.filter((scope) => !scopes.includes(scope));
      if (missingScopes.length > 0) {
        return {
          authorized: false,
          reason: `missing_required_scopes:${missingScopes.join(",")}`,
        };
      }

      return {
        authorized: true,
        principal:
          typeof verification.payload.sub === "string"
            ? verification.payload.sub
            : typeof verification.payload.client_id === "string"
              ? verification.payload.client_id
              : "jwt",
        mechanism: "jwt",
      };
    } catch (error) {
      return {
        authorized: false,
        reason: `jwt_verification_failed:${(error as Error).message}`,
      };
    }
  };

  return {
    mode: config.orcaAuthMode,
    async authorize(req: IncomingMessage): Promise<AuthorizationResult> {
      if (config.orcaAuthMode === "none") {
        return { authorized: true, principal: "anonymous", mechanism: "none" };
      }

      if (config.orcaAuthMode === "api-key") {
        return authorizeApiKey(req);
      }

      if (config.orcaAuthMode === "jwt") {
        return authorizeJwt(req);
      }

      const apiKeyResult = authorizeApiKey(req);
      if (apiKeyResult.authorized) {
        return apiKeyResult;
      }

      return authorizeJwt(req);
    },
  };
};
