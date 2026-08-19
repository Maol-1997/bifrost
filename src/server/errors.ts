/**
 * An error whose message is written for the calling agent, not for an operator.
 *
 * Tool execution returns `message` verbatim only for these; anything else is
 * logged and replaced with a generic failure, so a database or upstream error
 * never narrates its internals to the client.
 */
export class AgentFacingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentFacingError';
  }
}
