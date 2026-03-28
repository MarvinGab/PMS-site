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

  const ex = (code, name, email, attr, mgr, mgrName, mgrEmail, l2Code, l2Name) => [
    code, name,
    ...(needsEmail ? [email] : []),
    ...(addAttrCol ? [attr] : []),
    mgr, mgrName,
    ...(needsEmail ? [mgrEmail] : []),
    ...(hasL2 ? [l2Code, l2Name] : []),
  ];
  const exampleRows = [
    ex('EMP001','Priya Sharma',  'priya@company.com',  'Finance',     'MGR001','Amit Shah',  'amit@company.com',  'DIR001','Ravi Verma'),
    ex('EMP002','Rahul Mehta',   'rahul@company.com',  'Engineering', 'MGR002','Neha Patel', 'neha@company.com',  'DIR001','Ravi Verma'),
    ex('EMP003','Sneha Iyer',    'sneha@company.com',  'HR',          'MGR001','Amit Shah',  'amit@company.com',  'DIR002','Sonal Desai'),
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
    ['• Reporting Manager Code must match an Employee Code in this file (or an existing manager in the system).'],
    ...(hasL2 ? [['• L2 Manager Code is the skip-level manager (manager of the direct manager).']] : []),
    ...(addAttrCol ? [[`• "${attrLabel}" determines which goal set is assigned. Must exactly match values in the goal library.`]] : []),
    ...(requireEmail === false ? [['• Email ID is optional for this configuration.']] : []),
    ['• Delete the red example rows before uploading.'],
  ];

  const attrValues = addAttrCol ? (goalSegmentValues || []).map(v => v.name).filter(Boolean) : [];

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
    ...(meta.addAttrCol ? [[meta.attrLabel, `Determines which goal set is assigned to this employee. Must exactly match one of the valid values listed in the "${meta.attrLabel} Values" section below.`]] : []),
    ['Reporting Manager Code', 'Employee Code of the direct reporting manager. Must match an Employee Code in this file.'],
    ['Reporting Manager Name', 'Full name of the reporting manager (display only — code is the key).'],
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
  const { empCodeFormat, managerLevels, requireEmail } = config;
  const regex = buildEmpCodeRegex(empCodeFormat);
  const hasL2 = (managerLevels || 1) >= 2;
  const emailRequired = requireEmail !== false;

  const seenCodes = new Set();
  const allCodes = new Set(
    employees.map(e => (e['Employee Code'] || '').trim().toLowerCase()).filter(Boolean)
  );

  employees.forEach((emp, idx) => {
    const row = idx + 2; // 1-based, +1 for header row
    const code = (emp['Employee Code'] || '').trim();
    const name = (emp['Employee Name'] || '').trim();

    if (!code) {
      errors.push({ row, code: '—', field: 'emp_code', message: 'Employee Code is missing' });
    } else {
      if (seenCodes.has(code.toLowerCase())) {
        errors.push({ row, code, field: 'emp_code', message: `Duplicate Employee Code "${code}"` });
      }
      seenCodes.add(code.toLowerCase());
      if (regex && !regex.test(code)) {
        errors.push({ row, code, field: 'emp_code', message: `Code "${code}" doesn't match the required format` });
      }
    }

    if (!name) {
      errors.push({ row, code: code || '—', field: 'emp_name', message: 'Employee Name is missing' });
    }

    if (emailRequired && !(emp['Email ID'] || '').trim()) {
      errors.push({ row, code: code || '—', field: 'email', message: 'Email ID is missing' });
    }

    const l1Code = (emp['Reporting Manager Code'] || '').trim();
    if (!l1Code) {
      errors.push({ row, code: code || '—', field: 'l1_manager', message: 'Reporting Manager Code is missing' });
    } else if (!allCodes.has(l1Code.toLowerCase())) {
      warnings.push({ row, code: code || '—', field: 'l1_manager', message: `L1 Manager "${l1Code}" not found in this file` });
    }

    if (hasL2) {
      const l2Code = (emp['L2 Manager Code'] || '').trim();
      if (!l2Code) {
        // L2 is optional per employee — blank means L1-only review for this person
        warnings.push({ row, code: code || '—', field: 'l2_manager', message: 'No L2 manager — this employee will go through L1 review only' });
      }
    }
  });

  return { errors, warnings };
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
        if (Math.abs(kpiTotal - 100) > 0.5) {
          errors.push({ group: groupLabel, kraName: kra.name, kpiName: null, field: 'kpi_weight', message: `KPI weights for "${kra.name}" sum to ${kpiTotal.toFixed(1)}%, expected 100%` });
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
