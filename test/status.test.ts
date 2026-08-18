import { describe, expect, it } from 'vitest';
import { describeClient } from '../src/clients/describe.js';
import { statuspageHealth, type StatuspageIndicator } from '../src/status/upstream.js';

describe('statuspage severity mapping', () => {
  it('never reports a non-none indicator as operational', () => {
    const indicators: readonly StatuspageIndicator[] = ['minor', 'major', 'critical', 'maintenance'];

    expect(indicators.map(statuspageHealth)).toEqual(['degraded', 'down', 'down', 'degraded']);
    expect(statuspageHealth('none')).toBe('operational');
  });
});

describe('client identification', () => {
  it('names the clients we know from their user agent', () => {
    expect(describeClient('mcp', 'claude-cli/1.4.2 (external, cli)').name).toBe('Claude Code');
    expect(describeClient('mcp', 'Cursor/0.45.1').name).toBe('Cursor');
    expect(describeClient('bifrost-web', 'Mozilla/5.0').name).toBe('Bifrost web');
  });

  it('shows an unrecognized client verbatim instead of inventing a name', () => {
    // A client the user cannot identify is the one they may want to revoke, so
    // guessing a friendly label here would hide exactly the wrong thing.
    expect(describeClient('mcp', 'weird-agent/9.9 (unknown)')).toEqual({ name: 'weird-agent', monogram: 'we', logo: undefined });
    expect(describeClient('mcp', undefined)).toEqual({ name: 'mcp', monogram: 'mc', logo: undefined });
  });

  it('hands the clients we ship a mark for their own logo', () => {
    expect(describeClient('mcp', 'claude-code/2.1.234 (cli)').logo).toBe('claude-code');
    expect(describeClient('mcp', 'codex_cli_rs/0.5.0').logo).toBe('codex');
    expect(describeClient('mcp', 'Cursor/0.45.1').logo).toBe('cursor');
    expect(describeClient('opencode', undefined).logo).toBe('opencode');
  });

  it('keeps OpenCode and Codex apart', () => {
    // Two different products whose names both end in "code[x]". Reading one as
    // the other would put the wrong company's logo on the user's screen.
    expect(describeClient('opencode', 'opencode/0.4.1').name).toBe('OpenCode');
    expect(describeClient('mcp', 'codex/0.5.0').name).toBe('Codex');
  });

  it('leaves a recognized client without a mark on its monogram', () => {
    expect(describeClient('mcp', 'Windsurf/1.2.0').logo).toBeUndefined();
    expect(describeClient('mcp', 'Windsurf/1.2.0').monogram).toBe('Wi');
  });
});
