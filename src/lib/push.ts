// Remote push via Expo's push service (https://exp.host/--/api/v2/push/send).
// The mobile app currently uses LOCAL notifications only (they work offline
// and are the working path). This helper exists so the backend can send
// remote push once the app registers its Expo push token (registerpushtoken).
// Nothing calls sendPush on a schedule yet — see README.
export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendExpoPush(messages: PushMessage[]): Promise<unknown> {
  if (messages.length === 0) return null;
  const res = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(messages),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Expo push failed (HTTP ${res.status}): ${JSON.stringify(json)}`);
  }
  return json;
}
