// xlsx → parsing uploaded files (fast, lightweight)
// exceljs → generating formatted downloads (rich styling)
let _xlsx = null;
let _exceljs = null;
async function getXLSX()    { if (!_xlsx)    _xlsx    = await import('xlsx');    return _xlsx; }
async function getExcelJS() { if (!_exceljs) _exceljs = await import('exceljs'); return _exceljs; }

/* ── PALETTE ─────────────────────────────────────────────────────────────── */
const C = {
  BLUE:       'FF1D4ED8',  // header fill
  BLUE_DARK:  'FF1E3A8A',  // header border / tab
  WHITE:      'FFFFFFFF',
  RED_TEXT:   'FFDC2626',  // example row font
  RED_FILL:   'FFFEF2F2',  // example row background
  RED_BORDER: 'FFFECACA',  // example row border
  RED_BANNER: 'FFFEE2E2',  // "EXAMPLE" notice row
  BLUE_FILL:  'FFEFF6FF',  // "YOUR DATA" notice row
  BLUE_BANNER:'FFBFDBFE',  // "YOUR DATA" notice border
  GRAY_TEXT:  'FF374151',  // normal data text
  NOTE_TEXT:  'FF64748B',  // notes / instructions
  BORD:       'FFE2E8F0',  // data cell border (slate-200)
  ALT_ROW:    'FFF8FAFC',  // alternating row fill
  LABEL_FILL: 'FFF1F5F9',  // Reference sheet section labels
};

/* ── small utilities ─────────────────────────────────────────────────────── */
function colLetter(n) {
  let s = '';
  while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function applyBorder(cell, style, argb) {
  const side = { style, color: { argb } };
  cell.border = { top: side, left: side, bottom: side, right: side };
}

function applyFill(cell, argb) {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function font(cell, opts) {
  cell.font = { name: 'Calibri', size: 10.5, ...opts };
}

function align(cell, horizontal = 'left', indent = 1) {
  cell.alignment = { vertical: 'middle', horizontal, indent, wrapText: false };
}

function bannerRow(ws, numCols, text, fillArgb, textArgb, rowHeight = 18) {
  const row = ws.addRow([text]);
  ws.mergeCells(`A${row.number}:${colLetter(numCols)}${row.number}`);
  const cell = ws.getCell(`A${row.number}`);
  applyFill(cell, fillArgb);
  cell.font = { name: 'Calibri', size: 10, bold: true, color: { argb: textArgb }, italic: true };
  cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 2 };
  row.height = rowHeight;
  return row;
}

function styleHeaderRow(headerRow, numCols) {
  headerRow.height = 28;
  for (let c = 1; c <= numCols; c++) {
    const cell = headerRow.getCell(c);
    applyFill(cell, C.BLUE);
    applyBorder(cell, 'medium', C.BLUE_DARK);
    cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.WHITE } };
    align(cell, 'left', 1);
  }
}

function styleExampleRow(row, numCols) {
  row.height = 20;
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    applyFill(cell, C.RED_FILL);
    applyBorder(cell, 'thin', C.RED_BORDER);
    font(cell, { color: { argb: C.RED_TEXT }, italic: true });
    align(cell);
  }
}

function styleDataRow(row, numCols, rowIndex) {
  row.height = 20;
  const fillColor = rowIndex % 2 === 0 ? C.WHITE : C.ALT_ROW;
  for (let c = 1; c <= numCols; c++) {
    const cell = row.getCell(c);
    applyFill(cell, fillColor);
    applyBorder(cell, 'thin', C.BORD);
    font(cell, { color: { argb: C.GRAY_TEXT } });
    align(cell);
  }
}

function addNoteRows(ws, noteRows) {
  ws.addRow([]);
  for (const note of noteRows) {
    if (!note || note.length === 0) { ws.addRow([]); continue; }
    const row = ws.addRow([note[0]]);
    row.height = 16;
    const cell = row.getCell(1);
    cell.font = { name: 'Calibri', size: 10, color: { argb: C.NOTE_TEXT }, italic: true };
    cell.alignment = { vertical: 'middle', horizontal: 'left' };
  }
}

function makeWorkbook(ExcelJS) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Zaro HR';
  wb.created = new Date();
  return wb;
}

async function writeAndDownload(wb, filename) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ── GOAL LIBRARY TEMPLATE META ──────────────────────────────────────────── */
export function goalLibraryTemplateMeta(config) {
  const { goalLibraryScope, goalSegmentAttr, goalSegmentValues, goalKpiMode, perspectives = [] } = config;
  const isByAttr   = goalLibraryScope === 'by-attribute';
  const hasKpis    = goalKpiMode === 'kra-kpi';
  const attrLabel  = goalSegmentAttr || 'Department';
  const perspNames = perspectives.map(p => p.name).filter(Boolean);
  const attrValues = isByAttr ? (goalSegmentValues || []).map(v => v.name).filter(Boolean) : [];

  const headers = [
    ...(isByAttr ? [attrLabel] : []),
    'Perspective', 'KRA Name', 'KRA Weight %',
    ...(hasKpis ? ['KPI Name', 'KPI Weight %'] : []),
  ];

  const colWidths = [
    ...(isByAttr ? [20] : []),
    24, 36, 14,
    ...(hasKpis ? [36, 14] : []),
  ];

  const firstPersp  = perspNames[0] || 'Financial';
  const secondPersp = perspNames[1] || 'Customer';

  function kraRows(attrVal) {
    const prefix = isByAttr ? [attrVal] : [];
    return hasKpis ? [
      [...prefix, firstPersp,  'Revenue Growth',       '40', 'Monthly Revenue vs Target', '60'],
      [...prefix, firstPersp,  'Revenue Growth',       '40', 'New Client Acquisition',    '40'],
      [...prefix, secondPersp, 'Customer Satisfaction','30', 'NPS Score',                 '50'],
      [...prefix, secondPersp, 'Customer Satisfaction','30', 'Repeat Purchase Rate',      '50'],
    ] : [
      [...prefix, firstPersp,  'Revenue Growth',        '40'],
      [...prefix, firstPersp,  'Cost Optimisation',     '30'],
      [...prefix, secondPersp, 'Customer Satisfaction', '30'],
    ];
  }

  const exampleRows = [];
  if (isByAttr && attrValues.length > 0) {
    for (const val of attrValues) exampleRows.push(...kraRows(val));
  } else if (!isByAttr) {
    exampleRows.push(...kraRows(null));
  }

  const noteRows = [
    ['NOTES'],
    ...(isByAttr ? [`• Group all KRAs for the same ${attrLabel} together. Each ${attrLabel} value must match exactly what you configured.`] : ['']).map(t => [t]),
    [hasKpis
      ? '• For KRAs with multiple KPIs: repeat the KRA Name and KRA Weight % on each KPI row.'
      : '• KRA Weight % for all KRAs must add up to 100.'],
    [`• Valid Perspectives: ${perspNames.join('  |  ') || 'see Reference sheet'}`],
    ['• Delete the red example rows before uploading.'],
  ];

  return { headers, colWidths, exampleRows, noteRows, perspNames, attrLabel, isByAttr, hasKpis, attrValues };
}

/* ── DOWNLOAD GOAL LIBRARY TEMPLATE ─────────────────────────────────────── */
export async function downloadGoalLibraryTemplate(config) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = goalLibraryTemplateMeta(config);
  const n = meta.headers.length;
  const wb = makeWorkbook(ExcelJS);

  /* ── Sheet 1: Goal Library ── */
  const ws = wb.addWorksheet('Goal Library', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });
  ws.columns = meta.colWidths.map(w => ({ width: w }));

  // Header
  const headerRow = ws.addRow(meta.headers);
  styleHeaderRow(headerRow, n);

  // Example notice
  bannerRow(ws, n, '▸  EXAMPLE ROWS — Replace with your data, then delete these rows before upload', C.RED_BANNER, C.RED_TEXT);

  // Example data (red)
  for (const rowData of meta.exampleRows) {
    styleExampleRow(ws.addRow(rowData), n);
  }

  // Your data notice
  bannerRow(ws, n, '▸  YOUR DATA — Add your KRAs below', C.BLUE_FILL, C.BLUE);

  // 20 empty entry rows
  for (let i = 0; i < 20; i++) {
    styleDataRow(ws.addRow(meta.headers.map(() => '')), n, i);
  }

  // Notes
  addNoteRows(ws, meta.noteRows);

  /* ── Sheet 2: Reference ── */
  const ref = wb.addWorksheet('Reference', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ref.columns = [{ width: 28 }, { width: 28 }];

  function refSection(title, values) {
    const tRow = ref.addRow([title]);
    tRow.height = 22;
    const tc = tRow.getCell(1);
    applyFill(tc, C.BLUE);
    applyBorder(tc, 'medium', C.BLUE_DARK);
    font(tc, { bold: true, size: 11, color: { argb: C.WHITE } });
    align(tc);
    for (const v of values) {
      const vRow = ref.addRow([v]);
      vRow.height = 18;
      const vc = vRow.getCell(1);
      applyFill(vc, C.ALT_ROW);
      applyBorder(vc, 'thin', C.BORD);
      font(vc, { color: { argb: C.GRAY_TEXT } });
      align(vc);
    }
    ref.addRow([]);
  }

  refSection('Valid Perspectives', meta.perspNames);
  if (meta.isByAttr && meta.attrValues.length) {
    refSection(`Valid ${meta.attrLabel} values`, meta.attrValues);
  }

  await writeAndDownload(wb, 'goal_library_template.xlsx');
}

/* ── ATTRIBUTE VALUE TEMPLATE META ──────────────────────────────────────── */
function attributeValuesTemplateMeta(attrLabel, values = []) {
  const cleanLabel = String(attrLabel || 'Attribute').trim() || 'Attribute';
  const cleanValues = Array.from(new Set(
    (values || [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
      .map(value => value.toLowerCase())
  )).map(lowerValue => {
    const original = (values || []).find(value => String(value || '').trim().toLowerCase() === lowerValue);
    return String(original || '').trim();
  });

  return {
    headers: [cleanLabel],
    colWidths: [28],
    exampleRows: cleanValues.length
      ? []
      : [['Mumbai'], ['Bangalore'], ['Chennai']],
    existingRows: cleanValues,
    noteRows: [
      ['NOTES'],
      [`• Put one ${cleanLabel} value in each row.`],
      [`• If you upload a larger master sheet instead, the parser will try to extract unique values from the "${cleanLabel}" column.`],
      ['• Duplicate and blank values are ignored automatically.'],
      ['• Delete red example rows before uploading.'],
    ],
  };
}

/* ── DOWNLOAD ATTRIBUTE VALUES TEMPLATE ─────────────────────────────────── */
export async function downloadAttributeValuesTemplate(attrLabel, values = []) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = attributeValuesTemplateMeta(attrLabel, values);
  const wb = makeWorkbook(ExcelJS);
  const ws = wb.addWorksheet('Attribute Values', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });

  ws.columns = meta.colWidths.map(width => ({ width }));
  styleHeaderRow(ws.addRow(meta.headers), meta.headers.length);

  if (meta.exampleRows.length) {
    bannerRow(ws, 1, '▸  EXAMPLE VALUES — Replace these with your actual values, then delete them before upload', C.RED_BANNER, C.RED_TEXT);
    for (const rowData of meta.exampleRows) styleExampleRow(ws.addRow(rowData), 1);
  }

  bannerRow(ws, 1, '▸  YOUR DATA — Put one unique value per row below', C.BLUE_FILL, C.BLUE);
  if (meta.existingRows.length) {
    meta.existingRows.forEach((value, index) => {
      styleDataRow(ws.addRow([value]), 1, index);
    });
  } else {
    for (let i = 0; i < 30; i++) styleDataRow(ws.addRow(['']), 1, i);
  }

  addNoteRows(ws, meta.noteRows);
  await writeAndDownload(wb, `${String(attrLabel || 'attribute').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'attribute'}_values_template.xlsx`);
}

