import { serveActions } from '../_shared/kernel.ts';
import { bootstrapHandlers } from './bootstrap.ts';
import { goalHandlers } from './goals.ts';
import { goalFlowHandlers } from './goalflow.ts';
import { evalHandlers } from './evals.ts';
import { calibrationHandlers } from './calibration.ts';
import { ackHandlers } from './acknowledge.ts';

serveActions({
  'workflow.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...bootstrapHandlers,
  ...goalHandlers,
  ...goalFlowHandlers,
  ...evalHandlers,
  ...calibrationHandlers,
  ...ackHandlers,
});
