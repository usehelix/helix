import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

export async function initiateClient() {
  const apiKey = process.env.CIRCLE_API_KEY!;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET!;
  if (!apiKey || !entitySecret) {
    throw new Error('Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET');
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}
