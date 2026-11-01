// Builds minimal .xlsx files (deflated zip parts, shared strings) for tests.
const zlib = require("node:zlib");

function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const entries = Object.entries(files);
  for (const [name, content] of entries) {
    const data = Buffer.from(content, "utf8");
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// rows: arrays of strings (stored as shared strings, or as rich-text runs when given an array)
// and numbers (stored as numeric cells).
function xlsx(rows) {
  const strings = [];
  const cells = rows.map((row, r) =>
    row
      .map((v, c) => {
        const ref = String.fromCharCode(65 + c) + (r + 1);
        if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
        const si = Array.isArray(v)
          ? v.map((t) => `<r><rPr><color rgb="FF000000"/></rPr><t xml:space="preserve">${esc(t)}</t></r>`).join("")
          : `<t>${esc(v)}</t>`;
        strings.push(`<si>${si}</si>`);
        return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
      })
      .join("")
  );
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return zip({
    "[Content_Types].xml": '<?xml version="1.0"?><Types/>',
    "xl/workbook.xml": `<?xml version="1.0"?><workbook ${ns}><sheets><sheet name="Subtitles" sheetId="1"/></sheets></workbook>`,
    "xl/sharedStrings.xml": `<?xml version="1.0"?><sst ${ns}>${strings.join("")}</sst>`,
    "xl/worksheets/sheet1.xml":
      `<?xml version="1.0"?><worksheet ${ns}><cols><col min="1" max="4" width="50"/></cols><sheetData>` +
      cells.map((c, i) => `<row r="${i + 1}">${c}</row>`).join("") +
      "</sheetData></worksheet>",
  });
}

module.exports = { zip, xlsx };
