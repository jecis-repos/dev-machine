const WEBHOOK_URL = process.env.DEVMACHINE_WEBHOOK_URL?.trim() ?? "";

/**
 * Send async webhook notification. Non-blocking, best-effort.
 */
export async function notifyWebhook(
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...data }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    process.stderr.write(`[webhook] Failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
