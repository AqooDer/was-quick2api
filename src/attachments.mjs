// Quick DataPlane attachment upload:
// upload-attachment -> attachment-dlp-status -> qbs-event files/upload/{thread}
// The returned path goes into user_message.payload.attachments[].
import { sleep } from './util.mjs';

const DLP_INTERVAL_MS = 1500;
const DLP_ATTEMPTS = 40;

function tenantBase(raw) {
  let base = String(raw || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('account has no tenant_url');
  if (!base.includes('://')) base = `https://${base}`;
  const u = new URL(base);
  if (!u.host) throw new Error('invalid tenant_url');
  return base;
}

async function jsonRequest(url, { method = 'GET', headers, body } = {}) {
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120_000) });
  const text = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 1200)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${new URL(url).host}`);
  }
}

function findPath(value) {
  if (typeof value === 'string') {
    try {
      return findPath(JSON.parse(value));
    } catch {
      return '';
    }
  }
  if (!value || typeof value !== 'object') return '';
  if (typeof value.path === 'string' && value.path) return value.path;
  if (Array.isArray(value.files) && value.files[0]?.path) return value.files[0].path;
  for (const child of Object.values(value)) {
    const found = findPath(child);
    if (found) return found;
  }
  return '';
}

/**
 * Upload one image/file and bind it to a Quick thread. Returns the metadata
 * that belongs in user_message.payload.attachments.
 */
export async function uploadAttachment(account, { bytes, name, mimeType, threadId, logger = () => {} }) {
  const base = tenantBase(account.tenant_url);
  const token = String(account.id_token || account.access_token || '').trim();
  if (!token) throw new Error('account has no jwt/id_token');
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('attachment is empty');

  const headers = { authorization: `Bearer ${token}`, origin: 'https://quick.aws.com' };
  const query = new URLSearchParams({
    name,
    contentType: mimeType,
    contentLength: String(bytes.length),
  });
  const uploaded = await jsonRequest(`${base}/integration/quick-work/upload-attachment?${query}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  const attachmentId = String(uploaded.attachmentId || '').trim();
  let path = String(uploaded.path || uploaded.files?.[0]?.path || '').trim();
  if (!attachmentId && !path) throw new Error('upload-attachment returned no id or path');

  if (attachmentId) {
    let decided = false;
    for (let attempt = 0; attempt < DLP_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(DLP_INTERVAL_MS);
      const status = await jsonRequest(
        `${base}/integration/quick-work/attachment-dlp-status?attachmentId=${encodeURIComponent(attachmentId)}`,
        { headers },
      );
      const action = String(status.policyAction || '').toUpperCase();
      const job = String(status.dlpJobStatus || '').toUpperCase();
      if (action === 'ALLOW' || ['SKIPPED', 'NOT_APPLICABLE', 'DISABLED'].includes(job)) {
        decided = true;
        break;
      }
      if (['BLOCK', 'DENY', 'REJECT', 'WARN'].includes(action) || ['FAILED', 'ERROR'].includes(job)) {
        throw new Error(`attachment blocked by DLP (${action || job})`);
      }
    }
    if (!decided) throw new Error('attachment DLP scan did not settle');
  }

  if (!path && attachmentId) {
    const event = {
      eventType: 'invokeAgent',
      eventBody: {
        invokeAgent: {
          path: `files/upload/${encodeURIComponent(threadId)}`,
          queryParams: { _method: 'POST' },
          body: { attachmentId },
        },
      },
    };
    const delivered = await jsonRequest(`${base}/integration/quick-work/qbs-event`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    path = findPath(delivered);
    if (!path) throw new Error('files/upload returned no path');
  }

  logger(`attachment ready name=${name} bytes=${bytes.length} id=${attachmentId ? 'yes' : 'no'}`);
  return {
    type: 'file',
    name,
    size: bytes.length,
    mimeType,
    path,
    ...(attachmentId ? { attachmentId } : {}),
  };
}
