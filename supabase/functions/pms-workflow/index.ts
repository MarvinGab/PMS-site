import { serveActions } from '../_shared/kernel.ts';
import { goalHandlers } from './goals.ts';
import { goalFlowHandlers } from './goalflow.ts';

serveActions({
  'workflow.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...goalHandlers,
  ...goalFlowHandlers,
});
