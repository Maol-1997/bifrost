/**
 * Who is allowed to sign in.
 *
 * Two independent allowlists that OR together: whole domains for the team, and
 * exact addresses for the people who fall outside them (contractors, personal
 * accounts). With both empty Bifrost stays open to any verified Google account
 * — the historical behaviour — and the sign-in screen has to say so out loud
 * rather than claiming a restriction that is not enforced.
 */

export type AccessPolicy = {
  allowedEmailDomains: ReadonlySet<string>;
  allowedEmails: ReadonlySet<string>;
};

export function parseAccessList(raw: string): ReadonlySet<string> {
  return new Set(raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

export function isAccessRestricted(policy: AccessPolicy): boolean {
  return policy.allowedEmailDomains.size > 0 || policy.allowedEmails.size > 0;
}

export function isEmailAllowed(email: string, policy: AccessPolicy): boolean {
  if (!isAccessRestricted(policy)) return true;
  const normalized = email.trim().toLowerCase();
  if (policy.allowedEmails.has(normalized)) return true;
  const domain = emailDomain(normalized);
  return domain !== undefined && policy.allowedEmailDomains.has(domain);
}

/**
 * Split on the LAST `@`: the local part of an address may legally contain one,
 * and taking the first would let `attacker@evil.com@` style input pass.
 */
export function emailDomain(email: string): string | undefined {
  const separator = email.lastIndexOf('@');
  if (separator <= 0 || separator === email.length - 1) return undefined;
  return email.slice(separator + 1);
}