/* ── BULK GOAL LIBRARY TEMPLATE ──────────────────────────────────────────── */
// Generates a ready-to-use Excel template for uploading multiple goal libraries at once.
// One sheet, per-group sections. KPI columns greyed for KRA-only groups.
// Parser matches Group Name + Library Name back to groups and strips KPIs if group is kra-only.
export async function downloadGoalLibraryBulkTemplate(configOrPerspectives = []) {
  const { default: ExcelJS } = await getExcelJS();
  const wb = makeWorkbook(ExcelJS);

  const config = Array.isArray(configOrPerspectives)
    ? { perspectives: configOrPerspectives }
    : (configOrPerspectives || {});

  const perspectives = config.perspectives || [];
  const goalGroups   = config.goalGroups  || [];
  const isFlat       = config.frameworkId === 'kra-kpi' || config.frameworkId === 'kra';
  const perspNames   = isFlat ? [] : perspectives.filter(p => p.name).map(p => p.name);
  const p1 = perspNames[0] || 'Financial';
  const p2 = perspNames[1] || 'Customer';
  const p3 = perspNames[2] || 'Internal Process';

  // Only groups that have a goal library configured
  const activeGroups = goalGroups.filter(g => g.hasLibrary);
  const hideKpiWeight = activeGroups.length > 0
    && activeGroups.every(g => g.kpiRatingMode === 'free-text');

  const baseHeaders = isFlat
    ? ['Group Name', 'Library Name', 'KRA Name', 'KRA Description', 'KRA Weight %', 'KPI Name', 'KPI Weight %']
    : ['Group Name', 'Library Name', 'Perspective', 'KRA Name', 'KRA Description', 'KRA Weight %', 'KPI Name', 'KPI Weight %'];
  const baseColWidths = isFlat ? [24, 28, 30, 36, 14, 30, 14] : [24, 28, 22, 30, 36, 14, 30, 14];
  const headers   = hideKpiWeight ? baseHeaders.slice(0, -1) : baseHeaders;
  const colWidths = hideKpiWeight ? baseColWidths.slice(0, -1) : baseColWidths;
  const n          = headers.length;
  const KPI_COLS   = hideKpiWeight
    ? (isFlat ? [6] : [7])
    : (isFlat ? [6, 7] : [7, 8]);
  const GREY_FILL  = 'FFE5E7EB';
  const GREY_TEXT  = 'FF9CA3AF';

  // ── Sheet 1: Goal Libraries ─────────────────────────────────────────────
  const ws = wb.addWorksheet('Goal Libraries', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });
  ws.columns = colWidths.map(w => ({ width: w }));

  const hRow = ws.addRow(headers);
  styleHeaderRow(hRow, n);

  // Helper: grey out KPI cells on a row (for KRA-only sections)
  function greyKpiCells(row) {
    for (const c of KPI_COLS) {
      const cell = row.getCell(c);
      applyFill(cell, GREY_FILL);
      cell.value = '—';
      font(cell, { color: { argb: GREY_TEXT }, italic: true });
      applyBorder(cell, 'thin', GREY_FILL);
    }
  }

  // Helper: group section banner (coloured header strip per group)
  const GROUP_COLORS = [
    { fill: 'FFE0E7FF', text: 'FF1E40AF', border: 'FFC7D2FE' }, // indigo
    { fill: 'FFF0FDF4', text: 'FF166534', border: 'FFBBF7D0' }, // green
    { fill: 'FFFDF4FF', text: 'FF701A75', border: 'FFFAE8FF' }, // purple
    { fill: 'FFFEFCE8', text: 'FF713F12', border: 'FFFEF08A' }, // yellow
    { fill: 'FFFFF1F2', text: 'FF9F1239', border: 'FFFECDD3' }, // rose
  ];

  function groupBannerRow(groupIndex, group, libType) {
    const attr    = group.segmentAttr || 'All Employees';
    const typeLabel = libType === 'kra-kpi' ? '📊 KRAs + KPIs — fill all columns' : '📌 KRAs only — leave KPI columns blank';
    const text    = `  ▶  GROUP: ${group.name}  |  Attribute: ${attr}  |  ${typeLabel}`;
    const palette = GROUP_COLORS[groupIndex % GROUP_COLORS.length];

    const row = ws.addRow([text]);
    ws.mergeCells(`A${row.number}:${colLetter(n)}${row.number}`);
    const cell = ws.getCell(`A${row.number}`);
    applyFill(cell, palette.fill);
    applyBorder(cell, 'medium', palette.border);
    cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: palette.text } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    row.height = 22;
    return row;
  }

  // Styles the Group Name cell (col A) in a data/example row to signal it is pre-filled
  function styleGroupNameCell(row, groupIndex) {
    const cell = row.getCell(1);
    const palette = GROUP_COLORS[groupIndex % GROUP_COLORS.length];
    applyFill(cell, palette.fill);
    font(cell, { color: { argb: palette.text }, italic: true, size: 9.5 });
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  }

  const trimRow = (row) => hideKpiWeight ? row.slice(0, -1) : row;
  const kraOnlyLibRow = (group, lib, persp, kraName, kraDesc, weight) =>
    trimRow(isFlat
      ? [group, lib, kraName, kraDesc, weight, '', '']
      : [group, lib, persp, kraName, kraDesc, weight, '', '']);
  const kraKpiLibRow = (group, lib, persp, kraName, kraDesc, kraWeight, kpiName, kpiWeight) =>
    trimRow(isFlat
      ? [group, lib, kraName, kraDesc, kraWeight, kpiName, kpiWeight]
      : [group, lib, persp, kraName, kraDesc, kraWeight, kpiName, kpiWeight]);

  if (activeGroups.length === 0) {
    // Fallback: no groups configured with libraries — generic template
    bannerRow(ws, n, '  ↓  Example rows — delete before uploading your data', C.RED_BANNER, C.RED_TEXT);
    const exRows = [
      kraKpiLibRow('', 'Library A', p1, 'Revenue Growth',   'Grow quarterly revenue',        '40', 'Monthly ARR',    '60'),
      kraKpiLibRow('', 'Library A', p1, 'Revenue Growth',   'Grow quarterly revenue',        '40', 'New Client Wins', '40'),
      kraKpiLibRow('', 'Library A', p2, 'Customer NPS',     'Net promoter score improvement','60', 'Survey Rate',    '100'),
    ];
    for (const row of exRows) { styleExampleRow(ws.addRow(row), n); }
    bannerRow(ws, n, '  ↑  Delete examples above  ·  Your libraries start here  ↓', C.BLUE_FILL, C.BLUE_DARK);
    for (let i = 0; i < 12; i++) { styleDataRow(ws.addRow(Array(n).fill('')), n, i); }
  } else {
    // One section per group
    activeGroups.forEach((group, gi) => {
      const libType = group.libraryType || 'kra-only';
      const isKraOnly = libType === 'kra-only';

      // Get the library names this group expects (segment values or group name)
      const segValues = (group.segmentValues || []).map(v => String(v || '').trim()).filter(Boolean);
      const libNames  = segValues.length > 0 ? segValues : [group.name || 'All Employees'];

      // Section banner
      if (gi > 0) ws.addRow([]); // spacer between groups
      groupBannerRow(gi, group, libType);

      // Example rows (first lib name only, 2-3 KRAs) — Group Name pre-filled
      const exName = libNames[0];
      bannerRow(ws, n, `  ↓  Example rows for "${exName}" — delete before uploading`, C.RED_BANNER, C.RED_TEXT);

      const exRows = isKraOnly
        ? [
            kraOnlyLibRow(group.name, exName, p1, 'Revenue Growth',    'Grow quarterly revenue',        '40'),
            kraOnlyLibRow(group.name, exName, p2, 'Customer Retention','Retain existing client base',   '35'),
            kraOnlyLibRow(group.name, exName, p3, 'Process Quality',   'Improve delivery standards',    '25'),
          ]
        : [
            kraKpiLibRow(group.name, exName, p1, 'Revenue Growth',    'Grow quarterly revenue',        '40', 'Monthly ARR',    '60'),
            kraKpiLibRow(group.name, exName, p1, 'Revenue Growth',    'Grow quarterly revenue',        '40', 'New Client Wins', '40'),
            kraKpiLibRow(group.name, exName, p2, 'Customer NPS',      'Net promoter score improvement','35', 'Survey Rate',    '100'),
            kraKpiLibRow(group.name, exName, p3, 'Process Quality',   'Improve delivery standards',    '25', 'On-time Rate',   '100'),
          ];

      for (const row of exRows) {
        const r = ws.addRow(row);
        styleExampleRow(r, n);
        styleGroupNameCell(r, gi);
        if (isKraOnly) greyKpiCells(r);
      }

      bannerRow(ws, n, `  ↑  Delete examples above  ·  Fill your ${libNames.length} librar${libNames.length === 1 ? 'y' : 'ies'} below  ↓`, C.BLUE_FILL, C.BLUE_DARK);

      // Hint row showing expected library names
      if (libNames.length > 1) {
        bannerRow(ws, n, `     Expected Library Names for this group:  ${libNames.join('  ·  ')}`, 'FFF8FAFC', 'FF64748B', 16);
      }

      // Blank data rows — 4 per library name, Group Name pre-filled
      const blankCount = Math.min(libNames.length * 4, 20);
      for (let i = 0; i < blankCount; i++) {
        const blankRow = Array(n).fill('');
        blankRow[0] = group.name;
        const r = ws.addRow(blankRow);
        styleDataRow(r, n, i);
        styleGroupNameCell(r, gi);
        if (isKraOnly) greyKpiCells(r);
      }
    });
  }

  // Notes
  addNoteRows(ws, [
    ['RULES & NOTES'],
    ['• Each section above corresponds to one employee group from your Step 3 configuration.'],
    ['• Group Name: pre-filled automatically — do not edit. It tells the system which group each library belongs to, so two groups can share the same designation name without collision.'],
    ['• Library Name: use the exact segment value (e.g. designation name) as the Library Name. Each unique Group Name + Library Name pair becomes one library card.'],
    ...(isFlat ? [] : [['• Perspective: grouping and display only — not scored separately. Must match your BSC perspective names.']]),
    ['• KRA Weight %: optional. If provided, the value is pre-filled as a suggestion in the employee\'s goal plan. The library is a reference catalog — employees may pick any subset of KRAs, so weights here do not need to sum to 100.'],
    ['• KPI columns (greyed): only applicable for KRA+KPI groups. Leave blank or do not fill greyed cells.'],
    ...(hideKpiWeight ? [] : [['• KPI Weight %: optional. If provided, pre-filled as a suggested starting weight in the employee\'s plan.']]),
    ['• Delete all red example rows before uploading.'],
    ['• Do not rename, reorder, or delete column headers.'],
    ...(isFlat
      ? []
      : [perspNames.length > 0
          ? [`• Valid Perspectives: ${perspNames.join('  |  ')}`]
          : ['• Perspective names must match what you set in Step 2.']]),
  ]);

  // ── Sheet 2: Reference ──────────────────────────────────────────────────
  const ref = wb.addWorksheet('Reference', {
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ref.columns = [{ width: 28 }, { width: 55 }];

  const addRefSection = (title, rows) => {
    const tRow = ref.addRow([title]);
    tRow.height = 22;
    applyFill(tRow.getCell(1), C.LABEL_FILL);
    tRow.getCell(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.BLUE_DARK } };
    for (const [a, b] of rows) {
      const r = ref.addRow([a, b]);
      r.height = 18;
      font(r.getCell(1), { bold: true, color: { argb: C.GRAY_TEXT } });
      font(r.getCell(2), { color: { argb: C.NOTE_TEXT } });
    }
    ref.addRow([]);
  };

  addRefSection('Column Guide', [
    ['Group Name',      'Pre-filled automatically — identifies which employee group this library belongs to. Do not edit. Two groups can use the same Library Name; Group Name keeps them separate.'],
    ['Library Name',    'Unique name per library within a group — usually the designation/segment value. All rows for one library share this name.'],
    ...(isFlat ? [] : [['Perspective', 'BSC perspective this KRA belongs to. Display/grouping only — not scored separately.']]),
    ['KRA Name',        'Key Result Area — the goal topic or theme.'],
    ['KRA Description', 'Optional brief description of the KRA.'],
    ['KRA Weight %',    'Optional suggested weight. Pre-filled in the employee\'s plan when they add this KRA. The library is a reference catalog — employees pick a subset, so weights here do not need to sum to 100.'],
    ['KPI Name',        'Key Performance Indicator under this KRA. Only for KRA+KPI groups — leave blank otherwise.'],
    ...(hideKpiWeight ? [] : [['KPI Weight %', 'Optional suggested weight for this KPI. Pre-filled in the employee\'s plan as a starting value.']]),
  ]);

  if (activeGroups.length > 0) {
    addRefSection('Configured Groups', activeGroups.map((g, i) => {
      const libType  = g.libraryType || 'kra-only';
      const segVals  = (g.segmentValues || []).filter(Boolean);
      const libNames = segVals.length > 0 ? segVals.join(', ') : g.name;
      return [g.name, `${libType === 'kra-kpi' ? 'KRA + KPI' : 'KRA only'}  |  Library cards: ${libNames}`];
    }));
  }

  if (!isFlat && perspNames.length > 0) {
    addRefSection('Configured Perspectives', perspNames.map(name => [name, 'Use this exact name in the Perspective column.']));
  }

  addRefSection('Common Mistakes', [
    ['Non-numeric weight',    'If you fill in a weight, it must be a plain number (e.g. 40, not "40%"). Blank is fine — weights are optional.'],
    ['Filling greyed cells',  'Grey KPI cells belong to KRA-only groups — any values there will be ignored on upload.'],
    ...(isFlat ? [] : [['Perspective mismatch',  'Perspective names must match your BSC configuration exactly (case-sensitive).']]),
    ['Library name mismatch', 'All rows for a library must use the exact same Library Name.'],
    ['Editing Group Name',    'The Group Name column is pre-filled — changing it will break the group-to-library mapping on upload.'],
  ]);

  await writeAndDownload(wb, 'zaro_goal_libraries_template.xlsx');
}

