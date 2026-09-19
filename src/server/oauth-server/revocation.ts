import type { Coordinator } from '../coordination.js';
import { AUTHORIZATION_CODE_TTL_SECONDS } from './authorize.js';

type RevocationCoordinator = Pick<Coordinator, 'peekEphemeral' | 'setEphemeral'>;

/**
 * An authorization code outlives the grant it was issued under: the user can
 * disconnect a client while that client still holds an unredeemed code, and
 * redeeming it would recreate the grant without fresh consent. Codes cannot be
 * enumerated, so the revocation is remembered instead, for exactly as long as
 * a code issued before it could still be redeemed.
 */
export async function recordClientRevocation(
  coordinator: RevocationCoordinator,
  userId: string,
  clientId: string,
): Promise<void> {
  await coordinator.setEphemeral(revocationKey(userId, clientId), String(Date.now()), AUTHORIZATION_CODE_TTL_SECONDS);
}

export async function wasClientRevokedSince(
  coordinator: RevocationCoordinator,
  code: { userId: string; clientId: string; issuedAt: number },
): Promise<boolean> {
  const revokedAt = Number(await coordinator.peekEphemeral(revocationKey(code.userId, code.clientId)));
  return Number.isFinite(revokedAt) && revokedAt >= code.issuedAt;
}

function revocationKey(userId: string, clientId: string): string {
  return `oauth:revoked:${userId}:${clientId}`;
}
