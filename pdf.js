/**
 * Finanzas Laburo — generador de PDF para imprimir.
 *
 * Arma el PDF a mano (sin librerías, como el xlsx) porque el archivo es el
 * entregable: se manda a imprimir a otro lado y eso es lo que se rinde.
 * A diferencia del xlsx, Chrome SÍ deja compartir application/pdf, así que
 * este sale por el menú del celular.
 *
 * Todo el archivo se construye en ASCII —los acentos van escapados en octal—
 * para que un byte sea un carácter y los offsets de la xref cierren.
 */
window.FLPdf = (function () {
  'use strict';

  const PAGE_W = 595.28;   // A4 vertical, en puntos
  const PAGE_H = 841.89;
  const MARGIN = 40;
  const ROW_H = 16;
  const FONT_SIZE = 8.5;
  const HEAD_SIZE = 8.5;

  // Anchos de Helvetica (/1000) para lo único que hay que medir: números y fechas.
  const W = { d: 556, '.': 278, ',': 278, '/': 278, '$': 556, '-': 333, ' ': 278, ':': 278 };

  function textWidth(s, size) {
    let u = 0;
    for (const ch of String(s)) {
      if (ch >= '0' && ch <= '9') u += W.d;
      else u += (W[ch] !== undefined ? W[ch] : 500);
    }
    return (u / 1000) * size;
  }

  /** Latin-1 con escapes octales: deja el archivo en ASCII puro. */
  function esc(s) {
    let out = '';
    for (const ch of String(s ?? '')) {
      const c = ch.codePointAt(0);
      if (ch === '\\') out += '\\\\';
      else if (ch === '(') out += '\\(';
      else if (ch === ')') out += '\\)';
      else if (c === 0x2212 || c === 0x2013 || c === 0x2014) out += '-';  // menos y rayas
      else if (c === 0x00A0) out += ' ';
      else if (c < 32) out += ' ';
      else if (c < 127) out += ch;
      else if (c <= 255) out += '\\' + c.toString(8).padStart(3, '0');
      else out += '?';   // fuera de Latin-1
    }
    return out;
  }

  /** Recorta el texto que no entra en su columna. */
  function fit(s, maxW, size) {
    let t = String(s ?? '');
    if (textWidth(t, size) <= maxW) return t;
    while (t.length > 1 && textWidth(t + '..', size) > maxW) t = t.slice(0, -1);
    return t + '..';
  }

  const ops = [];
  function op(s) { ops.push(s); }

  function drawText(x, y, s, size, bold) {
    op(`BT /${bold ? 'F2' : 'F1'} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${esc(s)}) Tj ET`);
  }

  function drawTextRight(xRight, y, s, size, bold) {
    drawText(xRight - textWidth(s, size), y, s, size, bold);
  }

  function drawTextCenter(xCenter, y, s, size, bold) {
    drawText(xCenter - textWidth(s, size) / 2, y, s, size, bold);
  }

  function line(x1, y1, x2, y2, width) {
    op(`${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  function fillRect(x, y, w, h, r, g, b) {
    op(`${r} ${g} ${b} rg ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f 0 0 0 rg`);
  }

  /**
   * @param {{title, technician, headers, cols, aligns, rows, footer}} doc
   *   cols   anchos de columna en puntos (deben sumar el ancho útil)
   *   aligns 'l' | 'r' | 'c' por columna
   *   rows   array de arrays de strings ya formateados
   *   footer { label, value } opcional, en rojo como en la planilla
   */
  function build(doc) {
    ops.length = 0;
    const cols = doc.cols;
    const usable = cols.reduce((a, b) => a + b, 0);
    const x0 = MARGIN;
    const pages = [];

    // Cuántas filas entran por página, dejando lugar al encabezado y al pie.
    const topFirst = PAGE_H - MARGIN - 46;
    const bottom = MARGIN + 30;
    const perPage = Math.floor((topFirst - bottom) / ROW_H) - 1;

    let idx = 0;
    let pageNum = 0;
    while (idx < doc.rows.length || pageNum === 0) {
      pageNum++;
      const chunk = doc.rows.slice(idx, idx + perPage);
      idx += perPage;
      const esUltima = idx >= doc.rows.length;

      let y = PAGE_H - MARGIN;

      // Título y técnico (solo en la primera hoja)
      if (pageNum === 1) {
        drawText(x0, y - 12, doc.title, 13, true);
        y -= 26;
        if (doc.technician) {
          drawText(x0, y - 10, 'NOMBRE DEL TECNICO: ' + doc.technician, 9, false);
        }
        y -= 22;
      } else {
        drawText(x0, y - 10, doc.title + '  (hoja ' + pageNum + ')', 10, true);
        y -= 24;
      }

      // Encabezado con el mismo durazno de la planilla
      const headY = y - ROW_H;
      fillRect(x0, headY, usable, ROW_H, 0.984, 0.894, 0.835);
      let cx = x0;
      doc.headers.forEach((h, i) => {
        drawTextCenter(cx + cols[i] / 2, headY + 5, h, HEAD_SIZE, true);
        cx += cols[i];
      });
      line(x0, headY, x0 + usable, headY, 1.2);
      line(x0, headY + ROW_H, x0 + usable, headY + ROW_H, 1.2);

      // Filas
      let ry = headY;
      for (const row of chunk) {
        ry -= ROW_H;
        cx = x0;
        row.forEach((cell, i) => {
          const a = (doc.aligns && doc.aligns[i]) || 'l';
          const txt = fit(cell, cols[i] - 8, FONT_SIZE);
          if (a === 'r') drawTextRight(cx + cols[i] - 4, ry + 5, txt, FONT_SIZE, false);
          else if (a === 'c') drawTextCenter(cx + cols[i] / 2, ry + 5, txt, FONT_SIZE, false);
          else drawText(cx + 4, ry + 5, txt, FONT_SIZE, false);
          cx += cols[i];
        });
        line(x0, ry, x0 + usable, ry, 0.4);
      }

      // Pie con el total, en rojo, como el SALDO FINAL de la planilla
      if (esUltima && doc.footer) {
        ry -= ROW_H;
        line(x0, ry + ROW_H, x0 + usable, ry + ROW_H, 1.2);
        drawText(x0 + 4, ry + 5, doc.footer.label, FONT_SIZE, true);
        op('0.8 0 0 rg');
        drawTextRight(x0 + usable - 4, ry + 5, doc.footer.value, FONT_SIZE, true);
        op('0 0 0 rg');
      }

      // Marco de la tabla
      line(x0, ry, x0, headY + ROW_H, 1.2);
      line(x0 + usable, ry, x0 + usable, headY + ROW_H, 1.2);
      line(x0, ry, x0 + usable, ry, 1.2);

      pages.push(ops.join('\n'));
      ops.length = 0;
      if (esUltima) break;
    }

    return assemble(pages);
  }

  /** Cose los objetos del PDF y calcula la tabla xref. */
  function assemble(pageStreams) {
    const n = pageStreams.length;
    const objs = [];
    const kids = [];
    for (let i = 0; i < n; i++) kids.push(`${4 + i * 2} 0 R`);

    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    const boldNum = 4 + n * 2;
    objs[boldNum] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';

    for (let i = 0; i < n; i++) {
      const pageNum = 4 + i * 2;
      const contNum = pageNum + 1;
      objs[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] `
        + `/Resources << /Font << /F1 3 0 R /F2 ${boldNum} 0 R >> >> /Contents ${contNum} 0 R >>`;
      objs[contNum] = `<< /Length ${pageStreams[i].length} >>\nstream\n${pageStreams[i]}\nendstream`;
    }

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    const total = objs.length - 1;
    for (let i = 1; i <= total; i++) {
      offsets[i] = pdf.length;
      pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) {
      pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    }
    pdf += `trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;

    // El contenido es ASCII puro, así que un carácter = un byte y la xref cierra.
    const bytes = new Uint8Array(pdf.length);
    for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xFF;
    return new Blob([bytes], { type: 'application/pdf' });
  }

  return { build };
})();
