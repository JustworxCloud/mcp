// OAuth 2.1 access-token verifier — the Resource Server side. The remote MCP server does NOT issue
// tokens; it validates the ones minted by the OAuth authorization server via that AS's JWKS,
// then hands the SDK's requireBearerAuth an AuthInfo. A 401 (not 500) on a bad token requires
// throwing the SDK's InvalidTokenError.

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

/**
 * @param {object} opts
 * @param {string} opts.issuer   expected `iss` (the AS)
 * @param {string} [opts.jwksUrl] the AS JWKS endpoint (used unless `jwks` is injected)
 * @param {string} [opts.audience] expected `aud` — this server's resource URL (RFC 8707). Enforced when set.
 * @param {Function} [opts.jwks]  injected key resolver (tests) — a jose JWKS function
 * @returns {{ verifyAccessToken(token: string): Promise<import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo> }}
 */
export function createTokenVerifier({ issuer, jwksUrl, audience, jwks } = {}) {
  const keys = jwks || createRemoteJWKSet(new URL(jwksUrl));
  // Accept the resource id with AND without a trailing slash. The advertised resource (PRM) is a
  // URL.href (always `…/`) while MCP_RESOURCE_URL is often set without the slash; the AS binds the
  // audience to whatever the client sent (RFC 8707 `resource`), so a strict exact-match would reject
  // a valid token over a cosmetic slash. jose passes if the token's `aud` contains ANY of these.
  const audiences = audience ? audienceVariants(audience) : undefined;
  return {
    async verifyAccessToken(token) {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, keys, {
          issuer,
          ...(audiences ? { audience: audiences } : {}),
        }));
      } catch (err) {
        throw new InvalidTokenError(`token verification failed: ${err.message}`);
      }
      // Scopes: OAuth `scope` (space-delimited string) or `scp` (array); either is accepted.
      const scopes = typeof payload.scope === 'string'
        ? payload.scope.split(' ').filter(Boolean)
        : Array.isArray(payload.scp) ? payload.scp : [];
      if (typeof payload.exp !== 'number') {
        throw new InvalidTokenError('token has no expiration (exp) claim');
      }
      return {
        token,
        clientId: payload.client_id || payload.azp || payload.cid || '',
        scopes,
        expiresAt: payload.exp, // seconds since epoch — requireBearerAuth enforces this
        extra: { sub: payload.sub },
      };
    },
  };
}

// [resource, resource-with-toggled-trailing-slash], deduped — tolerates the `…/` vs `…` mismatch.
function audienceVariants(resource) {
  const alt = resource.endsWith('/') ? resource.slice(0, -1) : resource + '/';
  return [...new Set([resource, alt])];
}
