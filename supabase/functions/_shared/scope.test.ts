import { assertEquals, assertThrows } from 'jsr:@std/assert@1';
import { ApiError } from './kernel.ts';
import { callerEmployeeId, isHrOrSuper } from './scope.ts';

function ctx(memberships: unknown) {
  return { memberships } as unknown as import('./kernel.ts').HandlerCtx;
}

Deno.test('callerEmployeeId returns the org employee id', () => {
  const c = ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: 'emp1' }]);
  assertEquals(callerEmployeeId(c, 'org1'), 'emp1');
});

Deno.test('callerEmployeeId throws when no employee row in the org', () => {
  const c = ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: null }]);
  assertThrows(() => callerEmployeeId(c, 'org1'), ApiError);
});

Deno.test('isHrOrSuper true for hr_admin, super_admin (global row), false for plain employee', () => {
  assertEquals(isHrOrSuper(ctx([{ organizationId: 'org1', roles: ['hr_admin'], employeeId: null }]), 'org1'), true);
  assertEquals(isHrOrSuper(ctx([{ organizationId: null, roles: ['super_admin'], employeeId: null }]), 'org1'), true);
  assertEquals(isHrOrSuper(ctx([{ organizationId: 'org1', roles: ['employee'], employeeId: 'e1' }]), 'org1'), false);
});
