// Minimal XLSX writer for report exports: inline strings, real numbers, one
// bold header style and right-to-left sheets. No formulas are ever written,
// so a cell that starts with "=" stays text. Built on node:zlib to avoid a
// spreadsheet dependency for what is a write-only, table-shaped output.
import { crc32, deflateRawSync } from "node:zlib";

export type XlsxCell = string | number | boolean | null | undefined;
export type XlsxSheet = { name: string; rows: XlsxCell[][]; headerRows?: number[] };

const xml = (s: string) =>
  s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

function column(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function cell(ref: string, value: XlsxCell, style: string) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${ref}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(String(value))}</t></is></c>`;
}

function worksheet(sheet: XlsxSheet) {
  const headers = new Set(sheet.headerRows ?? []);
  const rows = sheet.rows.map((row, r) => {
    const style = headers.has(r) ? ' s="1"' : "";
    return `<row r="${r + 1}">${row.map((v, c) => cell(column(c) + (r + 1), v, style)).join("")}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>${rows ? `<sheetData>${rows}</sheetData>` : "<sheetData/>"}</worksheet>`;
}

// Excel sheet names: at most 31 characters, none of []:*?/\ and unique.
function sheetNames(names: string[]) {
  const used = new Set<string>();
  return names.map((raw, i) => {
    const base = raw.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || `Sheet${i + 1}`;
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = base.slice(0, 31 - String(n).length - 1) + "_" + n;
    used.add(name.toLowerCase());
    return name;
  });
}

const STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

export function buildXlsx(sheets: XlsxSheet[]): Buffer {
  if (!sheets.length) throw new Error("A workbook needs at least one sheet");
  const names = sheetNames(sheets.map((s) => s.name));
  const ns = "http://schemas.openxmlformats.org";
  const files: [string, string][] = [
    ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${ns}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`],
    ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${ns}/spreadsheetml/2006/main" xmlns:r="${ns}/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${ns}/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", STYLES],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, worksheet(s)] as [string, string]),
  ];
  return zip(files);
}

// ZIP container (deflate, no encryption, no zip64): enough for report sizes.
function zip(files: [string, string][]): Buffer {
  const DOS_DATE = 0x21; // 1980-01-01; a fixed stamp keeps identical reports byte-identical.
  const locals: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBytes = Buffer.from(name, "utf8"), data = Buffer.from(text, "utf8");
    const packed = deflateRawSync(data), crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(0, 12); entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
