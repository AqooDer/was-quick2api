import crypto from 'node:crypto';

function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function unwrapUsage(raw) {
  let value = raw;
  for (let depth = 0; depth < 6; depth++) {
    value = parseMaybeJson(value);
    if (!value || typeof value !== 'object') break;
    if (value.eventResponse && value.eventResponse.invokeAgentResponse !== undefined) {
      value = value.eventResponse.invokeAgentResponse;
      continue;
    }
    if (value.invokeAgentResponse !== undefined) {
      value = value.invokeAgentResponse;
      continue;
    }
    if (value.type === 'api_response' && value.body !== undefined) {
      value = value.body;
      if (value && typeof value === 'object' && value.body_encoding === 'base64') {
        value = Buffer.from(value.body, 'base64').toString('utf8');
      }
      continue;
    }
    if (value.monthly || value.session || value.overage_monthly) break;
  }
  return value && typeof value === 'object' ? value : null;
}

function bucket(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const used = Number(raw.used);
  const limit = Number(raw.limit);
  if (!Number.isFinite(used) && !Number.isFinite(limit)) return null;
  return {
    used: Number.isFinite(used) ? used : null,
    limit: Number.isFinite(limit) ? limit : null,
    percent: Number.isFinite(Number(raw.percent)) ? Number(raw.percent) : null,
    resetsAt: Number.isFinite(Number(raw.resets_at)) ? Number(raw.resets_at) : null,
    resumeInMinutes: Number.isFinite(Number(raw.resume_in_minutes)) ? Number(raw.resume_in_minutes) : null,
    warning: raw.warning && typeof raw.warning === 'object'
      ? {
          title: String(raw.warning.title || '').slice(0, 300),
          detail: String(raw.warning.detail || '').slice(0, 500),
          severity: String(raw.warning.severity || ''),
        }
      : null,
  };
}

/**
 * Read the official monthly/session usage from Quick's profile/usage RPC.
 * Returns minutes, not tokens.
 */
export async function fetchUsage(account, cfg) {
  const token = String(account?.id_token || account?.access_token || '').trim();
  if (!token) throw new Error('account has no token');
  let base = String(account.tenant_url || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('account has no tenant_url');
  if (!base.includes('://')) base = `https://${base}`;

  const body = JSON.stringify({
    eventType: 'invokeAgent',
    eventBody: {
      invokeAgent: {
        path: 'profile/usage',
        queryParams: {
          _method: 'GET',
          ...(cfg.surface ? { surfaceType: cfg.surface } : {}),
          ...(cfg.app_version ? { appVersion: cfg.app_version } : {}),
        },
        body: {},
      },
    },
  });
  const response = await fetch(`${base}/integration/quick-work/qbs-event`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'x-amzn-qs-internal-trace-id': crypto.randomUUID(),
    },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) throw new Error('usage authorization failed');
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`usage HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('usage returned invalid JSON');
  }
  const payload = unwrapUsage(raw);
  if (!payload) throw new Error('usage payload is unavailable');
  const monthly = bucket(payload.monthly);
  const session = bucket(payload.session);
  const overage = bucket(payload.overage_monthly);
  if (!monthly && !overage && !session) throw new Error('usage payload has no buckets');
  return {
    source: 'quickwork_profile_usage',
    unit: 'minutes',
    monthly,
    session,
    overage,
    subscription: payload.subscription && typeof payload.subscription === 'object'
      ? {
          type: String(payload.subscription.subscription_type || ''),
          freeTrial: payload.subscription.free_trial_metadata || null,
        }
      : null,
    fetchedAt: Math.floor(Date.now() / 1000),
  };
}
