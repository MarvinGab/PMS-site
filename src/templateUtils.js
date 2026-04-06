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
// Columns: Library Name | Perspective | Persp. Weight % | KRA Name | KRA Description | KRA Weight % | KPI Name | KPI Description | KPI Weight %
export async function downloadGoalLibraryBulkTemplate(configOrPerspectives = []) {
  const { default: ExcelJS } = await getExcelJS();
  const wb = makeWorkbook(ExcelJS);

  const config = Array.isArray(configOrPerspectives)
    ? { perspectives: configOrPerspectives }
    : (configOrPerspectives || {});

  const perspectives = config.perspectives || [];
  const goalGroups = config.goalGroups || [];
  const perspNames = perspectives.filter(p => p.name).map(p => p.name);
  const p1 = perspNames[0] || 'Financial';
  const p2 = perspNames[1] || 'Customer';
  const p3 = perspNames[2] || 'Internal Processes';
  const librarySeeds = Array.from(new Set(
    goalGroups
      .filter(group => group.hasLibrary)
      .flatMap(group => {
        const values = (group.segmentValues || []).map(value => String(value || '').trim()).filter(Boolean);
        return values.length > 0 ? values : [String(group.name || 'All Employees').trim()];
      })
      .filter(Boolean)
  ));
  const exampleLibraryOne = librarySeeds[0] || 'Attribute Value 1';
  const exampleLibraryTwo = librarySeeds[1] || 'Attribute Value 2';

  const headers = [
    'Library Name',
    'Perspective',
    'Perspective Weight %',
    'KRA Name',
    'KRA Description',
    'KRA Weight %',
    'KPI Name',
    'KPI Description',
    'KPI Weight %',
  ];
  const colWidths = [24, 22, 18, 30, 36, 14, 30, 36, 14];
  const n = headers.length;

  // ── Sheet 1: Libraries ──────────────────────────────────────────────────
  const ws = wb.addWorksheet('Goal Libraries', {
    views: [{ showGridLines: false, state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2' }],
    properties: { tabColor: { argb: C.BLUE_DARK } },
  });
  ws.columns = colWidths.map(w => ({ width: w }));

  // Header row
  const hRow = ws.addRow(headers);
  styleHeaderRow(hRow, n);

  // Example banner
  bannerRow(ws, n, '  ↓  Example rows — delete before uploading your data', C.RED_BANNER, C.RED_TEXT);

  // Example rows — Library 1 (KRA + KPI)
  const ex1 = [
    [exampleLibraryOne, p1, '30', 'Revenue Growth',    'Grow quarterly revenue',         '50', 'Monthly ARR',          'Monthly recurring revenue vs target', '60'],
    [exampleLibraryOne, p1, '30', 'Revenue Growth',    'Grow quarterly revenue',         '50', 'New Client Wins',      'New enterprise clients acquired',     '40'],
    [exampleLibraryOne, p2, '25', 'NPS Score',         'Net promoter score improvement', '100','Survey Response Rate', 'Quarterly NPS survey completion',     '100'],
    [exampleLibraryOne, p3, '25', 'Delivery Quality',  'On-time delivery of sprints',    '100','Sprint Velocity',      'Story points delivered per sprint',   '50'],
    [exampleLibraryOne, p3, '25', 'Delivery Quality',  'On-time delivery of sprints',    '100','Bug Escape Rate',      'Defects found in production',         '50'],
  ];
  // Example rows — Library 2 (KRA only)
  const ex2 = [
    [exampleLibraryTwo, p1, '40', 'Quota Achievement',  'Hit individual revenue targets',  '60', '', '', ''],
    [exampleLibraryTwo, p1, '40', 'Pipeline Growth',    'Expand active sales pipeline',    '40', '', '', ''],
    [exampleLibraryTwo, p2, '35', 'Customer Retention', 'Retain existing client base',     '100','', '', ''],
    [exampleLibraryTwo, p3, '25', 'Process Compliance', 'Follow sales process standards',  '100','', '', ''],
  ];

  let exRowIndex = 0;
  for (const row of [...ex1, ...ex2]) {
    const r = ws.addRow(row);
    styleExampleRow(r, n);
    exRowIndex++;
  }

  // "Your data goes here" banner
  bannerRow(ws, n, '  ↑  Delete examples above  ·  Your libraries start here  ↓', C.BLUE_FILL, C.BLUE_DARK);

  // 10 blank editable rows
  for (let i = 0; i < 10; i++) {
    const r = ws.addRow(Array(n).fill(''));
    styleDataRow(r, n, i);
  }

  // Notes section
  addNoteRows(ws, [
    ['RULES & NOTES'],
    ['• Library Name: all rows for the same library must have the exact same name in column A. Each unique name becomes a separate library card.'],
    [librarySeeds.length > 0
      ? '• In this setup, the Library Name should usually match one of your configured attribute values from Step 3.'
      : '• In this setup, the Library Name should usually match the attribute value or employee group you are building a card for.'],
    ['• Perspective Weight %: the weight of each perspective (must sum to 100 across all perspectives for that library).'],
    ['• KRA Weight %: weights for KRAs within a perspective. Must sum to 100 per perspective, per library.'],
    ['• KPI Name / KPI Weight %: optional. If you include KPIs, repeat the KRA Name & KRA Weight % on each KPI row.'],
    ['• KPI Weight %: weights for KPIs within a KRA. Must sum to 100 per KRA.'],
    ['• Leave KPI columns blank for KRA-only libraries.'],
    ['• Delete all red example rows before uploading.'],
    ['• Column headers must remain exactly as shown — do not rename or reorder them.'],
    perspNames.length > 0
      ? [`• Valid Perspectives for this org: ${perspNames.join('  |  ')}`]
      : ['• Perspective names should match what you configured in Step 2 (BSC Perspectives).'],
  ]);

  // ── Sheet 2: Reference ──────────────────────────────────────────────────
  const ref = wb.addWorksheet('Reference', {
    properties: { tabColor: { argb: 'FF64748B' } },
  });
  ref.columns = [{ width: 28 }, { width: 50 }];

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
    ['Library Name',        'A unique name for this library. All KRAs/KPIs in this library share this name.'],
    ['Perspective',         'The BSC perspective this KRA belongs to.'],
    ['Perspective Weight %','Weight of this perspective across all perspectives (must total 100).'],
    ['KRA Name',            'Key Result Area — the goal topic or theme.'],
    ['KRA Description',     'Optional: a brief description of the KRA.'],
    ['KRA Weight %',        'Weight of this KRA within its Perspective (must total 100 per perspective).'],
    ['KPI Name',            'Key Performance Indicator under this KRA. Leave blank for KRA-only libraries.'],
    ['KPI Description',     'Optional: brief description of the KPI.'],
    ['KPI Weight %',        'Weight of this KPI within its KRA (must total 100 per KRA).'],
  ]);

  if (perspNames.length > 0) {
    addRefSection('Configured Perspectives', perspNames.map(name => {
      const p = perspectives.find(x => x.name === name);
      return [name, `Weight: ${p?.weight ?? '—'}%`];
    }));
  }

  if (librarySeeds.length > 0) {
    addRefSection('Current Library Card Names', librarySeeds.map(name => [name, 'Use this exact value in the Library Name column if you are filling that card.']));
  }

  addRefSection('Common Mistakes', [
    ['KRA weights ≠ 100',    'KRA weights within a perspective must always add up to exactly 100.'],
    ['KPI weights ≠ 100',    'KPI weights within a KRA must always add up to exactly 100.'],
    ['Mixed KRA/KPI rows',   'If using KPIs, every row in that library should have a KPI (or leave all KPI columns blank for KRA-only).'],
    ['Perspective mismatch', 'Perspective names must match your BSC configuration exactly (case-sensitive).'],
    ['Library name mismatch','All rows for a library must use the exact same Library Name value.'],
  ]);

  await writeAndDownload(wb, 'zaro_goal_libraries_template.xlsx');
}

