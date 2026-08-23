import type { Config } from '../config.js';
import type { Coordinator } from '../coordination.js';
import type { Database } from '../database/index.js';

export type OAuthServerContext = {
  config: Config;
  database: Database;
  coordinator: Coordinator;
};

/**
 * What an OAuth endpoint decided, before anything is written to the socket.
 *
 * Returning a value rather than taking a `ServerResponse` keeps the protocol
 * rules — which redirect, which status, which body — testable without a server,
 * and keeps every OAuth response going through one HTTP adapter.
 */
export type OAuthHttpResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'html'; status: number; body: string }
  | { kind: 'json'; status: number; body: unknown }
  /**
   * The request is valid but nobody is signed in. Resolved by the HTTP adapter
   * rather than here, so that knowing how a human proves who they are stays
   * with the Google client and out of the authorization server.
   */
  | { kind: 'sign-in-required'; returnTo: string };
