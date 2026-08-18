import { z } from 'zod';
import { fetchJson } from './http.js';
import { defineTool, type ProviderDefinition, type ToolExecutionContext } from './types.js';

type GraphQlResponse = { data?: unknown; errors?: Array<{ message: string }> };

async function linearGraphQl(query: string, variables: Record<string, unknown>, context: ToolExecutionContext): Promise<unknown> {
  const result = await fetchJson<GraphQlResponse>('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${context.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  }, context.signal);
  if (result.errors?.length) throw new Error(`Linear request failed: ${result.errors[0]?.message ?? 'unknown GraphQL error'}`);
  return result.data;
}

const tools = [
  defineTool({
    name: 'linear_search_issues', title: 'Search issues', description: 'Search Linear issues by text.', mutability: 'read',
    inputSchema: z.object({ query: z.string().min(1).max(300), first: z.number().int().min(1).max(50).default(20) }),
    execute: ({ query, first }, context) => linearGraphQl('query Search($term:String!,$first:Int!){issueSearch(query:$term,first:$first){nodes{id identifier title url state{name} assignee{name}}}}', { term: query, first }, context),
  }),
  defineTool({
    name: 'linear_get_issue', title: 'Get issue', description: 'Get a Linear issue by identifier or ID.', mutability: 'read',
    inputSchema: z.object({ id: z.string().min(1).max(100) }),
    execute: ({ id }, context) => linearGraphQl('query Issue($id:String!){issue(id:$id){id identifier title description url state{name} assignee{name} team{id name key} project{id name}}}', { id }, context),
  }),
  defineTool({
    name: 'linear_list_my_issues', title: 'List my issues', description: 'List issues assigned to the authenticated Linear user.', mutability: 'read',
    inputSchema: z.object({ first: z.number().int().min(1).max(50).default(20) }),
    execute: ({ first }, context) => linearGraphQl('query Mine($first:Int!){viewer{assignedIssues(first:$first){nodes{id identifier title url state{name}}}}}', { first }, context),
  }),
  defineTool({
    name: 'linear_create_issue', title: 'Create issue', description: 'Create a Linear issue.', mutability: 'write',
    inputSchema: z.object({ teamId: z.uuid(), title: z.string().min(1).max(500), description: z.string().max(100_000).optional() }),
    execute: ({ teamId, title, description }, context) => linearGraphQl('mutation Create($input:IssueCreateInput!){issueCreate(input:$input){success issue{id identifier title url}}}', { input: { teamId, title, description } }, context),
  }),
  defineTool({
    name: 'linear_add_comment', title: 'Add comment', description: 'Add a comment to a Linear issue.', mutability: 'write',
    inputSchema: z.object({ issueId: z.string().min(1).max(100), body: z.string().min(1).max(100_000) }),
    execute: ({ issueId, body }, context) => linearGraphQl('mutation Comment($input:CommentCreateInput!){commentCreate(input:$input){success comment{id body}}}', { input: { issueId, body } }, context),
  }),
  defineTool({
    name: 'linear_list_teams_projects', title: 'List teams and projects', description: 'List the current workspace teams and projects.', mutability: 'read',
    inputSchema: z.object({}),
    execute: (_input, context) => linearGraphQl('query TeamsProjects{teams{nodes{id key name projects{nodes{id name state}}}}}', {}, context),
  }),
];

const viewerSchema = z.object({ viewer: z.object({ email: z.string().min(1) }) });

export const linearProvider: ProviderDefinition = {
  id: 'linear', prefix: 'linear_', displayName: 'Linear',
  authorizationUrl: 'https://linear.app/oauth/authorize', tokenUrl: 'https://api.linear.app/oauth/token',
  scopes: ['read', 'write', 'issues:create', 'comments:create'], tools,
  readAccountLabel: async (accessToken, signal) => {
    const result = await fetchJson<GraphQlResponse>('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query Viewer{viewer{email}}' }),
    }, signal);
    if (result.errors?.length) throw new Error(`Linear identity lookup failed: ${result.errors[0]?.message ?? 'unknown GraphQL error'}`);
    return viewerSchema.parse(result.data).viewer.email;
  },
};