/* ── PARSE BULK GOAL LIBRARY UPLOAD ─────────────────────────────────────── */
export function parseGoalLibraryBulkXlsx(file) {
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

        const headers = (allRows[0] || []).map(h => String(h || '').trim().toLowerCase());
        const idxLibrary = headers.indexOf('library name');
        const idxPersp = headers.indexOf('perspective');
        const idxPerspWeight = headers.indexOf('perspective weight %');
        const idxKraName = headers.indexOf('kra name');
        const idxKraDesc = headers.indexOf('kra description');
        const idxKraWeight = headers.indexOf('kra weight %');
        const idxKpiName = headers.indexOf('kpi name');
        const idxKpiDesc = headers.indexOf('kpi description');
        const idxKpiWeight = headers.indexOf('kpi weight %');

        if (idxLibrary === -1 || idxPersp === -1 || idxKraName === -1) {
          reject(new Error('Missing required columns in the uploaded template'));
          return;
        }

        const librariesByName = new Map();
        let validRowCount = 0;

        const readCell = (row, index) => (index >= 0 ? String(row[index] || '').trim() : '');
        const parseWeight = (raw) => {
          const text = String(raw || '').trim();
          if (!text) return null;
          const numeric = Number(text);
          return Number.isFinite(numeric) ? numeric : null;
        };

        for (const row of allRows.slice(1)) {
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

          const libraryName = readCell(row, idxLibrary);
          const perspectiveName = readCell(row, idxPersp);
          const kraName = readCell(row, idxKraName);
          const kpiName = readCell(row, idxKpiName);

          if (!libraryName || !perspectiveName || !kraName) continue;
          validRowCount += 1;

          const perspectiveWeight = parseWeight(readCell(row, idxPerspWeight));
          const kraWeight = parseWeight(readCell(row, idxKraWeight));
          const kpiWeight = parseWeight(readCell(row, idxKpiWeight));

          const libKey = libraryName.toLowerCase();
          if (!librariesByName.has(libKey)) {
            librariesByName.set(libKey, {
              id: `lib_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              name: libraryName,
              type: 'kra-only',
              weightType: 'none',
              perspectivesMap: new Map(),
            });
          }

          const library = librariesByName.get(libKey);
          if (kpiName) library.type = 'kra-kpi';
          if (perspectiveWeight !== null || kraWeight !== null || kpiWeight !== null) {
            library.weightType = 'suggested';
          }

          const perspectiveKey = perspectiveName.toLowerCase();
          if (!library.perspectivesMap.has(perspectiveKey)) {
            library.perspectivesMap.set(perspectiveKey, {
              id: `lp_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
              name: perspectiveName,
              weight: perspectiveWeight ?? 0,
              krasMap: new Map(),
            });
          }

          const perspective = library.perspectivesMap.get(perspectiveKey);
          if (perspective.weight === 0 && perspectiveWeight !== null) {
            perspective.weight = perspectiveWeight;
          }

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
                desc: readCell(row, idxKpiDesc),
                weight: kpiWeight ?? 0,
              });
            }
          }
        }

        const libraries = Array.from(librariesByName.values()).map(library => ({
          id: library.id,
          name: library.name,
          type: library.type,
          weightType: library.weightType,
          perspectives: Array.from(library.perspectivesMap.values()).map(perspective => ({
            id: perspective.id,
            name: perspective.name,
            weight: perspective.weight,
            kras: Array.from(perspective.krasMap.values()),
          })),
        }));

        if (!validRowCount || libraries.length === 0) {
          reject(new Error('No valid library rows found in the uploaded sheet'));
          return;
        }

        resolve({ libraries, count: libraries.length });
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

        if (idxKraName === -1) { reject(new Error('Missing "KRA Name" column')); return; }

        const grouped = {};
        for (const row of dataRows) {
          const get = i => (i >= 0 ? String(row[i] || '').trim() : '');
          const attrVal  = isByAttr ? get(idxAttr) : '__common__';
          const perspName = get(idxPersp);
          const kraName  = get(idxKraName);
          const kraWt    = get(idxKraWt);
          if (!kraName) continue;

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

/* ── EMPLOYEE TEMPLATE META ──────────────────────────────────────────────── */
const STD_NORM = ['employeecode','employeename','emailid','reportingmanagercode','reportingmanagername','reportingmanageremail','l2managercode','l2managername'];

function attrAlreadyStandard(attrLabel) {
  const norm = attrLabel.toLowerCase().replace(/[^a-z]/g, '');
  return STD_NORM.some(s => s.includes(norm) || norm.includes(s));
}

export function employeeTemplateMeta(config) {
  const { goalCreationMode, goalLibraryScope, goalSegmentAttr, goalSegmentValues, goalLimitScope, goalLimitAttr, managerLevels, requireEmail, empCodeFormat } = config;
  const needsAttr =
    (goalCreationMode === 'admin-library' && goalLibraryScope === 'by-attribute') ||
    (goalCreationMode === 'employee-self'  && goalLimitScope  === 'by-attribute');
  const attrLabel  = goalCreationMode === 'admin-library' ? (goalSegmentAttr || 'Department') : (goalLimitAttr || 'Department');
  const addAttrCol = needsAttr && !attrAlreadyStandard(attrLabel);
  const hasL2      = (managerLevels || 1) >= 2;
  const needsEmail = requireEmail !== false;

  const headers = [
    'Employee Code', 'Employee Name',
    ...(needsEmail ? ['Email ID'] : []),
    ...(addAttrCol ? [attrLabel] : []),
    'Reporting Manager Code', 'Reporting Manager Name',
    ...(needsEmail ? ['Reporting Manager Email'] : []),
    ...(hasL2 ? ['L2 Manager Code', 'L2 Manager Name'] : []),
  ];
  const colWidths = [
    16, 26,
    ...(needsEmail ? [30] : []),
    ...(addAttrCol ? [18] : []),
    22, 26,
    ...(needsEmail ? [32] : []),
    ...(hasL2 ? [22, 26] : []),
  ];

  const attrValues = addAttrCol ? (goalSegmentValues || []).map(v => v.name).filter(Boolean) : [];

  const ex = (code, name, email, attr, mgr, mgrName, mgrEmail, l2Code, l2Name) => [
    code, name,
    ...(needsEmail ? [email] : []),
    ...(addAttrCol ? [attr] : []),
    mgr, mgrName,
    ...(needsEmail ? [mgrEmail] : []),
    ...(hasL2 ? [l2Code, l2Name] : []),
  ];
  // Use real attribute values in example rows so the admin sees actual valid options
  const exAttr = (i) => attrValues.length > 0 ? attrValues[i % attrValues.length] : `${attrLabel} Value ${i + 1}`;
  const exampleRows = [
    ex('EMP001','Priya Sharma',  'priya@company.com',  exAttr(0), 'MGR001','Amit Shah',  'amit@company.com',  'DIR001','Ravi Verma'),
    ex('EMP002','Rahul Mehta',   'rahul@company.com',  exAttr(1), 'MGR002','Neha Patel', 'neha@company.com',  'DIR001','Ravi Verma'),
    ex('EMP003','Sneha Iyer',    'sneha@company.com',  exAttr(2), 'MGR001','Amit Shah',  'amit@company.com',  'DIR002','Sonal Desai'),
  ];

  const fmtType = empCodeFormat?.type || 'free';
  const codeNote = fmtType === 'numeric'
    ? '• Employee Code must be numeric (digits only).'
    : fmtType === 'custom'
    ? '• Employee Code must follow the configured format — see the Employee Settings step for valid patterns.'
    : '• Employee Code must be unique. Use the same code consistently across all files.';

  const noteRows = [
    ['NOTES'],
    [codeNote],
    ['• Reporting Manager Code must match an Employee Code in this file (or an existing manager in the system). Leave blank only for top-level employees who have no manager above them.'],
    ...(hasL2 ? [['• L2 Manager Code is the skip-level manager (manager of the direct manager).']] : []),
    ...(addAttrCol ? [[`• "${attrLabel}" determines which goal set is assigned. Must exactly match values in the goal library.`]] : []),
    ...(requireEmail === false ? [['• Email ID is optional for this configuration.']] : []),
    ['• Delete the red example rows before uploading.'],
  ];

  return { headers, colWidths, exampleRows, noteRows, addAttrCol, attrLabel, hasL2, needsEmail, attrValues };
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
    ...(meta.addAttrCol ? [[meta.attrLabel, `Determines which goal set is assigned to this employee. Must exactly match one of the valid values listed in the "${meta.attrLabel} Values" section below. Leave blank for top-level or manager-only employees who will not have a KRA set assigned.`]] : []),
    ['Reporting Manager Code', 'Employee Code of the direct reporting manager. Must match an Employee Code in this file. Leave blank if this employee is at the top of the hierarchy (no manager above them).'],
    ['Reporting Manager Name', 'Full name of the reporting manager (display only — code is the key). Leave blank if Reporting Manager Code is blank.'],
    ...(meta.needsEmail ? [['Reporting Manager Email', 'Work email of the reporting manager. Used for manager summary emails.']] : []),
    ...(meta.hasL2 ? [
      ['L2 Manager Code', 'Employee Code of the skip-level manager (manager\'s manager). Optional — leave blank if the employee has no L2 reviewer.'],
      ['L2 Manager Name', 'Full name of the L2 manager (display only). Leave blank if L2 Manager Code is blank.'],
    ] : []),
  ];
  refSection('Column Guide', colGuide);

  // Valid attribute values (if goal library is segmented)
  if (meta.addAttrCol && meta.attrValues.length > 0) {
    refSection(`Valid ${meta.attrLabel} Values`, meta.attrValues.map(v => [v, `Use exactly this value in the "${meta.attrLabel}" column.`]));
  }

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
    goalCreationMode, goalLibraryScope, goalSegmentAttr, goalSegmentValues,
    goalLimitScope, goalLimitAttr,
  } = config;

  const regex = buildEmpCodeRegex(empCodeFormat);
  const hasL2 = (managerLevels || 1) >= 2;
  const emailRequired = requireEmail !== false;

  // Attribute column — only present when goal library is segmented by attribute
  const needsAttr =
    (goalCreationMode === 'admin-library' && goalLibraryScope === 'by-attribute') ||
    (goalCreationMode === 'employee-self'  && goalLimitScope  === 'by-attribute');
  const attrLabel = goalCreationMode === 'admin-library'
    ? (goalSegmentAttr || 'Department')
    : (goalLimitAttr   || 'Department');
  const validAttrValues = needsAttr
    ? (goalSegmentValues || []).map(v => v.name).filter(Boolean)
    : [];
  const validAttrSet = new Set(validAttrValues.map(v => v.toLowerCase()));

  const seenCodes = new Set();
  const allCodes = new Set(
    employees.map(e => (e['Employee Code'] || '').trim().toLowerCase()).filter(Boolean)
  );

  employees.forEach((emp, idx) => {
    const row = idx + 2; // 1-based, +1 for header row
    const code = (emp['Employee Code'] || '').trim();
    const name = (emp['Employee Name'] || '').trim();

    // Employee Code
    if (!code) {
      errors.push({ row, code: '—', field: 'emp_code', message: 'Employee Code is missing' });
    } else {
      if (seenCodes.has(code.toLowerCase())) {
        errors.push({ row, code, field: 'emp_code', message: `Duplicate Employee Code "${code}"` });
      }
      seenCodes.add(code.toLowerCase());
      if (regex && !regex.test(code)) {
        errors.push({ row, code, field: 'emp_code', message: `Employee Code "${code}" is invalid — must be numeric digits only` });
      }
    }

    // Employee Name
    if (!name) {
      errors.push({ row, code: code || '—', field: 'emp_name', message: 'Employee Name is missing' });
    }

    // Email
    if (emailRequired && !(emp['Email ID'] || '').trim()) {
      errors.push({ row, code: code || '—', field: 'email', message: 'Email ID is missing' });
    }

    // Attribute value (blank = no KRA set assigned, allowed for top-level/manager-only employees)
    if (needsAttr) {
      const attrVal = (emp[attrLabel] || '').trim();
      if (!attrVal) {
        warnings.push({ row, code: code || '—', field: 'attr', category: 'no_designation',
          message: `"${attrLabel}" is blank — this employee will not have a KRA set assigned (acceptable for top-level or manager-only employees)` });
      } else if (validAttrSet.size > 0 && !validAttrSet.has(attrVal.toLowerCase())) {
        errors.push({ row, code: code || '—', field: 'attr', message: `"${attrVal}" is not a valid ${attrLabel}. Valid values: ${validAttrValues.join(', ')}` });
      }
    }

    // Reporting Manager (blank = top of hierarchy, allowed)
    const l1Code = (emp['Reporting Manager Code'] || '').trim();
    if (l1Code && !allCodes.has(l1Code.toLowerCase())) {
      warnings.push({ row, code: code || '—', field: 'l1_manager', category: 'manager_not_in_file',
        message: `Manager "${l1Code}" is not in this file — ensure they already exist in the system` });
    }

    // L2 Manager (optional per employee)
    if (hasL2) {
      const l2Code = (emp['L2 Manager Code'] || '').trim();
      if (!l2Code) {
        warnings.push({ row, code: code || '—', field: 'l2_manager', category: 'l2_missing',
          message: 'No L2 manager — this employee will go through L1 review only' });
      }
    }
  });

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
  const perspectives = (config.perspectives || []).map(p => p.name).filter(Boolean);
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

      // KRA perspective missing
      if (!kra.perspName || !String(kra.perspName).trim()) {
        errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'perspective', message: `KRA "${kra.name}" has no perspective` });
      } else if (perspectives.length > 0) {
        // Perspective doesn't match configured perspectives
        const perspLower = String(kra.perspName).trim().toLowerCase();
        const matched = perspectives.some(p => p.toLowerCase() === perspLower);
        if (!matched) {
          errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'perspective', message: `"${kra.perspName}" does not match any configured perspective` });
        }
      }

      // KRA weight missing or not a number
      const kraWeightValue = String(kra.weight ?? '').trim();
      const wt = parseFloat(kraWeightValue);
      if (!kraWeightValue || !numericPattern.test(kraWeightValue) || Number.isNaN(wt)) {
        errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kra_weight', message: `KRA "${kra.name}" weight must be a non-negative numeric value` });
      } else if (wt < 0) {
        errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kra_weight', message: `KRA "${kra.name}" weight cannot be negative` });
      } else {
        totalWeight += wt;
      }

      // KPI total weight
      if (hasKpis && kra.kpis && kra.kpis.length > 0) {
        const seenKpiNames = {};
        let kpiTotal = 0;
        for (const kpi of kra.kpis) {
          const kpiName = normalizeName(kpi.name);
          const kpiWeightValue = String(kpi.weight ?? '').trim();
          const kpiWeight = parseFloat(kpiWeightValue);
          if (!kpiName) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kpi_name', message: `KPI in "${kra.name}" has no name` });
          } else {
            const kpiNameKey = kpiName.toLowerCase();
            if (seenKpiNames[kpiNameKey]) {
              errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName, field: 'kpi_name', message: `Duplicate KPI name "${kpiName}" in "${kra.name}"` });
            } else {
              seenKpiNames[kpiNameKey] = true;
            }
          }

          if (!kpiWeightValue || !numericPattern.test(kpiWeightValue) || Number.isNaN(kpiWeight)) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName || null, field: 'kpi_weight', message: `KPI weight in "${kra.name}" must be a non-negative numeric value` });
            continue;
          }
          if (kpiWeight < 0) {
            errors.push({ group: groupLabel, kraName: kra.name, kpiName: kpiName || null, field: 'kpi_weight', message: `KPI weight in "${kra.name}" cannot be negative` });
            continue;
          }
          kpiTotal += kpiWeight;
        }
        if (!Number.isNaN(wt) && Math.abs(kpiTotal - wt) > 0.5) {
          errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kpi_weight', message: `KPI weights for "${kra.name}" sum to ${kpiTotal.toFixed(1)}%, expected ${wt.toFixed(1)}% (the KRA weight)` });
        }
      }
    }

    // Total KRA weight
    if (kras.length > 0 && Math.abs(totalWeight - 100) > 0.5) {
      errors.push({ group: groupLabel, kraName: null, kpiName: null, field: 'weight', message: `KRA weights in "${groupLabel}" sum to ${totalWeight.toFixed(1)}%, expected 100%` });
    }
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
