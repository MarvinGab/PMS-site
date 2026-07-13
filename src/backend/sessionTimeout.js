export const SESSION_TIMEOUT_EVENT = 'zarohr-session-timeout';

export function isSessionTimeoutMessage(message = '') {
  const text = String(message || '').toLowerCase();
  return text.includes('sign in again')
    || text.includes('session has expired')
    || text.includes('session is missing or expired')
    || text.includes('serversessiontoken is required');
}

export function notifySessionTimeout(message = '') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(SESSION_TIMEOUT_EVENT, {
    detail: {
      message: String(message || '').trim(),
    },
  }));
}
