import { describe, expect, it } from 'vitest';
import { emailDomain, isEmailAllowed, parseAccessList, type AccessPolicy } from '../src/security/access.js';

const policy = (domains: string, emails: string): AccessPolicy => ({
  allowedEmailDomains: parseAccessList(domains),
  allowedEmails: parseAccessList(emails),
});

describe('sign-in access policy', () => {
  it('lets anyone in only while both lists are empty', () => {
    expect(isEmailAllowed('stranger@example.com', policy('', ''))).toBe(true);
    expect(isEmailAllowed('stranger@example.com', policy('northlight.dev', ''))).toBe(false);
    expect(isEmailAllowed('stranger@example.com', policy('', 'someone@gmail.com'))).toBe(false);
  });

  it('accepts a listed domain or a listed address, ignoring case and spacing', () => {
    const configured = policy(' Northlight.dev , acme.com ', ' Someone@Gmail.com ');

    expect(isEmailAllowed('sam@northlight.dev', configured)).toBe(true);
    expect(isEmailAllowed('SAM@NORTHLIGHT.DEV', configured)).toBe(true);
    expect(isEmailAllowed('someone@gmail.com', configured)).toBe(true);
    expect(isEmailAllowed('other@gmail.com', configured)).toBe(false);
  });

  it('refuses lookalike domains rather than matching on a suffix', () => {
    const configured = policy('northlight.dev', '');

    expect(isEmailAllowed('sam@evil-northlight.dev', configured)).toBe(false);
    expect(isEmailAllowed('sam@northlight.dev.evil.com', configured)).toBe(false);
    // Split on the last @, so a local part containing one cannot smuggle a domain in.
    expect(isEmailAllowed('sam@northlight.dev@evil.com', configured)).toBe(false);
    expect(emailDomain('sam@northlight.dev@evil.com')).toBe('evil.com');
  });

  it('treats malformed addresses as having no domain', () => {
    expect(emailDomain('nope')).toBeUndefined();
    expect(emailDomain('@nope.com')).toBeUndefined();
    expect(emailDomain('nope@')).toBeUndefined();
  });
});
