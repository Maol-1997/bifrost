import { describe, expect, it } from 'vitest';
import type { ProviderAgentNote } from '../src/server/db.js';
import type { ProviderId } from '../src/server/providers/types.js';
import {
  PROVIDER_AGENT_NOTE_MAX_LENGTH,
  providerAgentNoteInstructions,
  providerAgentNoteSchema,
} from '../src/server/tools/provider-agent-notes.js';

describe('provider agent notes', () => {
  it('trims a note before storing it', () => {
    expect(providerAgentNoteSchema.parse('  Focus on pull requests.  ')).toBe('Focus on pull requests.');
  });

  it('rejects an empty note', () => {
    expect(providerAgentNoteSchema.safeParse('   ').success).toBe(false);
  });

  it('accepts the maximum note length', () => {
    expect(providerAgentNoteSchema.safeParse('a'.repeat(PROVIDER_AGENT_NOTE_MAX_LENGTH)).success).toBe(true);
  });

  it('rejects a note beyond the maximum length', () => {
    expect(providerAgentNoteSchema.safeParse('a'.repeat(PROVIDER_AGENT_NOTE_MAX_LENGTH + 1)).success).toBe(false);
  });

  it('tells the agent how replacement notes behave when none exist', () => {
    expect(providerAgentNoteInstructions(new Map())).toContain('Each save replaces the previous note');
  });

  it('includes stored notes in deterministic provider order', () => {
    const updatedAt = new Date('2026-08-20T00:00:00.000Z');
    const notes = new Map<ProviderId, ProviderAgentNote>([
      ['linear', { note: 'Focus on projects.', updatedAt }],
      ['github', { note: 'Focus on PRs.\nIgnore stars.', updatedAt }],
    ]);

    expect(providerAgentNoteInstructions(notes)).toContain([
      'Stored provider notes:',
      '- github: "Focus on PRs.\\nIgnore stars."',
      '- linear: "Focus on projects."',
    ].join('\n'));
  });
});