export async function downloadPrefillBulkTemplate(configOrPerspectives = []) {
  const { default: ExcelJS } = await getExcelJS();
  const wb = makeWorkbook(ExcelJS);

  const config = Array.isArray(configOrPerspectives)
    ? { perspectives: configOrPerspectives }
    : (configOrPerspectives || {});

  const perspectives = config.perspectives || [];
  const goalGroups = config.goalGroups || [];
  const isFlat = config.frameworkId === 'kra-kpi' || config.frameworkId === 'kra';
  const perspNames = isFlat ? [] : perspectives.filter(p => p.name).map(p => p.name);
  const p1 = perspNames[0] || 'Financial';
  const p2 = perspNames[1] || 'Customer';
  const p3 = perspNames[2] || 'Internal Process';

  const activeGroups = goalGroups.filter(g => g.prefillType);
  const hideKpiWeight = activeGroups.length > 0
    && activeGroups.every(g => g.kpiRatingMode === 'free-text');

  const baseHeaders = isFlat
    ? ['Group Name', 'Card Name', 'KRA Name', 'KRA Description', 'KRA Weight %', 'KPI Name', 'KPI Weight %']
    : ['Group Name', 'Card Name', 'Perspective', 'KRA Name', 'KRA Description', 'KRA Weight %', 'KPI Name', 'KPI Weight %'];
  const baseColWidths = isFlat ? [24, 28, 30, 36, 14, 30, 14] : [24, 28, 22, 30, 36, 14, 30, 14];
  const headers = hideKpiWeight ? baseHeaders.slice(0, -1) : baseHeaders;
  const colWidths = hideKpiWeight ? baseColWidths.slice(0, -1) : baseColWidths;
  const n = headers.length;
  const KPI_COLS = hideKpiWeight
    ? (isFlat ? [6] : [7])
    : (isFlat ? [6, 7] : [7, 8]);
  const GREY_FILL = 'FFE5E7EB';
  const GREY_TEXT = 'FF9CA3AF';

  const ws = wb.addWorksheet('Pre-fill Data', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });
  ws.columns = colWidths.map(w => ({ width: w }));

  const hRow = ws.addRow(headers);
  styleHeaderRow(hRow, n);

  function greyKpiCells(row) {
    for (const c of KPI_COLS) {
      const cell = row.getCell(c);
      applyFill(cell, GREY_FILL);
      cell.value = '—';
      font(cell, { color: { argb: GREY_TEXT }, italic: true });
      applyBorder(cell, 'thin', GREY_FILL);
    }
  }

  const GROUP_COLORS = [
    { fill: 'FFE0E7FF', text: 'FF1E40AF', border: 'FFC7D2FE' },
    { fill: 'FFF0FDF4', text: 'FF166534', border: 'FFBBF7D0' },
    { fill: 'FFFDF4FF', text: 'FF701A75', border: 'FFFAE8FF' },
    { fill: 'FFFEFCE8', text: 'FF713F12', border: 'FFFEF08A' },
    { fill: 'FFFFF1F2', text: 'FF9F1239', border: 'FFFECDD3' },
  ];

  function groupBannerRow(groupIndex, group, prefillType) {
    const attr = group.segmentAttr || 'All Employees';
    const typeLabel = prefillType === 'kra-kpi' ? '📊 KRAs + KPIs — fill all columns' : '📌 KRAs only — leave KPI columns blank';
    const text = `  ▶  GROUP: ${group.name}  |  Attribute: ${attr}  |  ${typeLabel}`;
    const palette = GROUP_COLORS[groupIndex % GROUP_COLORS.length];

    const row = ws.addRow([text]);
    ws.mergeCells(`A${row.number}:${colLetter(n)}${row.number}`);
    const cell = ws.getCell(`A${row.number}`);
    applyFill(cell, palette.fill);
    applyBorder(cell, 'medium', palette.border);
    cell.font = { name: 'Calibri', size: 10.5, bold: true, color: { argb: palette.text } };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    row.height = 22;
    return row;
  }

  function styleGroupNameCell(row, groupIndex) {
    const cell = row.getCell(1);
    const palette = GROUP_COLORS[groupIndex % GROUP_COLORS.length];
    applyFill(cell, palette.fill);
    font(cell, { color: { argb: palette.text }, italic: true, size: 9.5 });
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  }

  const trimRow = (row) => hideKpiWeight ? row.slice(0, -1) : row;
  const kraOnlyRowWithPersp = (group, card, persp, kraName, kraDesc, weight) =>
    trimRow(isFlat
      ? [group, card, kraName, kraDesc, weight, '', '']
      : [group, card, persp, kraName, kraDesc, weight, '', '']);
  const kraKpiRow = (group, card, persp, kraName, kraDesc, kraWeight, kpiName, kpiWeight) =>
    trimRow(isFlat
      ? [group, card, kraName, kraDesc, kraWeight, kpiName, kpiWeight]
      : [group, card, persp, kraName, kraDesc, kraWeight, kpiName, kpiWeight]);

  if (activeGroups.length === 0) {
    bannerRow(ws, n, '  ↓  Example rows — delete before uploading your data', C.RED_BANNER, C.RED_TEXT);
    const exRows = [
      kraOnlyRowWithPersp('', 'Managing Partner to Client Director', p1, 'Revenue Growth', 'Grow quarterly revenue', '40'),
      kraOnlyRowWithPersp('', 'Managing Partner to Client Director', p2, 'Client Satisfaction', 'Improve client relationship quality', '35'),
      kraOnlyRowWithPersp('', 'Managing Partner to Client Director', p3, 'Delivery Excellence', 'Raise delivery standards', '25'),
    ];
    for (const row of exRows) {
      const r = ws.addRow(row);
      styleExampleRow(r, n);
      greyKpiCells(r);
    }
    bannerRow(ws, n, '  ↑  Delete examples above  ·  Your pre-fill cards start here  ↓', C.BLUE_FILL, C.BLUE_DARK);
    for (let i = 0; i < 12; i++) styleDataRow(ws.addRow(Array(n).fill('')), n, i);
  } else {
    activeGroups.forEach((group, gi) => {
      const prefillType = group.prefillType || 'kra-only';
      const isKraOnly = prefillType === 'kra-only';
      const segValues = (group.segmentValues || []).map(v => String(v || '').trim()).filter(Boolean);
      const cardNames = segValues.length > 0 ? segValues : [group.name || 'All Employees'];

      if (gi > 0) ws.addRow([]);
      groupBannerRow(gi, group, prefillType);

      const exName = cardNames[0];
      bannerRow(ws, n, `  ↓  Example rows for "${exName}" — delete before uploading`, C.RED_BANNER, C.RED_TEXT);

      const exRows = isKraOnly
        ? [
            kraOnlyRowWithPersp(group.name, exName, p1, 'Revenue Growth', 'Grow quarterly revenue', '40'),
            kraOnlyRowWithPersp(group.name, exName, p2, 'Customer Retention', 'Retain existing client base', '35'),
            kraOnlyRowWithPersp(group.name, exName, p3, 'Process Quality', 'Improve delivery standards', '25'),
          ]
        : [
            kraKpiRow(group.name, exName, p1, 'Revenue Growth', 'Grow quarterly revenue', '40', 'Monthly ARR', '60'),
            kraKpiRow(group.name, exName, p1, 'Revenue Growth', 'Grow quarterly revenue', '40', 'New Client Wins', '40'),
            kraKpiRow(group.name, exName, p2, 'Customer NPS', 'Net promoter score improvement', '35', 'Survey Rate', '100'),
            kraKpiRow(group.name, exName, p3, 'Process Quality', 'Improve delivery standards', '25', 'On-time Rate', '100'),
          ];

      for (const row of exRows) {
        const r = ws.addRow(row);
        styleExampleRow(r, n);
        styleGroupNameCell(r, gi);
        if (isKraOnly) greyKpiCells(r);
      }

      bannerRow(ws, n, `  ↑  Delete examples above  ·  Fill your ${cardNames.length} pre-fill card${cardNames.length === 1 ? '' : 's'} below  ↓`, C.BLUE_FILL, C.BLUE_DARK);

      if (cardNames.length > 1) {
        bannerRow(ws, n, `     Expected Card Names for this group:  ${cardNames.join('  ·  ')}`, 'FFF8FAFC', 'FF64748B', 16);
      }

      const blankCount = Math.min(cardNames.length * 4, 24);
      for (let i = 0; i < blankCount; i++) {
        const blankRow = Array(n).fill('');
        blankRow[0] = group.name;
        const r = ws.addRow(blankRow);
        styleDataRow(r, n, i);
        styleGroupNameCell(r, gi);
        if (isKraOnly) greyKpiCells(r);
      }
    });
  }

  addNoteRows(ws, [
    ['RULES & NOTES'],
    ['• Each employee value you configured in Groups & Strategy becomes one pre-fill card here.'],
    ['• Group Name: pre-filled automatically — do not edit. It identifies the employee group for every card.'],
    ['• Card Name: use the exact configured value such as the designation, band, or department name. Each unique Group Name + Card Name pair becomes one pre-fill card in the UI.'],
    ...(isFlat ? [] : [['• Perspective: must match your configured BSC perspective names exactly.']]),
    ['• KRA Weight % and KPI Weight % can be left blank, but if filled they must be numeric.'],
    ['• KPI columns are only for groups configured as KRAs + KPIs. Grey KPI cells should be left blank.'],
    ['• Delete all red example rows before uploading.'],
    ['• Do not rename, reorder, or delete column headers.'],
    ...(isFlat
      ? []
      : [perspNames.length > 0
          ? [`• Valid Perspectives: ${perspNames.join('  |  ')}`]
          : ['• Perspective names must match what you set in the BSC Perspectives step.']]),
  ]);

  const ref = wb.addWorksheet('Reference', {
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ref.columns = [{ width: 28 }, { width: 55 }];

  const addRefSection = (title, rows) => {
    const tRow = ref.addRow([title]);
    tRow.height = 22;
    applyFill(tRow.getCell(1), C.LABEL_FILL);
    tRow.getCell(1).font = { name: 'Calibri', size: 11, bold: true, color: { argb: C.BLUE_DARK } };
    for (const [a, b] of rows) {
      const r = ref.addRow([a, b]);
      r.height = 18;
      font(r.getCell(1), { bold: true, color: { argb: C.GRAY_TEXT } });
      font(r.getCell(2), { color: { argb: C.NOTE_TEXT } });
    }
    ref.addRow([]);
  };

  addRefSection('Column Guide', [
    ['Group Name', 'Pre-filled automatically — identifies the employee group this pre-fill card belongs to. Do not edit.'],
    ['Card Name', 'The exact designation / segment value that should receive this pre-fill setup. All rows for one card use the same Card Name.'],
    ...(isFlat ? [] : [['Perspective', 'BSC perspective this KRA belongs to. Must match your configured perspective names.']]),
    ['KRA Name', 'Key Result Area that should appear ready-made for employees in this card.'],
    ['KRA Description', 'Optional brief description of the KRA.'],
    ['KRA Weight %', 'Optional suggested KRA weight.'],
    ['KPI Name', 'Only for KRAs + KPIs pre-fill groups. Leave blank for KRA-only groups.'],
    ...(hideKpiWeight ? [] : [['KPI Weight %', 'Optional suggested KPI weight.']]),
  ]);

  if (activeGroups.length > 0) {
    addRefSection('Configured Pre-fill Groups', activeGroups.map((g) => {
      const cardNames = (g.segmentValues || []).filter(Boolean);
      return [
        g.name,
        `${g.prefillType === 'kra-kpi' ? 'KRAs + KPIs' : 'KRAs only'}  |  Cards: ${(cardNames.length > 0 ? cardNames : [g.name]).join(', ')}`,
      ];
    }));
  }

  if (perspNames.length > 0) {
    addRefSection('Configured Perspectives', perspNames.map(name => [name, 'Use this exact name in the Perspective column.']));
  }

  addRefSection('Common Mistakes', [
    ['Wrong Card Name', 'Card Name must match the configured segment value exactly, otherwise the site cannot map it to the right card.'],
    ['Edited Group Name', 'Changing Group Name breaks the mapping between the uploaded rows and the configured employee group.'],
    ...(isFlat ? [] : [['Perspective mismatch', 'Perspective names must match your BSC configuration exactly.']]),
    ['Non-numeric weight', 'If you enter weights, use numbers only such as 40 or 12.5.'],
    ['Filling grey KPI cells', 'Grey KPI cells belong to KRA-only groups and should be left blank.'],
  ]);

  await writeAndDownload(wb, 'zaro_prefill_data_template.xlsx');
}

/* ── PARSE BULK GOAL LIBRARY UPLOAD ─────────────────────────────────────── */
export function parseGoalLibraryBulkXlsx(file, goalGroups = [], options = {}) {
  const { requireGroupName = false } = options;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = async e => {
      try {
        const XLSX = await getXLSX();
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!allRows.length) {
          reject(new Error('File is empty'));
          return;
        }
        const validGroupNames = (goalGroups || []).map(g => String(g?.name || '').trim()).filter(Boolean);
        const validGroupNamesLower = validGroupNames.map(n => n.toLowerCase());

        const headers = (allRows[0] || []).map(h => String(h || '').trim().toLowerCase());
        const idxGroupName = headers.indexOf('group name');
        let idxLibrary = headers.indexOf('library name');
        if (idxLibrary === -1) idxLibrary = headers.indexOf('card name');
        const idxPersp = headers.indexOf('perspective');
        const idxKraName = headers.indexOf('kra name');
        const idxKraDesc = headers.indexOf('kra description');
        const idxKraWeight = headers.indexOf('kra weight %');
        const idxKpiName = headers.indexOf('kpi name');
        const idxKpiWeight = headers.indexOf('kpi weight %');

        if (idxLibrary === -1 || idxKraName === -1) {
          reject(new Error('Missing required columns in the uploaded template'));
          return;
        }
        const isFlatTemplate = idxPersp === -1;

        const librariesByKey = new Map(); // key: "groupName::libraryName" or "libraryName" for old templates
        let validRowCount = 0;

        const readCell = (row, index) => (index >= 0 ? String(row[index] || '').trim() : '');
        const parseWeight = (raw) => {
          const text = String(raw || '').trim();
          if (!text) return { value: null, error: null };
          const numeric = Number(text);
          if (!Number.isFinite(numeric)) return { value: null, error: `"${text}" is not a number` };
          if (numeric < 0) return { value: null, error: `"${text}" cannot be negative` };
          return { value: numeric, error: null };
        };

        const groupNameErrors = [];
        const rowValidationErrors = [];
        for (const [rowIdx, row] of allRows.slice(1).entries()) {
          const firstCell = readCell(row, 0);
          if (!row.some(cell => String(cell || '').trim())) continue;
          if (
            firstCell.startsWith('↓') ||
            firstCell.startsWith('↑') ||
            firstCell.toUpperCase().startsWith('RULES') ||
            firstCell.startsWith('•')
          ) {
            continue;
          }

          const groupName = readCell(row, idxGroupName);
          const libraryName = readCell(row, idxLibrary);
          const perspectiveName = isFlatTemplate ? 'All KRAs' : readCell(row, idxPersp);
          const kraName = readCell(row, idxKraName);
          const kpiName = readCell(row, idxKpiName);

          if (!libraryName || !perspectiveName || !kraName) continue;

          if (requireGroupName) {
            if (!groupName) {
              groupNameErrors.push(`Row ${rowIdx + 2}: Group Name is required (valid: ${validGroupNames.join(', ') || 'none configured'})`);
              continue;
            }
            if (validGroupNamesLower.length > 0 && !validGroupNamesLower.includes(groupName.toLowerCase())) {
              groupNameErrors.push(`Row ${rowIdx + 2}: Group Name "${groupName}" is not one of: ${validGroupNames.join(', ')}`);
              continue;
            }
          }

          validRowCount += 1;

          const kraWeightInfo = parseWeight(readCell(row, idxKraWeight));
          const kpiWeightInfo = parseWeight(readCell(row, idxKpiWeight));
          if (kraWeightInfo.error) {
            rowValidationErrors.push(`Row ${rowIdx + 2}: KRA Weight % ${kraWeightInfo.error}`);
            continue;
          }
          if (kpiWeightInfo.error) {
            rowValidationErrors.push(`Row ${rowIdx + 2}: KPI Weight % ${kpiWeightInfo.error}`);
            continue;
          }
          const kraWeight = kraWeightInfo.value;
          const kpiWeight = kpiWeightInfo.value;

          // Composite key prevents collision when two groups share the same designation/library name.
          // Falls back to plain libraryName for templates generated before Group Name column was added.
          const libKey = groupName
            ? `${groupName.toLowerCase()}::${libraryName.toLowerCase()}`
            : libraryName.toLowerCase();

          if (!librariesByKey.has(libKey)) {
            librariesByKey.set(libKey, {
              id: `lib_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: libraryName,
              groupName,
              type: 'kra-only',
              weightType: 'none',
              perspectivesMap: new Map(),
            });
          }

          const library = librariesByKey.get(libKey);
          if (kpiName) library.type = 'kra-kpi';
          if (kraWeight !== null || kpiWeight !== null) {
            library.weightType = 'suggested';
          }

          const perspectiveKey = perspectiveName.toLowerCase();
          if (!library.perspectivesMap.has(perspectiveKey)) {
            library.perspectivesMap.set(perspectiveKey, {
              id: `lp_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              name: perspectiveName,
              weight: 0,
              krasMap: new Map(),
            });
          }

          const perspective = library.perspectivesMap.get(perspectiveKey);

          const kraKey = kraName.toLowerCase();
          if (!perspective.krasMap.has(kraKey)) {
            perspective.krasMap.set(kraKey, {
              id: `kra_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              name: kraName,
              desc: readCell(row, idxKraDesc),
              suggestedWeight: kraWeight ?? 0,
              kpis: [],
            });
          }

          const kra = perspective.krasMap.get(kraKey);
          if (!kra.desc) kra.desc = readCell(row, idxKraDesc);
          if ((kra.suggestedWeight === 0 || kra.suggestedWeight === null) && kraWeight !== null) {
            kra.suggestedWeight = kraWeight;
          }

          if (kpiName) {
            const normalizedKpi = kpiName.toLowerCase();
            const hasExisting = (kra.kpis || []).some(kpi => kpi.name.toLowerCase() === normalizedKpi);
            if (!hasExisting) {
              kra.kpis.push({
                id: `kpi_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
                name: kpiName,
                weight: kpiWeight ?? 0,
              });
            }
          }
        }

        // Build kra-only lookup using composite keys (groupName::libName).
        // Also keep plain-name fallback for templates uploaded without the Group Name column.
        const kraOnlyCompositeKeys = new Set();
        const kraOnlyPlainNames = new Set();
        for (const group of (goalGroups || [])) {
          if (!group.hasLibrary || (group.libraryType || 'kra-only') !== 'kra-only') continue;
          const gName   = String(group.name || '').trim().toLowerCase();
          const segVals = (group.segmentValues || []).map(v => String(v || '').trim().toLowerCase()).filter(Boolean);
          const names   = segVals.length > 0 ? segVals : [gName];
          names.forEach(name => {
            kraOnlyCompositeKeys.add(`${gName}::${name}`);
            kraOnlyPlainNames.add(name); // backward compat
          });
        }

        const warnings = [];
        const libraries = Array.from(librariesByKey.values()).map(library => {
          const compositeKey = library.groupName
            ? `${library.groupName.toLowerCase()}::${library.name.toLowerCase()}`
            : null;
          const isKraOnly = compositeKey
            ? kraOnlyCompositeKeys.has(compositeKey)
            : kraOnlyPlainNames.has(library.name.toLowerCase());
          if (isKraOnly && library.type === 'kra-kpi') {
            warnings.push(`"${library.name}" (${library.groupName || 'unknown group'}) is configured as KRA-only — KPI entries were ignored.`);
          }
          return {
            id: library.id,
            name: library.name,
            groupName: library.groupName || '',
            type: isKraOnly ? 'kra-only' : library.type,
            weightType: library.weightType,
            perspectives: Array.from(library.perspectivesMap.values()).map(perspective => ({
              id: perspective.id,
              name: perspective.name,
              weight: perspective.weight,
              kras: Array.from(perspective.krasMap.values()).map(kra => ({
                ...kra,
                kpis: isKraOnly ? [] : kra.kpis,
              })),
            })),
          };
        });

        if (groupNameErrors.length > 0) {
          reject(new Error(groupNameErrors.join('\n')));
          return;
        }
        if (rowValidationErrors.length > 0) {
          reject(new Error(rowValidationErrors.join('\n')));
          return;
        }

        if (!validRowCount || libraries.length === 0) {
          reject(new Error('No valid library rows found in the uploaded sheet'));
          return;
        }

        resolve({ libraries, count: libraries.length, warnings });
      } catch (err) {
        reject(new Error('Could not parse file: ' + err.message));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ── PARSE ATTRIBUTE VALUES UPLOAD ──────────────────────────────────────── */
export function parseAttributeValuesXlsx(file, attrLabel) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = async e => {
      try {
        const XLSX = await getXLSX();
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!allRows.length) {
          reject(new Error('File is empty'));
          return;
        }

        const targetLabel = String(attrLabel || 'Attribute').trim();
        const normalizedTarget = targetLabel.toLowerCase();
        const headerRow = (allRows[0] || []).map(cell => String(cell || '').trim());
        const normalizedHeaders = headerRow.map(cell => cell.toLowerCase());

        let valueColIndex = normalizedHeaders.findIndex(header => header === normalizedTarget);
        if (valueColIndex === -1) {
          const nonEmptyHeaderIndex = headerRow.findIndex(Boolean);
          valueColIndex = nonEmptyHeaderIndex >= 0 ? nonEmptyHeaderIndex : 0;
        }

        const seen = new Set();
        const values = [];
        let reachedNotesSection = false;
        for (const row of allRows.slice(1)) {
          const firstCell = String(row[0] || '').trim();
          if (reachedNotesSection) break;
          if (firstCell.toUpperCase().startsWith('NOTES')) {
            reachedNotesSection = true;
            continue;
          }
          if (firstCell.startsWith('▸') || firstCell.startsWith('---') || firstCell.startsWith('•')) continue;
          const rawValue = String(row[valueColIndex] || '').trim();
          if (!rawValue) continue;
          if (rawValue.startsWith('•')) continue;
          const normalizedValue = rawValue.toLowerCase();
          if (normalizedValue === normalizedTarget) continue;
          if (seen.has(normalizedValue)) continue;
          seen.add(normalizedValue);
          values.push(rawValue);
        }

        if (!values.length) {
          reject(new Error(`No ${targetLabel} values found in the uploaded sheet`));
          return;
        }

        resolve({ attrLabel: targetLabel, values, count: values.length });
      } catch (err) {
        reject(new Error('Could not parse file: ' + err.message));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ── PARSE GOAL LIBRARY UPLOAD ───────────────────────────────────────────── */
export function parseGoalLibraryXlsx(file, config) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = async e => {
      try {
        const XLSX = await getXLSX();
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!allRows.length) { reject(new Error('File is empty')); return; }

        const headers = allRows[0].map(h => String(h || '').trim().toLowerCase());
        // skip banner/notice rows (they have no KRA data) and the example notice
        const dataRows = allRows.slice(1).filter(r => {
          const first = String(r[0] || '').trim();
          if (first.startsWith('▸') || first.startsWith('---') || first.toUpperCase().startsWith('NOTES')) return false;
          return r.some(c => String(c || '').trim());
        });

        const isByAttr = headers[0] !== 'perspective';
        const col = name => headers.findIndex(h => h === name.toLowerCase());
        const idxAttr    = isByAttr ? 0 : -1;
        const idxPersp   = col('perspective');
        const idxKraName = col('kra name');
        const idxKraWt   = col('kra weight %');
        const idxKpiName = col('kpi name');
        const idxKpiWt   = col('kpi weight %');
        const hasKpis    = idxKpiName !== -1;
        const isFlatFramework = config.frameworkId === 'kra-kpi' || config.frameworkId === 'kra';

        if (idxKraName === -1) { reject(new Error('Missing "KRA Name" column')); return; }
        if (!isFlatFramework && idxPersp === -1) { reject(new Error('Missing "Perspective" column. BSC goal libraries must use the downloaded template and include a Perspective for every KRA.')); return; }

        const grouped = {};
        let validKraRows = 0;
        for (const row of dataRows) {
          const get = i => (i >= 0 ? String(row[i] || '').trim() : '');
          const attrVal  = isByAttr ? get(idxAttr) : '__common__';
          const perspName = get(idxPersp);
          const kraName  = get(idxKraName);
          const kraWt    = get(idxKraWt);
          if (!kraName) continue;
          validKraRows += 1;

          if (!grouped[attrVal]) grouped[attrVal] = {};
          const kraKey = `${perspName}||${kraName}`;
          if (!grouped[attrVal][kraKey]) {
            grouped[attrVal][kraKey] = { name: kraName, weight: kraWt, perspName, kpis: [] };
          }
          if (hasKpis) {
            const kpiName = get(idxKpiName);
            const kpiWt   = get(idxKpiWt);
            if (kpiName) grouped[attrVal][kraKey].kpis.push({ id: Date.now() + Math.random(), name: kpiName, weight: kpiWt });
          }
        }
        if (!validKraRows) { reject(new Error('No valid KRA rows found in the uploaded sheet. Fill at least one KRA Name row and delete the red example rows before uploading.')); return; }

        const toArray = obj => Object.values(obj).map((k, i) => ({ ...k, id: Date.now() + i }));
        if (isByAttr) {
          const result = {};
          for (const [k, v] of Object.entries(grouped)) result[k] = toArray(v);
          resolve({ byAttr: true, attrLabel: String(allRows[0][0] || '').trim(), data: result });
        } else {
          resolve({ byAttr: false, data: toArray(grouped['__common__'] || {}) });
        }
      } catch (err) { reject(new Error('Could not parse file: ' + err.message)); }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ── EMP CODE FORMAT ──────────────────────────────────────────────────────── */
export function buildEmpCodeRegex(fmt) {
  if (!fmt || fmt.type === 'free') return null;
  if (fmt.type === 'numeric') return /^\d+$/;
  if (fmt.type !== 'custom') return null;
  const segs = fmt.segments || [];
  if (!segs.length) return null;
  let p = '^';
  for (const s of segs) {
    if (s.kind === 'sep') {
      p += s.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (s.kind === 'enum') {
      const vals = (s.values || []).filter(v => String(v).trim());
      if (!vals.length) return null;
      p += `(${vals.map(v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`;
    } else if (s.kind === 'digits') {
      const n = s.length || 1;
      p += `\\d{${n}}`;
    } else if (s.kind === 'alphanum') {
      const n = s.length || 1;
      p += `[A-Za-z0-9]{${n}}`;
    }
  }
  p += '$';
  try { return new RegExp(p); } catch (_) { return null; }
}

/* ── CODE ANOMALY & TYPO DETECTION ───────────────────────────────────────── */

// Levenshtein distance (capped at maxDist+1 for performance)
function levDist(a, b, maxDist = 3) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i;
    for (let j = 1; j <= b.length; j++) {
      const val = a[i-1] === b[j-1] ? row[j-1] : 1 + Math.min(row[j-1], row[j], prev);
      row[j-1] = prev;
      prev = val;
    }
    row[b.length] = prev;
  }
  return row[b.length];
}

// Returns warnings for code pattern anomalies
function detectCodeAnomalies(employees) {
  const warnings = [];
  const allCodes = employees.map(e => (e['Employee Code'] || '').trim()).filter(Boolean);

  // Infer dominant pattern: numeric-only vs prefixed (e.g. EMP001)
  const numericOnly  = allCodes.filter(c => /^\d+$/.test(c));
  const prefixed     = allCodes.filter(c => /^[A-Za-z]+\d+$/.test(c));
  const dominantLen  = (() => {
    const freq = {};
    allCodes.forEach(c => { freq[c.length] = (freq[c.length]||0)+1; });
    return parseInt(Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] || 0);
  })();

  const isNominatedNumeric  = numericOnly.length  / allCodes.length > 0.7;
  const isNominatedPrefixed = prefixed.length     / allCodes.length > 0.7;

  const CONFUSABLE = { o:'0', O:'0', l:'1', I:'1', i:'1', S:'5', Z:'2', B:'8', G:'6' };

  employees.forEach((emp, idx) => {
    const row  = idx + 2;
    const code = (emp['Employee Code'] || '').trim();
    if (!code) return;

    // 1 — confusable characters: O/0, l/1, I/1 etc.
    const corrected = code.split('').map(ch => CONFUSABLE[ch] || ch).join('');
    if (corrected !== code) {
      const likelyCorrected = isNominatedNumeric ? corrected.replace(/[A-Za-z]/g, c => CONFUSABLE[c] || c) : corrected;
      if (likelyCorrected !== code) {
        warnings.push({
          row, code, field: 'emp_code', category: 'code_anomaly',
          message: `Employee Code "${code}" contains characters that may be confused with digits (e.g. O→0, l→1, I→1). Did you mean "${likelyCorrected}"?`,
          suggestion: likelyCorrected,
        });
        return; // don't double-warn
      }
    }

    // 2 — pattern mismatch: numeric dominant but this code isn't
    if (isNominatedNumeric && !/^\d+$/.test(code)) {
      warnings.push({
        row, code, field: 'emp_code', category: 'code_anomaly',
        message: `Employee Code "${code}" contains non-numeric characters while most other codes are numeric. Verify this is intentional.`,
      });
    }

    // 3 — prefix mismatch: prefixed dominant but this code doesn't match
    if (isNominatedPrefixed && !/^[A-Za-z]+\d+$/.test(code)) {
      warnings.push({
        row, code, field: 'emp_code', category: 'code_anomaly',
        message: `Employee Code "${code}" doesn't follow the letter-prefix format used by most other codes. Verify this is intentional.`,
      });
    }

    // 4 — length outlier (any deviation from dominant length is suspicious)
    if (dominantLen > 0 && code.length !== dominantLen) {
      warnings.push({
        row, code, field: 'emp_code', category: 'code_anomaly',
        message: `Employee Code "${code}" has ${code.length} digit${code.length !== 1 ? 's' : ''} but all other codes have ${dominantLen}. Possible extra or missing character?`,
      });
    }

    // 5 — near-duplicate codes: only meaningful for non-numeric prefixed codes
    // (sequential numeric codes like 10026/10027 are always 1 apart — skip for numeric-dominant sets)
    if (!isNominatedNumeric && isNominatedPrefixed) {
      const similar = allCodes.filter(c => c !== code && levDist(c.toLowerCase(), code.toLowerCase(), 1) === 1);
      if (similar.length > 0) {
        warnings.push({
          row, code, field: 'emp_code', category: 'code_anomaly',
          message: `Employee Code "${code}" is 1 character away from "${similar[0]}" — possible duplicate or typo?`,
        });
      }
    }
  });

  return warnings;
}

// Returns warnings for suspiciously similar employee names
function detectSimilarNames(employees) {
  const warnings = [];
  const names = employees.map(e => (e['Employee Name'] || '').trim().toLowerCase());
  const reported = new Set();
  for (let i = 0; i < names.length; i++) {
    if (!names[i] || names[i].length < 5) continue;
    for (let j = i + 1; j < names.length; j++) {
      if (!names[j] || names[j].length < 5) continue;
      const key = `${i}-${j}`;
      if (reported.has(key)) continue;
      const dist = levDist(names[i], names[j], 2);
      if (dist <= 2 && dist > 0) {
        reported.add(key);
        warnings.push({
          row: i + 2,
          code: (employees[i]['Employee Code'] || '').trim(),
          field: 'emp_name', category: 'similar_name',
          message: `Name "${employees[i]['Employee Name']}" (row ${i+2}) is very similar to "${employees[j]['Employee Name']}" (row ${j+2}) — possible duplicate or typo?`,
        });
      }
    }
  }
  return warnings;
}

function normalizeEmployeeNameForCompare(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function validateEmployeeName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    return { valid: false, message: 'Employee Name is missing' };
  }

  const letterTokens = name.match(/\p{L}[\p{L}\p{M}]*/gu) || [];
  if (letterTokens.length === 0) {
    return { valid: false, message: 'Employee Name must contain letters' };
  }
  if (!/^[\p{L}\p{M} .'\-’]+$/u.test(name)) {
    return { valid: false, message: 'Employee Name contains invalid characters — use letters, spaces, dots, apostrophes, or hyphens only' };
  }

  const compactLetters = letterTokens.join('');
  if (compactLetters.length < 2) {
    return { valid: false, message: 'Employee Name looks incomplete — use the employee’s full name' };
  }

  if (letterTokens.length === 1 && !name.includes('.') && /^[\p{Ll}\p{M}]+$/u.test(letterTokens[0])) {
    return { valid: false, message: 'Employee Name looks incomplete or mistyped — use a properly formatted full name' };
  }

  return { valid: true, normalized: normalizeEmployeeNameForCompare(name) };
}

function formatIssueRowList(rows = []) {
  if (rows.length === 0) return '';
  const visibleRows = rows.slice(0, 5).join(', ');
  const extraCount = rows.length - Math.min(rows.length, 5);
  return rows.length === 1
    ? `row ${rows[0]}`
    : `rows ${visibleRows}${extraCount > 0 ? ` +${extraCount} more` : ''}`;
}

/* ── EMPLOYEE TEMPLATE META ──────────────────────────────────────────────── */
const STD_NORM = ['employeecode','employeename','emailid','reportingmanagercode','reportingmanagername','reportingmanageremail','l2managercode','l2managername'];

function attrAlreadyStandard(attrLabel) {
  const norm = attrLabel.toLowerCase().replace(/[^a-z]/g, '');
  return STD_NORM.some(s => s.includes(norm) || norm.includes(s));
}

function normalizeEmployeeFieldKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getEmployeeRowValue(employee, fieldName) {
  if (!employee || !fieldName) return '';
  const directValue = employee[fieldName];
  if (directValue !== undefined && directValue !== null && String(directValue).trim()) {
    return String(directValue).trim();
  }

  const normalizedField = normalizeEmployeeFieldKey(fieldName);
  const matchedKey = Object.keys(employee).find((key) => normalizeEmployeeFieldKey(key) === normalizedField);
  return matchedKey ? String(employee[matchedKey] || '').trim() : '';
}

function pushUniqueNamedValue(target, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return;
  if (target.some(existing => normalizeEmployeeFieldKey(existing) === normalizeEmployeeFieldKey(value))) return;
  target.push(value);
}

const DEFAULT_EMPLOYEE_LIBRARY_SLOT_KEY = '__default__';

function getNormalizedGroupSegmentValues(group) {
  return [...new Set((group?.segmentValues || []).map(value => String(value || '').trim()).filter(Boolean))];
}

function getEmployeeLibraryAssignments(group) {
  const values = getNormalizedGroupSegmentValues(group);
  const expected = values.length === 0
    ? [{ slotKey: DEFAULT_EMPLOYEE_LIBRARY_SLOT_KEY, label: group?.name || 'All Employees' }]
    : values.map(value => ({ slotKey: value, label: value }));
  const existing = group?.libraryAssignments || [];
  const fallbackLibraryId = expected.length === 1 ? (group?.libraryId || null) : null;

  return expected.map(slot => {
    const match = existing.find(assignment => String(assignment?.slotKey || '').trim().toLowerCase() === slot.slotKey.toLowerCase());
    return {
      ...slot,
      libraryId: match?.libraryId ?? fallbackLibraryId,
    };
  });
}

function isEmployeeGroupLibraryEnabled(group) {
  return !!(
    group?.hasLibrary ||
    group?.mode === 'library' ||
    (Array.isArray(group?.modes) && group.modes.includes('library'))
  );
}

export function getEmployeeRoutingColumns(config = {}) {
  const groups = config.goalGroups || [];
  const groupedColumns = [];
  const groupedIndex = new Map();

  groups.forEach(group => {
    const label = String(group?.segmentAttr || '').trim();
    if (!label || attrAlreadyStandard(label)) return;
    const key = normalizeEmployeeFieldKey(label);
    if (!groupedIndex.has(key)) {
      groupedIndex.set(key, groupedColumns.length);
      groupedColumns.push({ label, values: [] });
    }
    const column = groupedColumns[groupedIndex.get(key)];
    (group?.segmentValues || []).forEach(value => pushUniqueNamedValue(column.values, value));
  });

  if (groupedColumns.length > 0) {
    return groupedColumns;
  }

  const {
    goalCreationMode,
    goalLibraryScope,
    goalSegmentAttr,
    goalSegmentValues,
    goalLimitScope,
    goalLimitAttr,
    goalLimitValues,
  } = config;

  const needsLegacyAttr =
    (goalCreationMode === 'admin-library' && goalLibraryScope === 'by-attribute') ||
    (goalCreationMode === 'employee-self' && goalLimitScope === 'by-attribute');

  if (!needsLegacyAttr) return [];

  const label = goalCreationMode === 'admin-library'
    ? (goalSegmentAttr || 'Department')
    : (goalLimitAttr || 'Department');

  if (attrAlreadyStandard(label)) return [];

  const values = goalCreationMode === 'admin-library'
    ? (goalSegmentValues || []).map(value => value?.name)
    : (goalLimitValues || []).map(value => value?.name);

  const uniqueValues = [];
  values.forEach(value => pushUniqueNamedValue(uniqueValues, value));
  return [{ label, values: uniqueValues }];
}

export function employeeTemplateMeta(config) {
  const { managerLevels, requireEmail, empCodeFormat } = config;
  const routingColumns = getEmployeeRoutingColumns(config);
  const hasL2        = (managerLevels || 1) >= 2;
  const needsEmail   = requireEmail !== false;
  const goalGroups   = config.goalGroups || [];
  const hasGoalGroups = goalGroups.length > 0;
  const groupNames   = goalGroups.map(g => String(g.name || '').trim()).filter(Boolean);

  // For each example row index, find the group whose segmentValues contain the primary
  // routing example value — so Group Name is pre-filled correctly in the example rows.
  const getExampleGroupName = (rowIndex) => {
    if (!hasGoalGroups) return '';
    if (routingColumns.length === 0) return goalGroups[rowIndex % goalGroups.length]?.name || '';
    const primaryCol = routingColumns[0];
    const val = primaryCol.values.length > 0
      ? primaryCol.values[rowIndex % primaryCol.values.length]
      : '';
    if (!val) return goalGroups[rowIndex % goalGroups.length]?.name || '';
    const match = goalGroups.find(g =>
      String(g.segmentAttr || '').trim().toLowerCase() === primaryCol.label.toLowerCase() &&
      (g.segmentValues || []).some(sv => String(sv).trim().toLowerCase() === val.toLowerCase())
    );
    return match?.name || goalGroups[rowIndex % goalGroups.length]?.name || '';
  };

  const headers = [
    'Employee Code', 'Employee Name',
    ...(needsEmail ? ['Email ID'] : []),
    ...(hasGoalGroups ? ['Group Name'] : []),
    ...routingColumns.map(column => column.label),
    'Reporting Manager Code', 'Reporting Manager Name',
    ...(needsEmail ? ['Reporting Manager Email'] : []),
    ...(hasL2 ? ['L2 Manager Code', 'L2 Manager Name'] : []),
  ];
  const colWidths = [
    16, 26,
    ...(needsEmail ? [30] : []),
    ...(hasGoalGroups ? [22] : []),
    ...routingColumns.map(() => 18),
    22, 26,
    ...(needsEmail ? [32] : []),
    ...(hasL2 ? [22, 26] : []),
  ];

  const getRoutingExampleValues = (rowIndex) => routingColumns.map((column) => (
    column.values.length > 0 ? column.values[rowIndex % column.values.length] : `${column.label} Value ${rowIndex + 1}`
  ));

  const ex = (code, name, email, groupName, routingValues, mgr, mgrName, mgrEmail, l2Code, l2Name) => [
    code, name,
    ...(needsEmail ? [email] : []),
    ...(hasGoalGroups ? [groupName] : []),
    ...routingValues,
    mgr, mgrName,
    ...(needsEmail ? [mgrEmail] : []),
    ...(hasL2 ? [l2Code, l2Name] : []),
  ];
  const exampleRows = [
    ex('EMP001','Priya Sharma',  'priya@company.com',  getExampleGroupName(0), getRoutingExampleValues(0), 'MGR001','Amit Shah',  'amit@company.com',  'DIR001','Ravi Verma'),
    ex('EMP002','Rahul Mehta',   'rahul@company.com',  getExampleGroupName(1), getRoutingExampleValues(1), 'MGR002','Neha Patel', 'neha@company.com',  'DIR001','Ravi Verma'),
    ex('EMP003','Sneha Iyer',    'sneha@company.com',  getExampleGroupName(2), getRoutingExampleValues(2), 'MGR001','Amit Shah',  'amit@company.com',  'DIR002','Sonal Desai'),
  ];

  const fmtType = empCodeFormat?.type || 'free';
  const codeNote = fmtType === 'numeric'
    ? '• Employee Code must be numeric (digits only).'
    : fmtType === 'custom'
    ? '• Employee Code must follow the configured employee-code rules.'
    : '• Employee Code must be unique. Use the same code consistently across all files.';

  const routingLabels = routingColumns.map(column => `"${column.label}"`);
  const routingNote = routingLabels.length === 0
    ? null
    : routingLabels.length === 1
    ? `• ${routingLabels[0]} identifies the library slot within the group. Use the exact values listed in the Reference sheet.`
    : `• ${routingLabels.slice(0, -1).join(', ')} and ${routingLabels[routingLabels.length - 1]} identify the library slot within the group. Use the exact values listed in the Reference sheet.`;

  const noteRows = [
    ['NOTES'],
    [codeNote],
    ['• Employee Name must be a real person name. Use letters, spaces, dots, apostrophes, or hyphens only.'],
    ...(hasGoalGroups ? [['• Group Name is required on every row and must match the configured group names in the Reference sheet exactly.']] : []),
    ['• Reporting Manager Code can point to any employee — in this file or elsewhere in the org. Leave it blank for top-of-hierarchy roles.'],
    ...(hasL2 ? [['• L2 Manager Code is the skip-level manager (manager of the direct manager).']] : []),
    ...(routingNote ? [[routingNote]] : []),
    ...(requireEmail === false ? [['• Email ID is optional for this configuration.']] : []),
    ['• Each upload replaces the current employee master file. Do not upload one group now and expect the others to remain unless they are included in a later full upload.'],
    ['• Delete the red example rows before uploading.'],
  ];

  return { headers, colWidths, exampleRows, noteRows, routingColumns, hasL2, needsEmail, hasGoalGroups, groupNames };
}

/* ── DOWNLOAD EMPLOYEE TEMPLATE ──────────────────────────────────────────── */
export async function downloadEmployeeTemplate(config) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = employeeTemplateMeta(config);
  const n = meta.headers.length;
  const wb = makeWorkbook(ExcelJS);

  const ws = wb.addWorksheet('Employee Upload', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });
  ws.columns = meta.colWidths.map(w => ({ width: w }));

  styleHeaderRow(ws.addRow(meta.headers), n);
  bannerRow(ws, n, '▸  EXAMPLE ROWS — Replace with your data, then delete these rows before upload', C.RED_BANNER, C.RED_TEXT);
  for (const rowData of meta.exampleRows) styleExampleRow(ws.addRow(rowData), n);
  bannerRow(ws, n, '▸  YOUR DATA — Add one row per employee below', C.BLUE_FILL, C.BLUE);
  for (let i = 0; i < 30; i++) styleDataRow(ws.addRow(meta.headers.map(() => '')), n, i);
  addNoteRows(ws, meta.noteRows);

  /* ── Sheet 2: Reference ── */
  const ref = wb.addWorksheet('Reference', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ref.columns = [{ width: 32 }, { width: 60 }];

  function refSection(title, rows) {
    const tRow = ref.addRow([title]);
    tRow.height = 22;
    const tc = tRow.getCell(1);
    applyFill(tc, C.BLUE);
    applyBorder(tc, 'medium', C.BLUE_DARK);
    font(tc, { bold: true, size: 11, color: { argb: C.WHITE } });
    align(tc);
    for (const [col, desc] of rows) {
      const vRow = ref.addRow([col, desc]);
      vRow.height = 18;
      const c1 = vRow.getCell(1); const c2 = vRow.getCell(2);
      applyFill(c1, C.ALT_ROW); applyFill(c2, C.ALT_ROW);
      applyBorder(c1, 'thin', C.BORD); applyBorder(c2, 'thin', C.BORD);
      font(c1, { bold: true, color: { argb: C.GRAY_TEXT } });
      font(c2, { color: { argb: C.GRAY_TEXT } });
      align(c1); align(c2);
    }
    ref.addRow([]);
  }

  // Column guide
  const colGuide = [
    ['Employee Code', 'Unique identifier for the employee. Must be consistent across all files — same code used every cycle.'],
    ['Employee Name', 'Full name of the employee (display only).'],
    ...(meta.needsEmail ? [['Email ID', 'Work email address. Used for login link and notifications. Must be unique per employee.']] : []),
    ...(meta.hasGoalGroups ? [['Group Name', 'The goal group this employee belongs to. Must exactly match one of the configured group names listed in the "Valid Group Names" section below. Determines which goal library and workflow applies to this employee.']] : []),
    ...meta.routingColumns.map(column => [column.label, `Used to identify the specific library slot within the employee's group. Must match one of the configured values listed in the "${column.label} Values" section below.`]),
    ['Reporting Manager Code', 'Employee Code of the direct reporting manager. It can be inside this upload or outside the PMS rollout. Leave blank only if this employee is at the top of the PMS hierarchy.'],
    ['Reporting Manager Name', 'Full name of the reporting manager. If the manager is outside PMS, keep this filled so the upload treats it as an intentional external-manager reference.'],
    ...(meta.needsEmail ? [['Reporting Manager Email', 'Work email of the reporting manager. Used for manager summary emails.']] : []),
    ...(meta.hasL2 ? [
      ['L2 Manager Code', 'Employee Code of the skip-level manager (manager\'s manager). Optional — leave blank if the employee has no L2 reviewer.'],
      ['L2 Manager Name', 'Full name of the L2 manager (display only). Leave blank if L2 Manager Code is blank.'],
    ] : []),
  ];
  refSection('Column Guide', colGuide);

  // Valid Group Names (when goal groups are configured)
  if (meta.hasGoalGroups && meta.groupNames.length > 0) {
    refSection('Valid Group Names', meta.groupNames.map(name => [name, `Use exactly this value in the "Group Name" column.`]));
  }

  // Valid attribute values (if goal library is segmented)
  meta.routingColumns
    .filter(column => column.values.length > 0)
    .forEach(column => {
      refSection(`Valid ${column.label} Values`, column.values.map(value => [value, `Use exactly this value in the "${column.label}" column.`]));
    });

  await writeAndDownload(wb, 'employee_upload_template.xlsx');
}

