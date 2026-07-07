import { assertEquals } from 'jsr:@std/assert@1';
import { pureWindowOpen } from './phase.ts';

const windows = [
  { window_key: 'goal_creation', starts_on: '2027-04-01', ends_on: '2027-04-30' },
  { window_key: 'manager_approval', starts_on: '2027-04-15', ends_on: '2027-05-10' },
];

Deno.test('window open on a day inside the range (inclusive bounds)', () => {
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-01'), true);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-30'), true);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-04-15'), true);
});

Deno.test('window closed before/after the range', () => {
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-03-31'), false);
  assertEquals(pureWindowOpen(windows, 'goal_creation', '2027-05-01'), false);
});

Deno.test('overlapping windows are independent', () => {
  assertEquals(pureWindowOpen(windows, 'manager_approval', '2027-04-20'), true);
  assertEquals(pureWindowOpen(windows, 'manager_approval', '2027-04-10'), false);
});

Deno.test('missing window key is closed', () => {
  assertEquals(pureWindowOpen(windows, 'self_evaluation', '2027-04-20'), false);
});
