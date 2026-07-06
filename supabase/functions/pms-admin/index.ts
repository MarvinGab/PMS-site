import { serveActions } from '../_shared/kernel.ts';
import { organizationHandlers } from './organizations.ts';
import { cycleHandlers } from './cycles.ts';
import { libraryHandlers } from './libraries.ts';
import { importHandlers } from './imports.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...organizationHandlers,
  ...cycleHandlers,
  ...libraryHandlers,
  ...importHandlers,
});