/* ── PARSE EMPLOYEE UPLOAD ───────────────────────────────────────────────── */
export function parseEmployeeXlsx(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = async e => {
      try {
        const XLSX = await getXLSX();
        const wb = XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (!allRows.length) { reject(new Error('File is empty')); return; }

        const headers = allRows[0].map(h => String(h || '').trim());
        const dataRows = allRows.slice(1).filter(r => {
          const first = String(r[0] || '').trim();
          if (first.startsWith('▸') || first.startsWith('---') || first.toUpperCase().startsWith('NOTES')) return false;
          return r.some(c => String(c || '').trim());
        });

        const employees = dataRows.map(row => {
          const obj = {};
          headers.forEach((h, i) => { obj[h] = String(row[i] || '').trim(); });
          return obj;
        }).filter(e => e['Employee Code'] || e['Employee Name']);

        resolve({ headers, employees, count: employees.length });
      } catch (err) { reject(new Error('Could not parse file: ' + err.message)); }
    };
    reader.readAsArrayBuffer(file);
  });
}

/* ── VALIDATE EMPLOYEE DATA ──────────────────────────────────────────────── */
export function validateEmployeeData(employees, config) {
  const errors = [];
  const warnings = [];
  const {
    empCodeFormat, managerLevels, requireEmail,
  } = config;

  const regex = buildEmpCodeRegex(empCodeFormat);
  const hasL2 = (managerLevels || 1) >= 2;
  const emailRequired = requireEmail !== false;
  const routingColumns = getEmployeeRoutingColumns(config);
  const goalGroups = config.goalGroups || [];
  const hasGoalGroups = goalGroups.length > 0;
  const validGroupNames = new Set(goalGroups.map(g => String(g.name || '').trim().toLowerCase()).filter(Boolean));
  const validLibraryIds = new Set((config.goalLibraries || []).map(library => library.id));

  const seenCodes = new Map();
  const allCodes = new Set(
    employees.map(e => (e['Employee Code'] || '').trim().toLowerCase()).filter(Boolean)
  );

  // Pre-pass: build a full code → employee record map so manager-name mismatch
  // checks work regardless of row order (e.g. manager listed after subordinate).
  const codeToEmployee = new Map();
  employees.forEach((emp, idx) => {
    const rowNum = idx + 2;
    const empCode = (emp['Employee Code'] || '').trim();
    if (!empCode) return;
    const empName = (emp['Employee Name'] || '').trim();
    const empEmail = (emp['Email ID'] || '').trim();
    const nv = validateEmployeeName(empName);
    const key = empCode.toLowerCase();
    if (codeToEmployee.has(key)) return; // keep the first occurrence
    codeToEmployee.set(key, {
      row: rowNum,
      name: empName,
      normalizedName: nv.valid ? nv.normalized : normalizeEmployeeNameForCompare(empName),
      email: empEmail,
      normalizedEmail: empEmail.toLowerCase(),
    });
  });
  employees.forEach((emp, idx) => {
    const row = idx + 2; // 1-based, +1 for header row
    const code = (emp['Employee Code'] || '').trim();
    const name = (emp['Employee Name'] || '').trim();
    const email = (emp['Email ID'] || '').trim();
    const nameValidation = validateEmployeeName(name);

    // Employee Code
    if (!code) {
      errors.push({ row, code: '—', field: 'emp_code', message: 'Employee Code is missing' });
    } else {
      const normalizedCode = code.toLowerCase();
      const firstSeen = seenCodes.get(normalizedCode);
      if (firstSeen) {
        const nameMismatch =
          nameValidation.valid &&
          firstSeen.normalizedName &&
          nameValidation.normalized !== firstSeen.normalizedName;
        const emailMismatch =
          email &&
          firstSeen.email &&
          email.toLowerCase() !== firstSeen.email.toLowerCase();
        if (nameMismatch) {
          errors.push({
            row,
            code,
            field: 'emp_code',
            message: `Employee Code "${code}" is reused with a different name. Row ${firstSeen.row} has "${firstSeen.name}", but this row has "${name}".`,
          });
        } else if (emailMismatch) {
          errors.push({
            row,
            code,
            field: 'email',
            message: `Employee Code "${code}" is reused with a different Email ID. Row ${firstSeen.row} has "${firstSeen.email}", but this row has "${email}".`,
          });
        } else {
          errors.push({ row, code, field: 'emp_code', message: `Duplicate Employee Code "${code}"` });
        }
      } else {
        seenCodes.set(normalizedCode, {
          row,
          name,
          normalizedName: nameValidation.valid ? nameValidation.normalized : normalizeEmployeeNameForCompare(name),
          email,
        });
      }
      if (regex && !regex.test(code)) {
        errors.push({ row, code, field: 'emp_code', message: `Employee Code "${code}" is invalid — must be numeric digits only` });
      }
    }

    // Employee Name
    if (!nameValidation.valid) {
      errors.push({ row, code: code || '—', field: 'emp_name', message: nameValidation.message });
    }

    // Email
    if (emailRequired && !(emp['Email ID'] || '').trim()) {
      errors.push({ row, code: code || '—', field: 'email', message: 'Email ID is missing' });
    }

    let matchedGroup = null;
    if (hasGoalGroups) {
      const groupName = getEmployeeRowValue(emp, 'Group Name');
      if (!groupName) {
        errors.push({ row, code: code || '—', field: 'group_name',
          message: 'Group Name is required. Use the exact group name from the Reference sheet.' });
      } else if (!validGroupNames.has(groupName.toLowerCase())) {
        errors.push({ row, code: code || '—', field: 'group_name',
          message: `"${groupName}" is not a configured group name. Use the exact names from the Reference sheet.` });
    } else {
        matchedGroup = goalGroups.find(group => String(group.name || '').trim().toLowerCase() === groupName.toLowerCase()) || null;
      }
    }

    if (hasGoalGroups && routingColumns.length > 0) {
      routingColumns.forEach(column => {
        const attrVal = getEmployeeRowValue(emp, column.label);
        const validValues = column.values || [];
        const validValueSet = new Set(validValues.map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
        if (!attrVal) {
          errors.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(column.label),
            message: `"${column.label}" is required. Use one of the configured values from the Reference sheet.` });
        } else if (validValueSet.size > 0 && !validValueSet.has(attrVal.toLowerCase())) {
          errors.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(column.label),
            message: `"${attrVal}" is not a valid ${column.label}. Use one of: ${validValues.join(', ')}.` });
        }
      });
    }

    if (hasGoalGroups && isEmployeeGroupLibraryEnabled(matchedGroup)) {
      const routeAttr = String(matchedGroup.segmentAttr || '').trim();
      const routeValues = getNormalizedGroupSegmentValues(matchedGroup);
      const routeValue = routeAttr ? getEmployeeRowValue(emp, routeAttr) : '';
      const assignments = getEmployeeLibraryAssignments(matchedGroup);
      const routeValueValid = routeValues.length === 0 || routeValues.some(value => value.toLowerCase() === routeValue.toLowerCase());

      if (routeValues.length > 0) {
        if (!routeAttr) {
          errors.push({ row, code: code || '—', field: 'library_assignment',
            message: `Group "${matchedGroup.name}" needs a routing field to resolve its goal library, but that field is not configured.` });
        } else if (!routeValue) {
          errors.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(routeAttr),
            message: `"${routeAttr}" is required for group "${matchedGroup.name}" because it decides the library tagging.` });
        } else if (!routeValueValid) {
          errors.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(routeAttr),
            message: `"${routeValue}" is not a valid ${routeAttr} for group "${matchedGroup.name}". Use one of: ${routeValues.join(', ')}.` });
        }
      }

      const matchedAssignment = routeValues.length > 0
        ? assignments.find(assignment => assignment.slotKey.toLowerCase() === routeValue.toLowerCase()) || null
        : assignments[0] || null;

      if (routeValues.length === 0 && !matchedAssignment) {
        errors.push({ row, code: code || '—', field: 'library_assignment',
          message: `Group "${matchedGroup.name}" has Goal Library enabled but no library slot is configured.` });
      } else if (routeValues.length > 0 && routeValueValid && !matchedAssignment) {
        errors.push({ row, code: code || '—', field: 'library_assignment',
          message: `No goal library slot is configured for ${routeAttr} "${routeValue}" in group "${matchedGroup.name}".` });
      } else if (matchedAssignment && !matchedAssignment.libraryId) {
        const slotLabel = routeValues.length > 0 ? `${routeAttr} "${matchedAssignment.label}"` : 'the default slot';
        errors.push({ row, code: code || '—', field: 'library_assignment',
          message: `Group "${matchedGroup.name}" does not have a goal library assigned for ${slotLabel}.` });
      } else if (matchedAssignment?.libraryId && !validLibraryIds.has(matchedAssignment.libraryId)) {
        errors.push({ row, code: code || '—', field: 'library_assignment',
          message: `Group "${matchedGroup.name}" points to a goal library that no longer exists.` });
      }
    } else if (!hasGoalGroups) {
      routingColumns.forEach(column => {
        const attrVal = getEmployeeRowValue(emp, column.label);
        const validValues = column.values || [];
        const validValueSet = new Set(validValues.map(value => value.toLowerCase()));

        if (!attrVal) {
          warnings.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(column.label), category: 'routing_blank',
            message: `"${column.label}" is blank — this employee may fall into the default group or miss library assignment` });
        } else if (validValueSet.size > 0 && !validValueSet.has(attrVal.toLowerCase())) {
          warnings.push({ row, code: code || '—', field: normalizeEmployeeFieldKey(column.label), category: 'routing_unknown',
            message: `"${attrVal}" is not one of the configured ${column.label} values. The employee will only map if a catch-all group exists.` });
        }
      });
    }

    // Reporting Manager: blank = top of hierarchy. Non-blank codes that
    // aren't in the file are treated as ordinary external references (no
    // warning). Only flag name inconsistency when the manager IS in the file.
    const l1Code = getEmployeeRowValue(emp, 'Reporting Manager Code');
    if (l1Code && allCodes.has(l1Code.toLowerCase())) {
      const l1Key = l1Code.toLowerCase();
      const l1Name = getEmployeeRowValue(emp, 'Reporting Manager Name');
      const l1Email = getEmployeeRowValue(emp, 'Reporting Manager Email');
      const empRecord = codeToEmployee.get(l1Key);
      if (empRecord && l1Name && empRecord.normalizedName && normalizeEmployeeNameForCompare(l1Name) !== empRecord.normalizedName) {
        errors.push({
          row, code: code || '—', field: 'l1_manager',
          category: 'manager_name_mismatch',
          message: `Reporting Manager Name "${l1Name}" doesn't match Employee Name "${empRecord.name}" for code "${l1Code}" (row ${empRecord.row}).`,
        });
      }
      if (empRecord && l1Email && empRecord.normalizedEmail && l1Email.toLowerCase() !== empRecord.normalizedEmail) {
        errors.push({
          row, code: code || '—', field: 'l1_manager',
          category: 'manager_email_mismatch',
          message: `Reporting Manager Email "${l1Email}" doesn't match Email ID "${empRecord.email}" for code "${l1Code}" (row ${empRecord.row}).`,
        });
      }
    }

    // L2 Manager (optional per employee) — same treatment as L1.
    if (hasL2) {
      const l2Code = getEmployeeRowValue(emp, 'L2 Manager Code');
      if (l2Code && allCodes.has(l2Code.toLowerCase())) {
        const l2Key = l2Code.toLowerCase();
        const l2Name = getEmployeeRowValue(emp, 'L2 Manager Name');
        const l2Email = getEmployeeRowValue(emp, 'L2 Manager Email');
        const empRecord = codeToEmployee.get(l2Key);
        if (empRecord && l2Name && empRecord.normalizedName && normalizeEmployeeNameForCompare(l2Name) !== empRecord.normalizedName) {
          errors.push({
            row, code: code || '—', field: 'l2_manager',
            category: 'manager_name_mismatch',
            message: `L2 Manager Name "${l2Name}" doesn't match Employee Name "${empRecord.name}" for code "${l2Code}" (row ${empRecord.row}).`,
          });
        }
        if (empRecord && l2Email && empRecord.normalizedEmail && l2Email.toLowerCase() !== empRecord.normalizedEmail) {
          errors.push({
            row, code: code || '—', field: 'l2_manager',
            category: 'manager_email_mismatch',
            message: `L2 Manager Email "${l2Email}" doesn't match Email ID "${empRecord.email}" for code "${l2Code}" (row ${empRecord.row}).`,
          });
        }
      }
    }
  });

  // Rule C: Managers referenced only as RM (not present as Employee Code) must
  // carry a consistent Name + Email across every row they appear in.
  const mgrOnlyByCode = new Map();
  const recordMgrReference = (label, codeField, nameField, emailField) => {
    employees.forEach((emp, idx) => {
      const row = idx + 2;
      const rmCode = getEmployeeRowValue(emp, codeField);
      if (!rmCode) return;
      const rmKey = rmCode.toLowerCase();
      if (allCodes.has(rmKey)) return; // covered by Rule B
      const rmName = getEmployeeRowValue(emp, nameField);
      const rmEmail = getEmployeeRowValue(emp, emailField);
      const normalizedName = rmName ? normalizeEmployeeNameForCompare(rmName) : '';
      const normalizedEmail = rmEmail ? rmEmail.toLowerCase() : '';
      const existing = mgrOnlyByCode.get(rmKey);
      if (!existing) {
        mgrOnlyByCode.set(rmKey, {
          firstRow: row,
          name: rmName,
          normalizedName,
          email: rmEmail,
          normalizedEmail,
          field: label,
        });
        return;
      }
      const nameClash = rmName && existing.normalizedName && normalizedName !== existing.normalizedName;
      const emailClash = rmEmail && existing.normalizedEmail && normalizedEmail !== existing.normalizedEmail;
      if (nameClash) {
        errors.push({
          row, code: rmCode, field: label,
          category: 'manager_name_mismatch',
          message: `${nameField} "${rmName}" doesn't match row ${existing.firstRow} which has "${existing.name}" for code "${rmCode}".`,
        });
      }
      if (emailClash) {
        errors.push({
          row, code: rmCode, field: label,
          category: 'manager_email_mismatch',
          message: `${emailField} "${rmEmail}" doesn't match row ${existing.firstRow} which has "${existing.email}" for code "${rmCode}".`,
        });
      }
    });
  };
  recordMgrReference('l1_manager', 'Reporting Manager Code', 'Reporting Manager Name', 'Reporting Manager Email');
  if (hasL2) {
    recordMgrReference('l2_manager', 'L2 Manager Code', 'L2 Manager Name', 'L2 Manager Email');
  }

  // Code anomaly and similar-name checks
  for (const w of detectCodeAnomalies(employees)) warnings.push(w);
  for (const w of detectSimilarNames(employees))  warnings.push(w);

  return { errors, warnings };
}

