import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import { renderEmail } from './emailTemplates.ts';

Deno.test('invite renders the action link and a subject', () => {
  const r = renderEmail('invite', { actionLink: 'https://app/set?token=abc', orgName: 'Acme' });
  assertStringIncludes(r.subject.toLowerCase(), 'invit');
  assertStringIncludes(r.html, 'https://app/set?token=abc');
  assertStringIncludes(r.text, 'https://app/set?token=abc');
});

Deno.test('publish renders a results-ready message', () => {
  const r = renderEmail('publish', { cycleName: 'FY26', orgName: 'Acme' });
  assertStringIncludes(r.subject.toLowerCase(), 'result');
  assertStringIncludes(r.html, 'FY26');
});

Deno.test('reminder renders the stage', () => {
  const r = renderEmail('reminder', { stage: 'self evaluation', cycleName: 'FY26' });
  assertStringIncludes(r.text.toLowerCase(), 'self evaluation');
});

Deno.test('unknown template falls back safely (no throw)', () => {
  const r = renderEmail('mystery', { subject: 'Hi there' }, 'Notification');
  assertEquals(typeof r.html, 'string');
  assertEquals(typeof r.text, 'string');
  assertStringIncludes(r.subject, 'Hi there');
});

Deno.test('payload values are HTML-escaped', () => {
  const r = renderEmail('publish', { cycleName: '<script>x</script>', orgName: 'Acme' });
  assertEquals(r.html.includes('<script>x</script>'), false);
  assertStringIncludes(r.html, '&lt;script&gt;');
});

Deno.test('generic fallback escapes the HTML body/title but keeps the subject plaintext', () => {
  const r = renderEmail('mystery', { subject: 'Q&A <b>', body: '<script>x</script>' }, 'Notification');
  // Subject is a plaintext email header — returned verbatim (not HTML-mangled).
  assertEquals(r.subject, 'Q&A <b>');
  // The html (the real injection sink) escapes both the title and the body.
  assertEquals(r.html.includes('<script>x</script>'), false);
  assertStringIncludes(r.html, '&lt;script&gt;');
  assertStringIncludes(r.html, 'Q&amp;A &lt;b&gt;');
});
