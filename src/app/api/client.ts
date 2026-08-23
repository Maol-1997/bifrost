import { createBifrostClient } from '@features/bifrost-api/client';

export const bifrostClient = createBifrostClient(window.location.origin);
