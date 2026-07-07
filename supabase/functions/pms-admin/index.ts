import { serveActions } from '../_shared/kernel.ts';
import { organizationHandlers } from './organizations.ts';
import { cycleHandlers } from './cycles.ts';
import { libraryHandlers } from './libraries.ts';
import { importHandlers } from './imports.ts';
import { participantHandlers } from './participants.ts';
import { inviteHandlers } from './invites.ts';
import { activationHandlers } from './activation.ts';
import { publishingHandlers } from './publishing.ts';
import { concernHandlers } from './concerns.ts';

serveActions({
  'admin.whoami': (_payload, ctx) =>
    Promise.resolve({ userId: ctx.userId, memberships: ctx.memberships }),
  ...organizationHandlers,
  ...cycleHandlers,
  ...libraryHandlers,
  ...importHandlers,
  ...participantHandlers,
  ...inviteHandlers,
  ...activationHandlers,
  ...publishingHandlers,
  ...concernHandlers,
});
