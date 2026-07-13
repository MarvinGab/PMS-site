import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveIdentity } from './identity.js';

test('super admin from org-null super_admin membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: null, roles: ['super_admin'], employeeId: null }]);
  assert.equal(id.role, 'super_admin');
  assert.equal(id.orgId, null);
});

test('hr_admin from org membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: 'org1', roles: ['hr_admin'], employeeId: 'e1' }]);
  assert.equal(id.role, 'hr_admin');
  assert.equal(id.orgId, 'org1');
  assert.equal(id.employeeId, 'e1');
});

test('employee from org membership', () => {
  const id = deriveIdentity([{ memberId: 'm', organizationId: 'org1', roles: ['employee'], employeeId: 'e2' }]);
  assert.equal(id.role, 'employee');
  assert.equal(id.employeeId, 'e2');
});

test('super admin wins even with an org membership present', () => {
  const id = deriveIdentity([
    { organizationId: 'org1', roles: ['employee'], employeeId: 'e2' },
    { organizationId: null, roles: ['super_admin'], employeeId: null },
  ]);
  assert.equal(id.role, 'super_admin');
});

test('no memberships → null role', () => {
  const id = deriveIdentity([]);
  assert.equal(id.role, null);
  assert.equal(id.orgId, null);
});

test('undefined input does not throw', () => {
  const id = deriveIdentity(undefined);
  assert.equal(id.role, null);
});

test('org-scoped super_admin role is NOT surfaced as super-admin', () => {
  const id = deriveIdentity([{ organizationId: 'org1', roles: ['super_admin'], employeeId: 'e9' }]);
  assert.equal(id.role, null); // neither hr_admin nor employee → null, not super_admin
  assert.equal(id.orgId, 'org1');
});