/* ── DOWNLOAD CORRECTION SHEET ───────────────────────────────────────────── */
export async function downloadCorrectionSheet(employees, flaggedRows, config) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = employeeTemplateMeta(config);
  const wb   = makeWorkbook(ExcelJS);

  const C = { BLUE:'FF2563EB', BLUE_DARK:'FF1D4ED8', WHITE:'FFFFFFFF', AMB_FILL:'FFFFF7ED', AMB_BORD:'FFFED7AA', AMB_TEXT:'FFB45309', ALT:'FFF8FAFC', BORD:'FFE2E8F0', GRAY:'FF64748B' };

  const ws = wb.addWorksheet('Correction Sheet', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 2, topLeftCell: 'A3' }],
    properties: { tabColor: { argb: 'FFFBBF24' } },
  });

  const allHeaders = [...meta.headers, '⚠ Issue to correct'];
  const allWidths  = [...meta.colWidths, 60];
  const n = allHeaders.length;
  ws.columns = allWidths.map(w => ({ width: w }));

  styleHeaderRow(ws.addRow(allHeaders), n);
  bannerRow(ws, n, '▸  Fix the highlighted rows, then re-upload using the main Upload button', 'FFFFF7ED', 'FFB45309');

  // Build issue map: row-number → messages
  const issueMap = {};
  for (const w of flaggedRows) {
    if (!issueMap[w.row]) issueMap[w.row] = [];
    issueMap[w.row].push(w.message);
  }
  const flaggedRowNums = new Set(flaggedRows.map(w => w.row));

  employees.forEach((emp, idx) => {
    const rowNum = idx + 2;
    if (!flaggedRowNums.has(rowNum)) return;
    const vals = meta.headers.map(h => emp[h] || '');
    const issues = (issueMap[rowNum] || []).join(' | ');
    const row = ws.addRow([...vals, issues]);
    row.height = 18;
    for (let ci = 1; ci <= n; ci++) {
      const cell = row.getCell(ci);
      applyFill(cell, C.AMB_FILL);
      applyBorder(cell, 'thin', C.AMB_BORD);
      font(cell, { color: { argb: ci === n ? C.AMB_TEXT : '00000000' }, bold: ci === n });
      align(cell);
    }
  });

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  await writeAndDownload(wb, `employee_CORRECTION_SHEET_${ts}.xlsx`);
}

