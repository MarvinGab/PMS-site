import { serveActions } from '../_shared/kernel.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
});
