# Encryption keys and rotation

Provider credentials are sealed with AES-256-GCM in `src/server/security/secrets.ts` and only
cross that boundary in `src/server/database/connections.ts`.

## Record format

| Version | Written by | Key | Associated data |
| --- | --- | --- | --- |
| 1 | releases before key ids | the key with id `legacy` | none |
| 2 | every write now | `keyId` stored in the record | `userId:providerId` of the row |

Version 1 records are read, never written. The associated data binds a version 2 record to its
own row. Copy the payload onto another user's or provider's row and decryption fails instead of
handing over the credential. The record's IV still doubles as the row version that refresh and
rotation compare before writing.

## Configuration

| Variables | Meaning |
| --- | --- |
| `ENCRYPTION_KEY` only | One key, id `legacy`, active. The original setup; nothing else to change. |
| `ENCRYPTION_KEYS` + `ENCRYPTION_ACTIVE_KEY_ID` | `ENCRYPTION_KEYS` is a JSON object of id to base64 key; the active id names the key new writes use. |
| both | `ENCRYPTION_KEY` joins the keyring as `legacy`, which version 1 records need. |

Startup fails if no key is configured, the active id is missing or not in the keyring, any key
does not decode to 32 bytes, or `ENCRYPTION_KEY` and `ENCRYPTION_KEYS.legacy` disagree. Ids may
use letters, digits, `.`, `_` and `-`.

## Rotating a key

1. Generate the new key: `openssl rand -base64 32`.
2. Deploy with the new key added and active, keeping every old key:

   ```bash
   ENCRYPTION_KEY=<current key>                      # still needed for version 1 rows
   ENCRYPTION_KEYS='{"2026-10":"<new key>"}'
   ENCRYPTION_ACTIVE_KEY_ID=2026-10
   ```

   From here every connect and refresh writes with the new key.
3. Dry run against production configuration, then apply:

   ```bash
   npm run rotate:credentials                        # or: node dist/server/database/rotate-credentials.js
   npm run rotate:credentials -- --apply --batch-size 100
   ```

   The dry run decrypts every pending row and writes nothing. `--apply` re-seals one row at a time
   while the service keeps running. Each row is rewritten under the same Redis lock a provider
   refresh holds and through the same version-checked UPDATE, so a refresh is never undone and
   never made to discard a token the provider already rotated. The script reports a row as `busy`
   when its refresh is in flight, and as `changedConcurrently` when someone rewrote it meanwhile,
   which means that writer already used the active key. It exits nonzero while any row is busy or
   unreadable, so run it again until it exits clean.
4. When the final usage line shows only the active key, remove the old keys and redeploy.
   Removing a key that still protects rows makes those credentials unreadable, and the affected
   users have to reconnect.

Run the script with the production `REDIS_URL`. Without Redis it cannot hold the live servers'
refresh lock and warns that only the version check protects concurrent refreshes.

## Rolling back

A release older than key ids cannot read version 2 records. Once this version has written any
credential, rolling back to such a release breaks those connections until users reconnect.