/* ── DOWNLOAD EMPLOYEE ERROR REPORT ─────────────────────────────────────── */
export async function downloadEmployeeErrorReport(employees, errors, warnings, config) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = employeeTemplateMeta(config);

  const E = { FILL: 'FFFFF7ED', BORDER: 'FFFED7AA', TEXT: 'FFB45309', TAB: 'FFEA580C' };
  const RED = { FILL: 'FFFEF2F2', BORDER: 'FFFECACA', TEXT: 'FFDC2626' };

  const wb = makeWorkbook(ExcelJS);

  /* ── Sheet 1: Error Report ── */
  const allHeaders = [...meta.headers, '⚠ Notes'];
  const allWidths  = [...meta.colWidths, 52];
  const n = allHeaders.length;

  const ws = wb.addWorksheet('Error Report', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: E.TAB } },
  });
  ws.columns = allWidths.map(w => ({ width: w }));

  styleHeaderRow(ws.addRow(allHeaders), n);
  bannerRow(ws, n, '▸  Rows with errors are highlighted — fix and re-upload', 'FFFEE2E2', 'FFDC2626');

  // Build a row-number → messages map
  const rowMessages = {};
  for (const e of errors) {
    if (!rowMessages[e.row]) rowMessages[e.row] = [];
    rowMessages[e.row].push(`✕ ${e.message}`);
  }
  for (const w of warnings) {
    if (!rowMessages[w.row]) rowMessages[w.row] = [];
    rowMessages[w.row].push(`⚠ ${w.message}`);
  }

  employees.forEach((emp, idx) => {
    const rowNum = idx + 2;
    const notes = (rowMessages[rowNum] || []).join('  |  ');
    const hasError = errors.some(e => e.row === rowNum);
    const hasWarn  = !hasError && warnings.some(w => w.row === rowNum);

    const rowData = meta.headers.map(h => emp[h] || '');
    rowData.push(notes);
    const row = ws.addRow(rowData);
    row.height = 18;

    for (let c = 1; c <= n; c++) {
      const cell = row.getCell(c);
      if (hasError) {
        applyFill(cell, RED.FILL.slice(2));
        applyBorder(cell, 'thin', RED.BORDER.slice(2));
        font(cell, c === n ? { color: { argb: RED.TEXT.slice(2) }, bold: true } : { color: { argb: '00374151' } });
      } else if (hasWarn) {
        applyFill(cell, E.FILL.slice(2));
        applyBorder(cell, 'thin', E.BORDER.slice(2));
        font(cell, c === n ? { color: { argb: E.TEXT.slice(2) }, bold: true } : { color: { argb: '00374151' } });
      } else {
        applyFill(cell, 'FFF8FAFC');
        applyBorder(cell, 'thin', 'FFE2E8F0');
        font(cell, { color: { argb: '00374151' } });
      }
      align(cell, c === n ? 'left' : 'left');
    }
  });

  /* ── Sheet 2: Error Summary ── */
  const ws2 = wb.addWorksheet('Error Summary', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ws2.columns = [{ width: 10 }, { width: 20 }, { width: 70 }];

  const addSummaryHeader = (label, fillArgb, textArgb) => {
    const r = ws2.addRow([label]);
    r.height = 22;
    const c = r.getCell(1);
    applyFill(c, fillArgb);
    applyBorder(c, 'medium', fillArgb);
    font(c, { bold: true, size: 11, color: { argb: textArgb } });
    align(c);
    ws2.mergeCells(r.number, 1, r.number, 3);
  };

  const addSummaryRow = (row, code, message, fillArgb, textArgb) => {
    const r = ws2.addRow([`Row ${row}`, code, message]);
    r.height = 18;
    for (let c = 1; c <= 3; c++) {
      const cell = r.getCell(c);
      applyFill(cell, fillArgb);
      applyBorder(cell, 'thin', c === 3 ? 'FFFECACA' : 'FFFECACA');
      font(cell, { color: { argb: textArgb }, ...(c === 1 ? { bold: true } : {}) });
      align(cell);
    }
  };

  const totalRows = employees.length;
  const errorRows = new Set(errors.map(e => e.row)).size;
  const warnRows  = new Set(warnings.map(w => w.row)).size;
  const cleanRows = totalRows - errorRows;

  const summaryBanner = ws2.addRow([`Employee Upload — ${errors.length} error${errors.length !== 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''}  ·  ${cleanRows} of ${totalRows} rows OK`]);
  summaryBanner.height = 26;
  const sb = summaryBanner.getCell(1);
  applyFill(sb, C.BLUE_DARK);
  applyBorder(sb, 'medium', C.BLUE_DARK);
  font(sb, { bold: true, size: 12, color: { argb: C.WHITE } });
  align(sb);
  ws2.mergeCells(summaryBanner.number, 1, summaryBanner.number, 3);

  ws2.addRow([]);

  if (errors.length > 0) {
    addSummaryHeader(`✕  Errors (${errors.length}) — must fix before re-upload`, RED.FILL.slice(2), RED.TEXT.slice(2));
    for (const e of errors) addSummaryRow(e.row, e.code, e.message, RED.FILL.slice(2), RED.TEXT.slice(2));
    ws2.addRow([]);
  }
  if (warnings.length > 0) {
    addSummaryHeader(`⚠  Warnings (${warnings.length}) — review recommended`, E.FILL.slice(2), E.TEXT.slice(2));
    for (const w of warnings) addSummaryRow(w.row, w.code, w.message, E.FILL.slice(2), E.TEXT.slice(2));
  }

  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  await writeAndDownload(wb, `employee_upload_ERROR_REPORT_${ts}.xlsx`);
}

