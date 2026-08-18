import { z } from 'zod';
import { fetchJson, fetchText } from './http.js';
import { defineTool, type ProviderDefinition, type ToolExecutionContext } from './types.js';

const repositorySchema = z.object({ owner: z.string().min(1).max(100), repo: z.string().min(1).max(100) });
const pullRequestSchema = repositorySchema.extend({ pullNumber: z.number().int().positive() });

function githubRequest<T>(path: string, context: ToolExecutionContext, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Accept', headers.get('Accept') ?? 'application/vnd.github+json');
  headers.set('Authorization', `Bearer ${context.accessToken}`);
  headers.set('X-GitHub-Api-Version', '2022-11-28');
  headers.set('Content-Type', 'application/json');
  return fetchJson<T>(`https://api.github.com${path}`, {
    ...init,
    headers,
  }, context.signal);
}

function githubTextRequest(path: string, context: ToolExecutionContext): Promise<string> {
  return fetchText(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github.diff', Authorization: `Bearer ${context.accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  }, context.signal);
}

const tools = [
  defineTool({
    name: 'github_list_pull_requests', title: 'List pull requests', description: 'List pull requests in a GitHub repository.', mutability: 'read',
    inputSchema: repositorySchema.extend({ state: z.enum(['open', 'closed', 'all']).default('open') }),
    execute: ({ owner, repo, state }, context) => githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}`, context),
  }),
  defineTool({
    name: 'github_get_pull_request', title: 'Get pull request', description: 'Get a GitHub pull request.', mutability: 'read', inputSchema: pullRequestSchema,
    execute: ({ owner, repo, pullNumber }, context) => githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`, context),
  }),
  defineTool({
    name: 'github_get_pull_request_diff', title: 'Get pull request diff', description: 'Get the unified diff for a pull request.', mutability: 'read', inputSchema: pullRequestSchema,
    execute: ({ owner, repo, pullNumber }, context) => githubTextRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}`, context),
  }),
  defineTool({
    name: 'github_list_review_comments', title: 'List review comments', description: 'List review comments on a pull request.', mutability: 'read', inputSchema: pullRequestSchema,
    execute: ({ owner, repo, pullNumber }, context) => githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/comments`, context),
  }),
  defineTool({
    name: 'github_create_issue_comment', title: 'Create issue comment', description: 'Create a comment on a GitHub issue or pull request.', mutability: 'write',
    inputSchema: repositorySchema.extend({ issueNumber: z.number().int().positive(), body: z.string().min(1).max(65_536) }),
    execute: ({ owner, repo, issueNumber, body }, context) => githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${issueNumber}/comments`, context, { method: 'POST', body: JSON.stringify({ body }) }),
  }),
  defineTool({
    name: 'github_list_check_runs', title: 'List check runs', description: 'List check runs for a Git reference.', mutability: 'read',
    inputSchema: repositorySchema.extend({ ref: z.string().min(1).max(255) }),
    execute: ({ owner, repo, ref }, context) => githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}/check-runs`, context),
  }),
];

export const githubProvider: ProviderDefinition = {
  id: 'github', prefix: 'github_', displayName: 'GitHub',
  authorizationUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token',
  scopes: ['read:user', 'user:email', 'repo'], tools,
};
