// Central notification helper. Every lifecycle event (goal creation, approvals,
// self-eval prompts, publish, acknowledgement, concern resolution…) should go
// through pushNotification so it lands in the in-app bell AND — when the org has
// "Send communications by email too" turned on — is also emailed to the
// recipient. Kept dependency-light so any page can call it.

import { readWorkflowSync, persistWorkflow } from './stateStore';
import { sendCustomBroadcast } from './emailService';

function normCode(v) {
  return String(v || '').trim().toUpperCase();
}

// Append a notification to the workflow bell feed. Synchronous + safe.
export function addBellNotification(orgKey, notif) {
  if (!orgKey || !notif) return;
  const wf = readWorkflowSync(orgKey) || { submissions: {}, notifications: [] };
  persistWorkflow(orgKey, { ...wf, notifications: [notif, ...(wf.notifications || [])] });
}

// Append MANY notifications in a SINGLE store write. Use this instead of calling
// addBellNotification in a loop — one write for the whole batch, not one per
// recipient (which is what made publish slow at roster scale).
export function addBellNotifications(orgKey, notifs = []) {
  if (!orgKey || !Array.isArray(notifs) || notifs.length === 0) return;
  const wf = readWorkflowSync(orgKey) || { submissions: {}, notifications: [] };
  persistWorkflow(orgKey, { ...wf, notifications: [...notifs, ...(wf.notifications || [])] });
}

// True when the org opted into email mirroring. Default OFF.
export function emailCommsOn(config) {
  return config?.emailCommsEnabled === true;
}

// Resolve a recipient's email + display name from the roster.
function findRecipient(employees, recipientCode) {
  const code = normCode(recipientCode);
  const emp = (employees || []).find((e) => normCode(e['Employee Code']) === code);
  if (!emp) return null;
  const email = String(emp['Email ID'] || emp.Email || '').trim();
  if (!email) return null;
  return { 'Employee Name': emp['Employee Name'] || code, 'Email ID': email, 'Employee Code': emp['Employee Code'] || code };
}

// The main entry point. Always writes the bell notification; additionally sends
// an email when the org toggle is on and we can resolve the recipient's inbox.
// `email` (optional) overrides the emailed subject/body; otherwise the bell
// title/message are reused.
export async function pushNotification({ orgKey, org, config, employees = [], notif, email } = {}) {
  if (!orgKey || !notif) return { ok: false, emailed: false };
  addBellNotification(orgKey, notif);
  if (!emailCommsOn(config) || !org) return { ok: true, emailed: false };
  const recipient = findRecipient(employees, notif.recipientCode);
  if (!recipient) return { ok: true, emailed: false };
  try {
    await sendCustomBroadcast({
      org,
      recipients: [recipient],
      template: {
        subject: (email && email.subject) || notif.title || 'Update',
        body: (email && email.body) || notif.message || '',
      },
    });
    return { ok: true, emailed: true };
  } catch {
    // Email is best-effort — the bell notification already landed.
    return { ok: true, emailed: false };
  }
}
