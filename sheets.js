/**
 * Finanzas Laburo — generador de las dos planillas del equipo.
 *
 *   1. Rendición de caja: FECHA | CONCEPTO | SIPI | INGRESO | EGRESO | SALDO
 *   2. SIRC:              FECHA: | FAMILIA: | SIPI: | GASTO:   (solo egresos)
 *
 * Arma el .xlsx a mano (zip + XML, sin comprimir) para no depender de ninguna
 * librería y seguir andando offline. Google Sheets abre el archivo tal cual.
 */
window.FLSheets = (function () {
  'use strict';

  // ─── ZIP sin compresión ────────────────────────────────────
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const name = enc.encode(f.name);
      const data = enc.encode(f.data);
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);   // método 0 = stored
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);

      parts.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);

      offset += local.length + data.length;
    }

    let cdSize = 0;
    for (const c of central) cdSize += c.length;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);

    return new Blob([...parts, ...central, end], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  // ─── Helpers XML ───────────────────────────────────────────
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  /** Fecha ISO → número de serie de Excel (base 1899-12-30). */
  function serial(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function colName(i) {
    let s = '';
    let n = i;
    while (n >= 0) {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    }
    return s;
  }

  /**
   * Celda: v=valor, s=estilo, t='n'|'s'|'f' (número, texto, fórmula).
   * En las fórmulas va también el resultado ya calculado (`cached`), si no los
   * visores que no recalculan —la vista previa de Drive, por ejemplo— muestran vacío.
   */
  function cell(ref, v, s, t, cached) {
    if (v === '' || v === null || v === undefined) return `<c r="${ref}" s="${s}"/>`;
    if (t === 's') return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    if (t === 'f') {
      const val = (cached === undefined || cached === null || cached === '') ? '' : `<v>${cached}</v>`;
      return `<c r="${ref}" s="${s}"><f>${esc(v)}</f>${val}</c>`;
    }
    return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
  }

  // ─── styles.xml ────────────────────────────────────────────
  // numFmt 164 = moneda "$ #,##0.00" · 165 = número con dos decimales · 14 = dd/mm/aaaa
  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2">
<numFmt numFmtId="164" formatCode="_-&quot;$&quot;\\ * #,##0.00_-;\\-&quot;$&quot;\\ * #,##0.00_-;_-&quot;$&quot;\\ * &quot;-&quot;??_-;_-@"/>
<numFmt numFmtId="165" formatCode="_-* #,##0.00_-;\\-* #,##0.00_-;_-* &quot;-&quot;??_-;_-@"/>
</numFmts>
<fonts count="3">
<font><sz val="11.0"/><color rgb="FF000000"/><name val="Calibri"/></font>
<font><b/><sz val="11.0"/><color rgb="FF000000"/><name val="Calibri"/></font>
<font><sz val="11.0"/><color rgb="FFFF0000"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="lightGray"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFBE4D5"/><bgColor rgb="FFFBE4D5"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor rgb="FFFF0000"/></patternFill></fill>
</fills>
<borders count="11">
<border/>
<border><left style="medium"/><right style="medium"/><top style="medium"/><bottom style="medium"/></border>
<border><left style="medium"/><top style="medium"/><bottom style="medium"/></border>
<border><top style="medium"/><bottom style="medium"/></border>
<border><right style="medium"/><top style="medium"/><bottom style="medium"/></border>
<border><left style="medium"/><right style="medium"/></border>
<border><left style="medium"/></border>
<border><right style="medium"/></border>
<border><left style="medium"/><right style="medium"/><bottom style="medium"/></border>
<border><left style="medium"/><bottom style="medium"/></border>
<border><right style="medium"/><bottom style="medium"/></border>
</borders>
<cellStyleXfs count="1"><xf borderId="0" fillId="0" fontId="0" numFmtId="0"/></cellStyleXfs>
<cellXfs count="20">
<xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0"/>
<xf borderId="1" fillId="0" fontId="0" numFmtId="0" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf borderId="2" fillId="2" fontId="1" numFmtId="0" xfId="0" applyBorder="1" applyFill="1" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf borderId="3" fillId="2" fontId="1" numFmtId="0" xfId="0" applyBorder="1" applyFill="1" applyFont="1"/>
<xf borderId="4" fillId="2" fontId="1" numFmtId="0" xfId="0" applyBorder="1" applyFill="1" applyFont="1"/>
<xf borderId="0" fillId="0" fontId="0" numFmtId="0" xfId="0"/>
<xf borderId="1" fillId="0" fontId="1" numFmtId="0" xfId="0" applyBorder="1" applyFont="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf borderId="5" fillId="0" fontId="0" numFmtId="14" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf borderId="6" fillId="0" fontId="0" numFmtId="0" xfId="0" applyBorder="1"/>
<xf borderId="7" fillId="0" fontId="0" numFmtId="0" xfId="0" applyBorder="1"/>
<xf borderId="6" fillId="0" fontId="0" numFmtId="164" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="7" fillId="0" fontId="0" numFmtId="164" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="5" fillId="0" fontId="0" numFmtId="165" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="8" fillId="0" fontId="0" numFmtId="14" xfId="0" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center"/></xf>
<xf borderId="9" fillId="0" fontId="0" numFmtId="0" xfId="0" applyBorder="1"/>
<xf borderId="10" fillId="0" fontId="0" numFmtId="0" xfId="0" applyBorder="1"/>
<xf borderId="9" fillId="0" fontId="0" numFmtId="164" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="10" fillId="0" fontId="0" numFmtId="164" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="8" fillId="0" fontId="0" numFmtId="165" xfId="0" applyBorder="1" applyNumberFormat="1"/>
<xf borderId="1" fillId="3" fontId="1" numFmtId="164" xfId="0" applyBorder="1" applyFill="1" applyFont="1" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;

  // Índices de estilo, por nombre, para que las funciones de abajo se lean.
  const S = {
    titleLeft: 1, titleFill: 2, titleFillMid: 3, titleFillEnd: 4, outside: 5,
    header: 6,
    date: 7, textL: 8, textR: 9, moneyL: 10, moneyR: 11, saldo: 12,
    dateB: 13, textLB: 14, textRB: 15, moneyLB: 16, moneyRB: 17, saldoB: 18,
    saldoFinal: 19
  };

  function bookFiles(sheetXml) {
    return [
      {
        name: '[Content_Types].xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`
      },
      {
        name: '_rels/.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
      },
      {
        name: 'xl/workbook.xml',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
      },
      { name: 'xl/styles.xml', data: STYLES },
      { name: 'xl/worksheets/sheet1.xml', data: sheetXml }
    ];
  }

  function sheetWrap(cols, merges, rows) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetFormatPr customHeight="1" defaultColWidth="12.63" defaultRowHeight="15.0"/>
<cols>${cols}</cols>
<sheetData>${rows}</sheetData>
<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>
</worksheet>`;
  }

  function row(n, cells) {
    return `<row r="${n}">${cells.join('')}</row>`;
  }

  // ─── Planilla 1: rendición de caja ─────────────────────────
  /**
   * @param {{monthLabel:string, technician:string, rows:Array}} data
   *   rows: { date, concept, sipi, income, expense }
   */
  function buildCaja(data) {
    const LAST = 100;          // hasta dónde llega el marco, igual que la original
    const FINAL = LAST + 1;    // fila del SALDO FINAL
    const out = [];

    out.push(row(1, [
      cell('A1', 'CAJA DE : ' + data.monthLabel, S.titleLeft, 's'),
      cell('B1', 'NOMBRE DEL TÉCNICO: ' + (data.technician || ''), S.titleFill, 's'),
      cell('C1', '', S.titleFillMid), cell('D1', '', S.titleFillMid),
      cell('E1', '', S.titleFillMid), cell('F1', '', S.titleFillEnd)
    ]));

    out.push(row(2, ['FECHA', 'CONCEPTO', 'SIPI', 'INGRESO', 'EGRESO', 'SALDO']
      .map((h, i) => cell(colName(i) + '2', h, S.header, 's'))));

    let saldo = 0;
    for (let r = 3; r <= LAST; r++) {
      const d = data.rows[r - 3];
      const last = r === LAST;
      const st = last
        ? { date: S.dateB, tl: S.textLB, tr: S.textRB, ml: S.moneyLB, mr: S.moneyRB, sa: S.saldoB }
        : { date: S.date, tl: S.textL, tr: S.textR, ml: S.moneyL, mr: S.moneyR, sa: S.saldo };
      // El saldo es fórmula, igual que en la planilla original.
      const f = r === 3 ? '+D3-E3' : `+F${r - 1}+D${r}-E${r}`;
      saldo = Math.round((saldo + (Number(d && d.income) || 0) - (Number(d && d.expense) || 0)) * 100) / 100;
      out.push(row(r, [
        cell('A' + r, d && d.date ? serial(d.date) : '', st.date),
        cell('B' + r, d ? d.concept : '', st.tl, 's'),
        cell('C' + r, d && d.sipi ? d.sipi : '', st.tr, d && d.sipi ? 'n' : undefined),
        cell('D' + r, d && d.income ? d.income : '', st.ml),
        cell('E' + r, d && d.expense ? d.expense : '', st.mr),
        cell('F' + r, f, st.sa, 'f', saldo)
      ]));
    }

    const lastDate = data.rows.length ? data.rows[data.rows.length - 1].date : null;
    out.push(row(FINAL, [
      cell('A' + FINAL, lastDate ? serial(lastDate) : '', S.titleLeft),
      cell('B' + FINAL, 'SALDO FINAL', S.header, 's'),
      cell('C' + FINAL, '', S.header), cell('D' + FINAL, '', S.header), cell('E' + FINAL, '', S.header),
      cell('F' + FINAL, '+F' + LAST, S.saldoFinal, 'f', saldo)
    ]));

    const cols = '<col customWidth="1" min="1" max="6" width="15.63"/>'
      + '<col customWidth="1" min="7" max="11" width="10.75"/>'
      + '<col customWidth="1" min="12" max="26" width="14.38"/>';
    return zip(bookFiles(sheetWrap(cols, ['B1:F1', `B${FINAL}:E${FINAL}`], out.join(''))));
  }

  // ─── Planilla 2: SIRC ──────────────────────────────────────
  /** rows: { date, family, sipi, amount } — solo egresos, sin ingresos ni saldo. */
  function buildSirc(data) {
    const LAST = 96;
    const FINAL = LAST + 1;
    const out = [];

    out.push(row(1, [
      cell('A1', 'CAJA DE : ' + data.monthLabel, S.titleLeft, 's'),
      cell('B1', 'NOMBRE DEL TÉCNICO: ' + (data.technician || ''), S.titleFill, 's'),
      cell('C1', '', S.titleFillMid), cell('D1', '', S.titleFillEnd)
    ]));

    out.push(row(2, ['FECHA:', 'FAMILIA: ', 'SIPI:', 'GASTO:']
      .map((h, i) => cell(colName(i) + '2', h, S.header, 's'))));

    for (let r = 3; r <= LAST; r++) {
      const d = data.rows[r - 3];
      const last = r === LAST;
      const st = last
        ? { date: S.dateB, tl: S.textLB, tr: S.textRB, mr: S.moneyRB }
        : { date: S.date, tl: S.textL, tr: S.textR, mr: S.moneyR };
      out.push(row(r, [
        cell('A' + r, d && d.date ? serial(d.date) : '', st.date),
        cell('B' + r, d ? d.family : '', st.tl, 's'),
        cell('C' + r, d && d.sipi ? d.sipi : '', st.tr, d && d.sipi ? 'n' : undefined),
        cell('D' + r, d ? d.amount : '', st.mr)
      ]));
    }

    const lastDate = data.rows.length ? data.rows[data.rows.length - 1].date : null;
    out.push(row(FINAL, [
      cell('A' + FINAL, lastDate ? serial(lastDate) : '', S.titleLeft),
      cell('B' + FINAL, 'SALDO FINAL', S.header, 's'),
      cell('C' + FINAL, '', S.header), cell('D' + FINAL, '', S.header)
    ]));

    const cols = '<col customWidth="1" min="1" max="4" width="15.63"/>'
      + '<col customWidth="1" min="5" max="9" width="10.75"/>'
      + '<col customWidth="1" min="10" max="24" width="14.38"/>';
    return zip(bookFiles(sheetWrap(cols, ['B1:D1', `B${FINAL}:D${FINAL}`], out.join(''))));
  }

  return { buildCaja, buildSirc };
})();