/* ── VALIDATE GOAL LIBRARY DATA ──────────────────────────────────────────── */
export function validateGoalLibraryData(parsedData, config) {
  const errors = [];
  const isFlatFramework = config.frameworkId === 'kra-kpi' || config.frameworkId === 'kra';
  const perspectives = isFlatFramework ? [] : (config.perspectives || []).map(p => p.name).filter(Boolean);
  const hasKpis = config.goalKpiMode === 'kra-kpi';
  const numericPattern = /^\d+(\.\d+)?$/;
  const normalizeName = (value) => String(value || '').trim().replace(/\s+/g, ' ');

  function validateGroup(groupLabel, kras) {
    if (!kras || kras.length === 0) {
      errors.push({ group: groupLabel, kraName: null, kpiName: null, field: 'kra_missing', message: `No KRAs found in group "${groupLabel}"` });
      return;
    }

    const seenNames = {};
    let totalWeight = 0;

    for (const kra of kras) {
      // KRA name missing
      const normalizedKraName = normalizeName(kra.name);
      if (!normalizedKraName) {
        errors.push({ group: groupLabel, kraName: kra.name || null, kpiName: null, field: 'kra_name', message: 'KRA has no name' });
        continue;
      }

      // Duplicate KRA name within same group
      const nameKey = normalizedKraName.toLowerCase();
      if (seenNames[nameKey]) {
        errors.push({ group: groupLabel, kraName: normalizedKraName, kpiName: null, field: 'kra_name', message: `Duplicate KRA name "${normalizedKraName}" in group "${groupLabel}"` });
      } else {
        seenNames[nameKey] = true;
      }

      // KRA perspective — required and must match a configured perspective (BSC only)
      if (!isFlatFramework) {
        if (!kra.perspName || !String(kra.perspName).trim()) {
          errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'perspective', message: `KRA "${kra.name}" has no perspective` });
        } else if (perspectives.length > 0) {
          const perspLower = String(kra.perspName).trim().toLowerCase();
          const matched = perspectives.some(p => p.toLowerCase() === perspLower);
          if (!matched) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'perspective', message: `"${kra.perspName}" does not match any configured perspective` });
          }
        }
      }

      // KRA weight — optional (weights are suggested pre-fills, not enforced totals).
      // Only validate format if a value was actually provided.
      const kraWeightValue = String(kra.weight ?? '').trim();
      const wt = parseFloat(kraWeightValue);
      const kraHasWeight = kraWeightValue !== '' && numericPattern.test(kraWeightValue) && !Number.isNaN(wt);
      if (kraWeightValue !== '' && !kraHasWeight) {
        errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kra_weight', message: `KRA "${kra.name}" weight must be a numeric value (or leave blank for no suggestion)` });
      } else if (kraHasWeight && wt < 0) {
        errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kra_weight', message: `KRA "${kra.name}" weight cannot be negative` });
      } else if (kraHasWeight) {
        totalWeight += wt;
      }

      // KPI names and weights — optional; only validate format if a value was provided
      if (hasKpis && kra.kpis && kra.kpis.length > 0) {
        const seenKpiNames = {};
        for (const kpi of kra.kpis) {
          const kpiName = normalizeName(kpi.name);
          if (!kpiName) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kpi_name', message: `KPI in "${kra.name}" has no name` });
            continue;
          }
          const kpiNameKey = kpiName.toLowerCase();
          if (seenKpiNames[kpiNameKey]) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName, field: 'kpi_name', message: `Duplicate KPI name "${kpiName}" in "${kra.name}"` });
          } else {
            seenKpiNames[kpiNameKey] = true;
          }

          const kpiWeightValue = String(kpi.weight ?? '').trim();
          if (kpiWeightValue !== '') {
            const kpiWeight = parseFloat(kpiWeightValue);
            if (!numericPattern.test(kpiWeightValue) || Number.isNaN(kpiWeight)) {
              errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName, field: 'kpi_weight', message: `KPI "${kpiName}" weight must be numeric (or leave blank for no suggestion)` });
            } else if (kpiWeight < 0) {
              errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName, field: 'kpi_weight', message: `KPI "${kpiName}" weight cannot be negative` });
            }
          }
        }
      }
    }

    // Weight sum is informational only — library is a reference catalog, not a fixed allocation.
    // No error is raised here; the employee plan enforces its own 100% sum.
  }

  if (parsedData.byAttr) {
    for (const [groupLabel, kras] of Object.entries(parsedData.data)) {
      validateGroup(groupLabel, kras);
    }
  } else {
    validateGroup('All Employees', parsedData.data);
  }

  return errors;
}

