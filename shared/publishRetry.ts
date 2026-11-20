/** livekit-client holds a publish while its signal socket is reconnecting and rejects it after
 *  15 s with a PublishTrackError whose status is 408. Seen in the e2e suites as the first publish
 *  right after churn (Present; the mic after "I'm back"). Wait for the room to be back, try once
 *  more; anything else is rethrown untouched. */
export async function publishOnceReconnected<T>(
  fn: () => Promise<T>,
  isConnected: () => boolean,
  opts: { waitMs?: number; stepMs?: number } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if ((e as { status?: number } | null)?.status !== 408) throw e;
    const until = Date.now() + (opts.waitMs ?? 10_000);
    while (!isConnected() && Date.now() < until) await new Promise((r) => setTimeout(r, opts.stepMs ?? 200));
    return await fn();
  }
}
