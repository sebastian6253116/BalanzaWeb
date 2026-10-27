const TOKEN_KEY = 'balanza.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) => localStorage.setItem(TOKEN_KEY, token);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error ?? `HTTP ${response.status}`, response.status, data);
  return data;
}

function attachmentName(header) {
  if (!header) return null;
  const match = /filename="?([^";]+)"?/i.exec(header);
  return match ? match[1].trim() : null;
}

export async function download(path, fallbackName) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const response = await fetch(`/api${path}`, { headers });
  if (!response.ok) {
    let data = null;
    try {
      data = JSON.parse(await response.text());
    } catch {
      data = null;
    }
    throw new ApiError(data?.error ?? `HTTP ${response.status}`, response.status, data);
  }

  const blob = await response.blob();
  const filename = attachmentName(response.headers.get('content-disposition')) ?? fallbackName;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

export const money = (cents) => (cents / 100).toFixed(2);
