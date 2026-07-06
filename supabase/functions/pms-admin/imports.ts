import { ApiError, Handler } from '../_shared/kernel.ts';
import { reqArray, reqInt, reqUuid } from '../_shared/validate.ts';

export const CANONICAL_COLUMNS = [
  'employeeCode', 'fullName', 'email', 'designation', 'department', 'grade',
  'groupName', 'managerCode', 'l2Code', 'hodCode',
];

export type NormalizedRow = {
  employee_code: string; full_name: string; email: string | null;
  designation: string | null; department: string | null; grade: string | null;
  group_name: string; manager_code: string | null; l2_code: string | null; hod_code: string | null;
};
export type RowError = { row_number: number; column_name: string | null; error: string; row_data: unknown };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cell(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// Pure validation: shape, required fields, per-org uniqueness within the batch,
// and reference resolvability (manager/l2/hod codes must appear as a row's
// employeeCode in the same batch). Roster-only groupName='NONE' is allowed and
// excluded from PMS participation downstream — never surfaced as "Outside PMS".
export function validateRosterRows(rows: unknown): { clean: NormalizedRow[]; errors: RowError[] } {
  const arr = reqArray(rows, 'rows', 5000);
  const clean: NormalizedRow[] = [];
  const errors: RowError[] = [];
  const seenCodes = new Set<string>();
  const seenEmails = new Set<string>();
  const allCodes = new Set<string>();

  arr.forEach((r) => {
    const o = (r && typeof r === 'object' && !Array.isArray(r)) ? r as Record<string, unknown> : {};
    const code = cell(o, 'employeeCode');
    if (code) allCodes.add(code);
  });

  arr.forEach((r, idx) => {
    const rowNum = idx + 1;
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push({ row_number: rowNum, column_name: null, error: 'row is not an object', row_data: r });
      return;
    }
    const o = r as Record<string, unknown>;
    const code = cell(o, 'employeeCode');
    const name = cell(o, 'fullName');
    const email = cell(o, 'email');
    const group = cell(o, 'groupName');
    const rowErrs: RowError[] = [];
    if (!code) rowErrs.push({ row_number: rowNum, column_name: 'employeeCode', error: 'required', row_data: o });
    if (!name) rowErrs.push({ row_number: rowNum, column_name: 'fullName', error: 'required', row_data: o });
    if (!group) rowErrs.push({ row_number: rowNum, column_name: 'groupName', error: 'required (use "NONE" for roster-only)', row_data: o });
    if (email && !EMAIL_RE.test(email)) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'not a valid email', row_data: o });
    if (group !== 'NONE' && !email) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'required for PMS participants (groupName != NONE)', row_data: o });
    if (code && seenCodes.has(code)) rowErrs.push({ row_number: rowNum, column_name: 'employeeCode', error: 'duplicate employeeCode in file', row_data: o });
    if (email && seenEmails.has(email.toLowerCase())) rowErrs.push({ row_number: rowNum, column_name: 'email', error: 'duplicate email in file', row_data: o });
    for (const refCol of ['managerCode', 'l2Code', 'hodCode']) {
      const ref = cell(o, refCol);
      if (ref) {
        if (ref === code) rowErrs.push({ row_number: rowNum, column_name: refCol, error: 'cannot reference self', row_data: o });
        else if (!allCodes.has(ref)) rowErrs.push({ row_number: rowNum, column_name: refCol, error: `"${ref}" is not an employeeCode in this file`, row_data: o });
      }
    }
    if (rowErrs.length) { errors.push(...rowErrs); return; }
    if (code) seenCodes.add(code);
    if (email) seenEmails.add(email.toLowerCase());
    clean.push({
      employee_code: code!, full_name: name!, email,
      designation: cell(o, 'designation'), department: cell(o, 'department'), grade: cell(o, 'grade'),
      group_name: group!, manager_code: cell(o, 'managerCode'),
      l2_code: cell(o, 'l2Code'), hod_code: cell(o, 'hodCode'),
    });
  });
  return { clean, errors };
}

export const importHandlers: Record<string, Handler> = {
  'import.validate-roster': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const cycleId = payload.cycleId ? reqUuid(payload.cycleId, 'cycleId') : null;
    const rows = reqArray(payload.rows, 'rows', 5000);
    const { clean, errors } = validateRosterRows(rows);
    const status = errors.length ? 'failed' : 'preview_ready';
    const { data: run, error } = await ctx.admin.from('import_runs').insert({
      organization_id: orgId, cycle_id: cycleId, kind: 'roster', status,
      total_rows: rows.length, valid_rows: clean.length, error_rows: errors.length,
      created_by: ctx.userId,
    }).select().single();
    if (error) { console.error('import run insert', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (errors.length) {
      const errRows = errors.slice(0, 2000).map((e) => ({ import_run_id: run.id, ...e }));
      const { error: eErr } = await ctx.admin.from('import_run_errors').insert(errRows);
      if (eErr) { console.error('import errors insert', eErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, cycleId, action: 'import.validate-roster',
      entityType: 'import_run', entityId: run.id, note: `${clean.length} valid / ${errors.length} error`,
    });
    return { importRun: run, errors: errors.slice(0, 2000), validCount: clean.length, errorCount: errors.length };
  },

  'import.get-preview': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const { data: run, error } = await ctx.admin.from('import_runs')
      .select().eq('id', importRunId).eq('organization_id', orgId).maybeSingle();
    if (error) { console.error('import preview read', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!run) throw new ApiError('NOT_FOUND', 'Import run not found', 404);
    const { data: errs, error: errsErr } = await ctx.admin.from('import_run_errors')
      .select().eq('import_run_id', importRunId).order('row_number');
    if (errsErr) { console.error('import preview errors read', errsErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { importRun: run, errors: errs ?? [] };
  },

  'import.discard': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const run = await ctx.versionedUpdate('import_runs', orgId, importRunId, expectedVersion, { status: 'discarded' });
    await ctx.audit({
      organizationId: orgId, action: 'import.discard',
      entityType: 'import_run', entityId: importRunId, after: { status: 'discarded' },
    });
    return { importRun: run };
  },

  'import.commit-roster': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const importRunId = reqUuid(payload.importRunId, 'importRunId');
    const rows = reqArray(payload.rows, 'rows', 5000);
    // Re-validate server-side; the client's earlier preview is advisory only.
    const { clean, errors } = validateRosterRows(rows);
    if (errors.length) {
      throw new ApiError('IMPORT_INVALID', `Roster still has ${errors.length} error(s); re-validate before committing`, 400);
    }
    const { data: run, error: runErr } = await ctx.admin.from('import_runs')
      .select('status').eq('id', importRunId).eq('organization_id', orgId).maybeSingle();
    if (runErr) { console.error('commit run read', runErr); throw new ApiError('DB_ERROR', 'Database error', 500); }
    if (!run) throw new ApiError('NOT_FOUND', 'Import run not found', 404);
    if (run.status === 'committed') throw new ApiError('IMPORT_ALREADY_COMMITTED', 'This import was already committed', 409);
    const { data: result, error } = await ctx.admin.rpc('commit_roster_import_tx', {
      p_org: orgId, p_import_run: importRunId, p_actor: ctx.userId, p_rows: clean,
    });
    if (error) {
      if (error.code === '23503') throw new ApiError('BAD_REQUEST', 'A reporting reference did not resolve', 400);
      console.error('commit_roster_import_tx', error);
      throw new ApiError('DB_ERROR', 'Database error', 500);
    }
    return { result };
  },
};
