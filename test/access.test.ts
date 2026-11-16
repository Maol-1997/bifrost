import { describe, expect, it } from 'vitest';
import {
  emailDomain,
  isAdministrator,
  isEmailAllowed,
  parseAccessList,
  type AccessPolicy,
} from '../src/server/security/access.js';

const policy = (domains: string, emails: string): AccessPolicy => ({
  allowedEmailDomains: parseAccessList(domains),
  allowedEmails: parseAccessList(emails),
});

describe('administrator access', () => {
  it('requires an exact configured email address and ignores case and spacing', () => {
    const administrators = parseAccessList(' Admin@Example.com, owner@example.com ');

    expect(isAdministrator('admin@example.com', administrators)).toBe(true);
    expect(isAdministrator(' ADMIN@EXAMPLE.COM ', administrators)).toBe(true);
    expect(isAdministrator('other@example.com', administrators)).toBe(false);
  });

  it('grants nobody administrator access when the list is empty', () => {
    expect(isAdministrator('admin@example.com', parseAccessList(''))).toBe(false);
  });
});

describe('sign-in access policy', () => {
  it('lets anyone in only while both lists are empty', () => {
    expect(isEmailAllowed('stranger@example.com', policy('', ''))).toBe(true);
    expect(isEmailAllowed('stranger@example.com', policy('example.test', ''))).toBe(false);
    expect(isEmailAllowed('stranger@example.com', policy('', 'someone@gmail.com'))).toBe(false);
  });

  it('accepts a listed domain or a listed address, ignoring case and spacing', () => {
    const configured = policy(' Example.test , acme.com ', ' Someone@Gmail.com ');

    expect(isEmailAllowed('sam@example.test', configured)).toBe(true);
    expect(isEmailAllowed('SAM@EXAMPLE.TEST', configured)).toBe(true);
    expect(isEmailAllowed('someone@gmail.com', configured)).toBe(true);
    expect(isEmailAllowed('other@gmail.com', configured)).toBe(false);
  });

  it('refuses lookalike domains rather than matching on a suffix', () => {
    const configured = policy('example.test', '');

    expect(isEmailAllowed('sam@evil-example.test', configured)).toBe(false);
    expect(isEmailAllowed('sam@example.test.evil.com', configured)).toBe(false);
    // Split on the last @, so a local part containing one cannot smuggle a domain in.
    expect(isEmailAllowed('sam@example.test@evil.com', configured)).toBe(false);
    expect(emailDomain('sam@example.test@evil.com')).toBe('evil.com');
  });

  it('treats malformed addresses as having no domain', () => {
    expect(emailDomain('nope')).toBeUndefined();
    expect(emailDomain('@nope.com')).toBeUndefined();
    expect(emailDomain('nope@')).toBeUndefined();
  });
});
