import { serveActions } from '../_shared/kernel.ts';
import { organizationHandlers } from './organizations.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...organizationHandlers,
});
