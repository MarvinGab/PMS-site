import { ApiError, Handler, HandlerCtx } from '../_shared/kernel.ts';
import {
  optNumber, optString, optUuid, reqArray, reqEnum, reqInt, reqObject, reqString, reqUuid,
} from '../_shared/validate.ts';

async function replaceLibraryItems(
  ctx: HandlerCtx, orgId: string, libraryId: string, rawItems: unknown,
): Promise<number> {
  // Two-pass: insert KRA rows first (capturing payload-key → new uuid), then KPI
  // rows resolving parentKey against that map. Payload keys are caller-local.
  const items = reqArray(rawItems, 'items', 500).map((r, i) => {
    const o = reqObject(r, `items[${i}]`);
    return {
      itemType: reqEnum(o.itemType, `items[${i}].itemType`, ['kra', 'kpi']),
      key: reqString(o.key, `items[${i}].key`, 120),
      parentKey: optString(o.parentKey, `items[${i}].parentKey`, 120),
      title: reqString(o.title, `items[${i}].title`, 300),
      description: optString(o.description, `items[${i}].description`, 2000),
      perspective: optString(o.perspective, `items[${i}].perspective`, 120),
      weight: optNumber(o.weight, `items[${i}].weight`),
      target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
      target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
      display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
    };
  });
  const keys = items.map((it) => it.key);
  if (new Set(keys).size !== keys.length) throw new ApiError('BAD_REQUEST', 'items contain duplicate keys', 400);

  await ctx.admin.from('goal_library_items').delete()
    .eq('goal_library_id', libraryId).eq('organization_id', orgId);

  const keyToId = new Map<string, string>();
  const kras = items.filter((it) => it.itemType === 'kra');
  const kpis = items.filter((it) => it.itemType === 'kpi');
  for (const it of kras) {
    const { data, error } = await ctx.admin.from('goal_library_items').insert({
      organization_id: orgId, goal_library_id: libraryId, item_type: 'kra',
      title: it.title, description: it.description, perspective: it.perspective,
      weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
      display_order: it.display_order,
    }).select('id').single();
    if (error) { console.error('library items kra', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    keyToId.set(it.key, data.id);
  }
  for (const it of kpis) {
    const parentId = it.parentKey ? keyToId.get(it.parentKey) : null;
    if (it.parentKey && !parentId) {
      throw new ApiError('BAD_REQUEST', `items: kpi "${it.key}" references unknown parentKey "${it.parentKey}"`, 400);
    }
    const { error } = await ctx.admin.from('goal_library_items').insert({
      organization_id: orgId, goal_library_id: libraryId, item_type: 'kpi', parent_item_id: parentId,
      title: it.title, description: it.description, perspective: it.perspective,
      weight: it.weight, target_type_key: it.target_type_key, target_value: it.target_value,
      display_order: it.display_order,
    });
    if (error) { console.error('library items kpi', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
  }
  return items.length;
}

export const libraryHandlers: Record<string, Handler> = {
  'library.save': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const name = reqString(payload.name, 'name', 200);
    const description = optString(payload.description, 'description', 2000);
    const libraryId = optUuid(payload.libraryId, 'libraryId');
    let library: Record<string, unknown>;
    if (libraryId) {
      const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
      library = await ctx.versionedUpdate('goal_libraries', orgId, libraryId, expectedVersion, { name, description });
    } else {
      const { data, error } = await ctx.admin.from('goal_libraries')
        .insert({ organization_id: orgId, name, description }).select().single();
      if (error) {
        if (error.code === '23505') throw new ApiError('LIBRARY_NAME_TAKEN', 'A library with this name already exists', 409);
        console.error('library.save insert', error);
        throw new ApiError('DB_ERROR', 'Database error', 500);
      }
      library = data;
    }
    const count = await replaceLibraryItems(ctx, orgId, library.id as string, payload.items ?? []);
    await ctx.audit({
      organizationId: orgId, action: 'library.save',
      entityType: 'goal_library', entityId: library.id as string, note: `${count} item(s)`,
    });
    return { library, items: count };
  },

  'library.list': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const { data, error } = await ctx.admin.from('goal_libraries')
      .select().eq('organization_id', orgId).order('name');
    if (error) { console.error('library.list', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { libraries: data ?? [] };
  },

  'library.archive': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const libraryId = reqUuid(payload.libraryId, 'libraryId');
    const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
    const library = await ctx.versionedUpdate('goal_libraries', orgId, libraryId, expectedVersion, { status: 'archived' });
    await ctx.audit({
      organizationId: orgId, action: 'library.archive',
      entityType: 'goal_library', entityId: libraryId, after: { status: 'archived' },
    });
    return { library };
  },

  'prefill.save': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const name = reqString(payload.name, 'name', 200);
    const description = optString(payload.description, 'description', 2000);
    const datasetId = optUuid(payload.datasetId, 'datasetId');
    let dataset: Record<string, unknown>;
    if (datasetId) {
      const expectedVersion = reqInt(payload.expectedVersion, 'expectedVersion');
      dataset = await ctx.versionedUpdate('prefill_datasets', orgId, datasetId, expectedVersion, { name, description });
    } else {
      const { data, error } = await ctx.admin.from('prefill_datasets')
        .insert({ organization_id: orgId, name, description }).select().single();
      if (error) {
        if (error.code === '23505') throw new ApiError('PREFILL_NAME_TAKEN', 'A prefill dataset with this name already exists', 409);
        console.error('prefill.save insert', error);
        throw new ApiError('DB_ERROR', 'Database error', 500);
      }
      dataset = data;
    }
    const rows = reqArray(payload.items ?? [], 'items', 2000).map((r, i) => {
      const o = reqObject(r, `items[${i}]`);
      return {
        organization_id: orgId, prefill_dataset_id: dataset.id,
        employee_code: reqString(o.employeeCode, `items[${i}].employeeCode`, 60),
        kra_title: reqString(o.kraTitle, `items[${i}].kraTitle`, 300),
        kpi_title: optString(o.kpiTitle, `items[${i}].kpiTitle`, 300),
        weight: optNumber(o.weight, `items[${i}].weight`),
        perspective: optString(o.perspective, `items[${i}].perspective`, 120),
        target_type_key: optString(o.targetTypeKey, `items[${i}].targetTypeKey`, 60),
        target_value: optString(o.targetValue, `items[${i}].targetValue`, 200),
        display_order: reqInt(o.displayOrder ?? i, `items[${i}].displayOrder`),
      };
    });
    await ctx.admin.from('prefill_dataset_items').delete()
      .eq('prefill_dataset_id', dataset.id).eq('organization_id', orgId);
    if (rows.length) {
      const { error } = await ctx.admin.from('prefill_dataset_items').insert(rows);
      if (error) { console.error('prefill items', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    }
    await ctx.audit({
      organizationId: orgId, action: 'prefill.save',
      entityType: 'prefill_dataset', entityId: dataset.id as string, note: `${rows.length} item(s)`,
    });
    return { dataset, items: rows.length };
  },

  'prefill.list': async (payload, ctx) => {
    const orgId = reqUuid(payload.orgId, 'orgId');
    ctx.requireOrgRole(orgId, ['hr_admin']);
    const { data, error } = await ctx.admin.from('prefill_datasets')
      .select().eq('organization_id', orgId).order('name');
    if (error) { console.error('prefill.list', error); throw new ApiError('DB_ERROR', 'Database error', 500); }
    return { datasets: data ?? [] };
  },
};