/* ── DOWNLOAD ERROR REPORT ───────────────────────────────────────────────── */
export async function downloadErrorReport(parsedData, errors, config) {
  const { default: ExcelJS } = await getExcelJS();
  const meta = goalLibraryTemplateMeta(config);
  const hasKpis = config.goalKpiMode === 'kra-kpi';
  const isByAttr = parsedData.byAttr;

  // Orange palette
  const O = {
    FILL:   'FFFFF7ED',
    BORDER: 'FFFED7AA',
    TEXT:   'FFB45309',
    BANNER: 'FFEA580C',
    TAB:    'FFEA580C',
  };

  const wb = makeWorkbook(ExcelJS);

  /* ── Sheet 1: Error Report ── */
  const allHeaders = [...meta.headers, '⚠ Notes'];
  const allWidths  = [...meta.colWidths, 40];
  const n = allHeaders.length;

  const ws = wb.addWorksheet('Error Report', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: O.TAB } },
  });
  ws.columns = allWidths.map(w => ({ width: w }));

  // Header row
  const headerRow = ws.addRow(allHeaders);
  styleHeaderRow(headerRow, n);

  // Red banner
  bannerRow(ws, n, '▸  ERRORS FOUND — Fix highlighted rows and re-upload', 'FFFEE2E2', 'FFDC2626');

  // Flatten parsedData to rows
  function flattenToRows() {
    const rows = [];
    const groups = isByAttr ? Object.entries(parsedData.data) : [['All Employees', parsedData.data]];
    for (const [groupLabel, kras] of groups) {
      for (const kra of kras) {
        if (hasKpis && kra.kpis && kra.kpis.length > 0) {
          for (const kpi of kra.kpis) {
            if (isByAttr) {
              rows.push({ groupLabel, kra, kpi, cells: [groupLabel, kra.perspName, kra.name, kra.weight, kpi.name, kpi.weight] });
            } else {
              rows.push({ groupLabel, kra, kpi, cells: [kra.perspName, kra.name, kra.weight, kpi.name, kpi.weight] });
            }
          }
        } else {
          if (isByAttr) {
            rows.push({ groupLabel, kra, kpi: null, cells: [groupLabel, kra.perspName, kra.name, kra.weight] });
          } else {
            rows.push({ groupLabel, kra, kpi: null, cells: [kra.perspName, kra.name, kra.weight] });
          }
        }
      }
    }
    return rows;
  }

  function getRowErrors(groupLabel, kra, kpi) {
    const matchGroup = isByAttr ? groupLabel : 'All Employees';
    return errors.filter(err => {
      const groupMatch = !err.group || err.group.toLowerCase() === matchGroup.toLowerCase() || err.group === 'All Employees';
      const kraMatch = !err.kraName || err.kraName.toLowerCase() === (kra.name || '').toLowerCase();
      if (err.field === 'kpi_weight') return groupMatch && kraMatch;
      if (err.field === 'weight' && !err.kraName) return groupMatch;
      return groupMatch && kraMatch;
    });
  }

  const flatRows = flattenToRows();
  flatRows.forEach((r, idx) => {
    const rowErrors = getRowErrors(r.groupLabel, r.kra, r.kpi);
    const hasErrors = rowErrors.length > 0;
    const noteText = hasErrors ? rowErrors.map(e => e.message).join('; ') : '✓ OK';
    const dataRow = ws.addRow([...r.cells, noteText]);
    dataRow.height = 20;

    for (let c = 1; c <= n; c++) {
      const cell = dataRow.getCell(c);
      if (hasErrors) {
        applyFill(cell, O.FILL);
        applyBorder(cell, 'thin', O.BORDER);
        font(cell, { name: 'Calibri', size: 10.5, color: { argb: c === n ? O.TEXT : C.GRAY_TEXT } });
      } else {
        applyFill(cell, C.WHITE);
        applyBorder(cell, 'thin', C.BORD);
        font(cell, { name: 'Calibri', size: 10.5, color: { argb: c === n ? 'FF16A34A' : C.GRAY_TEXT } });
      }
      align(cell);
    }
  });

  /* ── Sheet 2: Error Summary ── */
  const ws2 = wb.addWorksheet('Error Summary', {
    views: [{ showGridLines: false }],
    properties: { tabColor: { argb: O.TAB } },
  });
  ws2.columns = [{ width: 20 }, { width: 18 }, { width: 30 }, { width: 50 }];

  const summaryHeaders = ['Group', 'Field', 'KRA', 'Issue'];
  const summaryHeaderRow = ws2.addRow(summaryHeaders);
  styleHeaderRow(summaryHeaderRow, 4);

  errors.forEach((err, i) => {
    const row = ws2.addRow([err.group || 'All Employees', err.field || '', err.kraName || '', err.message || '']);
    row.height = 20;
    const fillColor = i % 2 === 0 ? 'FFF8FAFC' : C.WHITE;
    for (let c = 1; c <= 4; c++) {
      const cell = row.getCell(c);
      applyFill(cell, fillColor);
      applyBorder(cell, 'thin', C.BORD);
      font(cell, { color: { argb: C.GRAY_TEXT } });
      align(cell);
    }
  });

  await writeAndDownload(wb, 'goal_library_errors.xlsx');
}
