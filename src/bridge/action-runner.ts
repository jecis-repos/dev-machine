import { runTuiBridgeAction } from './index.js';
import type { TuiBridgeAction } from './index.js';

function decodePayload(encoded: string | undefined): string | undefined {
  if (!encoded) {
    return undefined;
  }
  return Buffer.from(encoded, 'base64').toString('utf-8');
}

async function main(): Promise<void> {
  const actionArg = process.argv[2];
  const payloadEncoded = process.argv[3];
  if (!actionArg) {
    throw new Error('Missing action argument.');
  }

  const response = await runTuiBridgeAction(
    actionArg as TuiBridgeAction,
    decodePayload(payloadEncoded),
  );
  process.stdout.write(JSON.stringify(response));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message);
  process.exit(1);
});
