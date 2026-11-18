/**
 * Finanzas Laburo — lectura y generación de fichas ETAF en formato Word (.docx).
 *
 * Opera en memoria sobre los bytes del archivo (ZIP + word/document.xml) usando
 * DecompressionStream, DOMParser y XMLSerializer. Sin estado propio, sin red ni DOM
 * de la página.
 */
window.FLDocx = (function () {
  'use strict';

  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const XML_NS = 'http://www.w3.org/XML/1998/namespace';

  // ─── CRC32 + ZIP (mismo enfoque que sheets.js, sin compartir código) ───
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function toUint8(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new Error('Se esperaba Uint8Array o ArrayBuffer');
  }

  async function leerZip(rawBytes) {
    const bytes = toUint8(rawBytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const dec = new TextDecoder('utf-8');

    let eocd = -1;
    const minPos = Math.max(0, bytes.length - 65557);
    for (let pos = bytes.length - 22; pos >= minPos; pos--) {
      if (view.getUint32(pos, true) === 0x06054B50) {
        const commentLen = view.getUint16(pos + 20, true);
        if (pos + 22 + commentLen === bytes.length) {
          eocd = pos;
          break;
        }
      }
    }
    if (eocd === -1) throw new Error('No se encontró el directorio ZIP');

    const totalEntries = view.getUint16(eocd + 10, true);
    let cdOffset = view.getUint32(eocd + 16, true);
    const files = new Map();

    for (let i = 0; i < totalEntries; i++) {
      if (cdOffset + 46 > bytes.length || view.getUint32(cdOffset, true) !== 0x02014B50) {
        throw new Error('Directorio central ZIP inválido');
      }
      const method = view.getUint16(cdOffset + 10, true);
      const compSize = view.getUint32(cdOffset + 20, true);
      const nameLen = view.getUint16(cdOffset + 28, true);
      const extraLen = view.getUint16(cdOffset + 30, true);
      const commentLen = view.getUint16(cdOffset + 32, true);
      const localOffset = view.getUint32(cdOffset + 42, true);

      const name = dec.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen));
      cdOffset += 46 + nameLen + extraLen + commentLen;

      if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034B50) {
        throw new Error('Cabecera local ZIP inválida');
      }
      const localNameLen = view.getUint16(localOffset + 26, true);
      const localExtraLen = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLen + localExtraLen;
      const compSlice = bytes.subarray(dataStart, dataStart + compSize);

      let outBytes;
      if (method === 0) {
        outBytes = new Uint8Array(compSlice);
      } else if (method === 8) {
        const stream = new Blob([compSlice]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        outBytes = new Uint8Array(buf);
      } else {
        throw new Error('Método ZIP no soportado: ' + method);
      }
      files.set(name, outBytes);
    }

    return files;
  }

  function armarZip(map) {
    const enc = new TextEncoder();
    const ordered = [];
    if (map.has('[Content_Types].xml')) {
      ordered.push(['[Content_Types].xml', map.get('[Content_Types].xml')]);
    }
    for (const [name, data] of map.entries()) {
      if (name === '[Content_Types].xml') continue;
      ordered.push([name, data]);
    }

    const parts = [];
    const central = [];
    let offset = 0;

    for (const [rawName, rawData] of ordered) {
      const name = enc.encode(rawName);
      const data = toUint8(rawData);
      const crc = crc32(data);

      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8
      lv.setUint16(8, 0, true);      // método 0 = stored
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
      cv.setUint16(8, 0x0800, true);
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
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    });
  }

  // ─── Helpers XML WordprocessingML ──────────────────────────
  function directChildren(el, localName) {
    const out = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.localName === localName && n.namespaceURI === W_NS) {
        out.push(n);
      }
    }
    return out;
  }

  function firstDirectChild(el, localName) {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.localName === localName && n.namespaceURI === W_NS) {
        return n;
      }
    }
    return null;
  }

  function pText(p) {
    const ts = p.getElementsByTagNameNS(W_NS, 't');
    let out = '';
    for (let i = 0; i < ts.length; i++) out += ts[i].textContent || '';
    return out;
  }

  function pTextWithBr(p) {
    let out = '';
    const walk = (node) => {
      for (let n = node.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 1) continue;
        if (n.namespaceURI === W_NS && (n.localName === 'br' || n.localName === 'cr')) {
          out += '\n';
        } else if (n.namespaceURI === W_NS && n.localName === 't') {
          out += n.textContent || '';
        } else {
          walk(n);
        }
      }
    };
    walk(p);
    return out;
  }

  function buildRPr(doc, baseRPr, forceUnbold, highlightYellow) {
    let rPr = baseRPr ? baseRPr.cloneNode(true) : null;
    if (!rPr && (forceUnbold || highlightYellow)) {
      rPr = doc.createElementNS(W_NS, 'w:rPr');
    }
    if (!rPr) return null;

    if (forceUnbold) {
      for (const bTag of ['b', 'bCs']) {
        let bEl = firstDirectChild(rPr, bTag);
        if (!bEl) {
          bEl = doc.createElementNS(W_NS, 'w:' + bTag);
          rPr.appendChild(bEl);
        }
        bEl.setAttributeNS(W_NS, 'w:val', '0');
      }
    }

    if (highlightYellow) {
      let hi = firstDirectChild(rPr, 'highlight');
      if (!hi) {
        hi = doc.createElementNS(W_NS, 'w:highlight');
        rPr.appendChild(hi);
      }
      hi.setAttributeNS(W_NS, 'w:val', 'yellow');
    }

    return rPr;
  }

  function appendRunsWithHighlight(doc, p, baseRPr, text, forceUnbold) {
    const parts = String(text ?? '').split(/(\[[^\]]+\])/g);
    for (const part of parts) {
      if (!part) continue;
      const isHighlight = part.length >= 2 && part[0] === '[' && part[part.length - 1] === ']';
      const r = doc.createElementNS(W_NS, 'w:r');
      const rPr = buildRPr(doc, baseRPr, forceUnbold, isHighlight);
      if (rPr) r.appendChild(rPr);
      const t = doc.createElementNS(W_NS, 'w:t');
      t.setAttributeNS(XML_NS, 'xml:space', 'preserve');
      t.appendChild(doc.createTextNode(part));
      r.appendChild(t);
      p.appendChild(r);
    }
  }

  function findBaseRPr(p, preferLast) {
    const runs = directChildren(p, 'r');
    if (preferLast) {
      for (let i = runs.length - 1; i >= 0; i--) {
        if (runs[i].getElementsByTagNameNS(W_NS, 't').length > 0) {
          const rPr = firstDirectChild(runs[i], 'rPr');
          if (rPr) return rPr.cloneNode(true);
        }
      }
    } else {
      for (let i = 0; i < runs.length; i++) {
        if (runs[i].getElementsByTagNameNS(W_NS, 't').length > 0) {
          const rPr = firstDirectChild(runs[i], 'rPr');
          if (rPr) return rPr.cloneNode(true);
        }
      }
    }
    const pPr = firstDirectChild(p, 'pPr');
    const pRPr = pPr ? firstDirectChild(pPr, 'rPr') : null;
    if (pRPr) return pRPr.cloneNode(true);
    if (runs.length) {
      const rPr = firstDirectChild(runs[preferLast ? runs.length - 1 : 0], 'rPr');
      if (rPr) return rPr.cloneNode(true);
    }
    return null;
  }

  function clearRuns(p) {
    for (const r of directChildren(p, 'r')) {
      p.removeChild(r);
    }
  }

  function setCell(doc, tc, texto) {
    const ps = directChildren(tc, 'p');
    let firstP = ps[0];
    if (!firstP) {
      firstP = doc.createElementNS(W_NS, 'w:p');
      tc.appendChild(firstP);
    }
    const baseRPr = findBaseRPr(firstP, false);
    const pPr = firstDirectChild(firstP, 'pPr');

    for (let i = 1; i < ps.length; i++) {
      tc.removeChild(ps[i]);
    }
    clearRuns(firstP);

    const str = String(texto ?? '');
    if (!str) return;

    const lines = str.split('\n');
    appendRunsWithHighlight(doc, firstP, baseRPr, lines[0], false);

    for (let i = 1; i < lines.length; i++) {
      const np = doc.createElementNS(W_NS, 'w:p');
      if (pPr) np.appendChild(pPr.cloneNode(true));
      if (lines[i]) {
        appendRunsWithHighlight(doc, np, baseRPr, lines[i], false);
      }
      tc.appendChild(np);
    }
  }

  function fillLabel(doc, container, rotulo, valor) {
    const ps = directChildren(container, 'p');
    const target = ps.find((p) => pText(p).replace(/^\s+/, '').startsWith(rotulo));
    if (!target) {
      throw new Error('No se encontró el rótulo: ' + rotulo);
    }

    const str = String(valor ?? '');
    if (!str) return;

    const baseRPr = findBaseRPr(target, true);
    const pPr = firstDirectChild(target, 'pPr');
    const lines = str.split('\n');

    appendRunsWithHighlight(doc, target, baseRPr, ' ' + lines[0], true);

    let anchor = target;
    for (let i = 1; i < lines.length; i++) {
      const np = doc.createElementNS(W_NS, 'w:p');
      if (pPr) np.appendChild(pPr.cloneNode(true));
      if (lines[i]) {
        appendRunsWithHighlight(doc, np, baseRPr, lines[i], true);
      }
      container.insertBefore(np, anchor.nextSibling);
      anchor = np;
    }
  }

  function fillGridTable(doc, tbl, items, keys) {
    let rows = directChildren(tbl, 'tr');
    const needed = items.length + 1;
    while (rows.length < needed) {
      const clone = rows[rows.length - 1].cloneNode(true);
      tbl.appendChild(clone);
      rows = directChildren(tbl, 'tr');
    }
    for (let r = 1; r < rows.length; r++) {
      const tcs = directChildren(rows[r], 'tc');
      const item = items[r - 1] || null;
      for (let c = 0; c < keys.length && c < tcs.length; c++) {
        const val = item ? (item[keys[c]] || '') : '';
        setCell(doc, tcs[c], val);
      }
    }
  }

  // ─── Llenar ficha ──────────────────────────────────────────
  async function llenarFicha(plantillaBytes, datos) {
    const map = await leerZip(plantillaBytes);
    const docBytes = map.get('word/document.xml');
    if (!docBytes) throw new Error('Plantilla sin word/document.xml');

    const xmlStr = new TextDecoder('utf-8').decode(docBytes);
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('XML de plantilla inválido');
    }

    const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
    if (!body) throw new Error('Plantilla sin w:body');
    const tables = directChildren(body, 'tbl');
    if (tables.length < 8) throw new Error('La plantilla no tiene las 8 tablas esperadas');

    // T1: Núcleo familiar actual
    fillGridTable(
      doc,
      tables[1],
      Array.isArray(datos.nucleo) ? datos.nucleo : [],
      ['nombre', 'vinculo', 'ci', 'nacimiento', 'credencial', 'sipi', 'ingresos']
    );

    // T2: Contacto
    const contacto = datos.contacto || {};
    const t2Cell = directChildren(directChildren(tables[2], 'tr')[0], 'tc')[0];
    fillLabel(doc, t2Cell, 'Dirección/ Barrio:', contacto.direccion || '');
    fillLabel(doc, t2Cell, 'Teléfono de contacto:', contacto.telefono || '');
    fillLabel(doc, t2Cell, 'Centro de Salud:', contacto.salud || '');
    fillLabel(doc, t2Cell, 'Centros Educativos:', contacto.educativos || '');
    fillLabel(doc, t2Cell, 'Dupla Referente:', contacto.dupla || '');

    // T3: Ingreso al sistema 24 h
    fillGridTable(
      doc,
      tables[3],
      Array.isArray(datos.ingreso) ? datos.ingreso : [],
      ['nombre', 'ci', 'sipi', 'fechaInau', 'fechaCentro', 'motivo', 'juzgado']
    );

    // T4: Contexto familiar
    const ctx = datos.contexto || {};
    const t4Rows = directChildren(tables[4], 'tr');
    const acogText = ctx.acogimiento === 'SI'
      ? 'Marcado: SI'
      : (ctx.acogimiento === 'NO' ? 'Marcado: NO' : '');
    const t4Spec = [
      ['Permanece en Centro (Si, No):', ctx.permanece || ''],
      ['Fecha de inicio del Contexto', ctx.inicioContexto || ''],
      ['Fecha inicio intervención ETAF CAFF:', ctx.inicioEtaf || ''],
      ['Acogimiento Familiar:', acogText],
      ['En caso de tener AF:', ctx.af || ''],
      ['Tenencia (Si, No, En Trámite):', ctx.tenencia || ''],
      ['Instituciones vinculadas al Núcleo Familiar:', ctx.instituciones || ''],
      ['Aspectos salientes al momento de la derivación:', ctx.salientesDerivacion || '']
    ];
    for (let r = 0; r < t4Spec.length; r++) {
      const cell = directChildren(t4Rows[r], 'tc')[0];
      fillLabel(doc, cell, t4Spec[r][0], t4Spec[r][1]);
    }

    // T6: Período y Aspectos salientes del mes
    const t6Rows = directChildren(tables[6], 'tr');
    const t6Cell0 = directChildren(t6Rows[0], 'tc')[0];
    const periodoP = directChildren(t6Cell0, 'p').find((p) => pText(p).includes('Período de registro'));
    if (!periodoP) throw new Error('No se encontró Período de registro');
    const periodoRPr = findBaseRPr(periodoP, false);
    clearRuns(periodoP);
    appendRunsWithHighlight(doc, periodoP, periodoRPr, 'Período de registro: ' + (datos.periodo || ''), false);

    const t6Cell1 = directChildren(t6Rows[1], 'tc')[0];
    fillLabel(doc, t6Cell1, 'Aspectos salientes de la intervención', datos.salientes || '');

    // T7: Líneas (filas 1..7, celdas 1..3) + Observaciones (fila 8, celda 1)
    const t7Rows = directChildren(tables[7], 'tr');
    const lineasDatos = Array.isArray(datos.lineas) ? datos.lineas : [];
    for (let i = 0; i < 7; i++) {
      const rowTcs = directChildren(t7Rows[i + 1], 'tc');
      const vals = lineasDatos[i] || ['', '', ''];
      setCell(doc, rowTcs[1], vals[0] || '');
      setCell(doc, rowTcs[2], vals[1] || '');
      setCell(doc, rowTcs[3], vals[2] || '');
    }
    const obsRowTcs = directChildren(t7Rows[8], 'tc');
    setCell(doc, obsRowTcs[1], datos.observaciones || '');

    // «Fecha:» (párrafo directo de w:body)
    fillLabel(doc, body, 'Fecha:', datos.fecha || '');

    const outXml = new XMLSerializer().serializeToString(doc);
    map.set('word/document.xml', new TextEncoder().encode(outXml));
    return armarZip(map);
  }

  // ─── Leer ficha anterior ───────────────────────────────────
  function cellPlainText(tc) {
    return directChildren(tc, 'p')
      .map((p) => pTextWithBr(p))
      .join('\n')
      .trim();
  }

  function cleanMultilineField(lines) {
    const trimmed = lines.map((l) => l.trim());
    while (trimmed.length && !trimmed[0]) trimmed.shift();
    while (trimmed.length && !trimmed[trimmed.length - 1]) trimmed.pop();
    return trimmed.filter((l, idx) => l !== '' || (idx > 0 && trimmed[idx - 1] !== '')).join('\n');
  }

  async function leerFicha(rawBytes) {
    const map = await leerZip(rawBytes);
    const docBytes = map.get('word/document.xml');
    if (!docBytes) throw new Error('Archivo sin word/document.xml');

    const xmlStr = new TextDecoder('utf-8').decode(docBytes);
    const doc = new DOMParser().parseFromString(xmlStr, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
      throw new Error('XML inválido');
    }

    const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
    if (!body) throw new Error('Documento sin cuerpo');
    const tables = directChildren(body, 'tbl');
    if (tables.length < 8) {
      throw new Error('No tiene las tablas de una ficha ETAF');
    }

    const t1Rows = directChildren(tables[1], 'tr');
    const t1Header0 = t1Rows.length ? cellPlainText(directChildren(t1Rows[0], 'tc')[0]) : '';
    if (!t1Header0.startsWith('Nombres y Apellidos')) {
      throw new Error('La tabla 1 no corresponde a una ficha ETAF');
    }

    // T1: Núcleo
    const nucleo = [];
    for (let r = 1; r < t1Rows.length; r++) {
      const tcs = directChildren(t1Rows[r], 'tc');
      const nombre = tcs[0] ? cellPlainText(tcs[0]) : '';
      if (!nombre) continue;
      nucleo.push({
        nombre,
        vinculo: tcs[1] ? cellPlainText(tcs[1]) : '',
        ci: tcs[2] ? cellPlainText(tcs[2]) : '',
        nacimiento: tcs[3] ? cellPlainText(tcs[3]) : '',
        credencial: tcs[4] ? cellPlainText(tcs[4]) : '',
        sipi: tcs[5] ? cellPlainText(tcs[5]) : '',
        ingresos: tcs[6] ? cellPlainText(tcs[6]) : ''
      });
    }

    // T2: Contacto
    const t2Labels = [
      ['Dirección/ Barrio:', 'direccion'],
      ['Teléfono de contacto:', 'telefono'],
      ['Centro de Salud:', 'salud'],
      ['Centros Educativos:', 'educativos'],
      ['Dupla Referente:', 'dupla']
    ];
    const t2Buckets = { direccion: [], telefono: [], salud: [], educativos: [], dupla: [] };
    const t2Cell = directChildren(directChildren(tables[2], 'tr')[0], 'tc')[0];
    let currentKey = null;
    for (const p of directChildren(t2Cell, 'p')) {
      const lines = pTextWithBr(p).split('\n');
      for (const rawLine of lines) {
        const lineTrimStart = rawLine.replace(/^\s+/, '');
        const matched = t2Labels.find(([rot]) => lineTrimStart.startsWith(rot));
        if (matched) {
          currentKey = matched[1];
          const rest = lineTrimStart.slice(matched[0].length).trim();
          if (rest) t2Buckets[currentKey].push(rest);
        } else if (currentKey) {
          const t = rawLine.trim();
          if (t) t2Buckets[currentKey].push(t);
        }
      }
    }
    const contacto = {
      direccion: t2Buckets.direccion.join('\n'),
      telefono: t2Buckets.telefono.join('\n'),
      salud: t2Buckets.salud.join('\n'),
      educativos: t2Buckets.educativos.join('\n'),
      dupla: t2Buckets.dupla.join('\n')
    };

    // T3: Ingreso
    const t3Rows = directChildren(tables[3], 'tr');
    const ingreso = [];
    for (let r = 1; r < t3Rows.length; r++) {
      const tcs = directChildren(t3Rows[r], 'tc');
      const nombre = tcs[0] ? cellPlainText(tcs[0]) : '';
      if (!nombre) continue;
      ingreso.push({
        nombre,
        ci: tcs[1] ? cellPlainText(tcs[1]) : '',
        sipi: tcs[2] ? cellPlainText(tcs[2]) : '',
        fechaInau: tcs[3] ? cellPlainText(tcs[3]) : '',
        fechaCentro: tcs[4] ? cellPlainText(tcs[4]) : '',
        motivo: tcs[5] ? cellPlainText(tcs[5]) : '',
        juzgado: tcs[6] ? cellPlainText(tcs[6]) : ''
      });
    }

    // T4: Contexto
    const t4Rows = directChildren(tables[4], 'tr');
    const t4Rotulos = [
      ['Permanece en Centro (Si, No):', 'permanece'],
      ['Fecha de inicio del Contexto', 'inicioContexto'],
      ['Fecha inicio intervención ETAF CAFF:', 'inicioEtaf'],
      ['Acogimiento Familiar:', 'acogimiento'],
      ['En caso de tener AF:', 'af'],
      ['Tenencia (Si, No, En Trámite):', 'tenencia'],
      ['Instituciones vinculadas al Núcleo Familiar:', 'instituciones'],
      ['Aspectos salientes al momento de la derivación:', 'salientesDerivacion']
    ];
    const restosPlantilla = [
      '(salida del Centro residencial y/o Caff a  la familia:',
      '(salida del Centro residencial y/o Caff a la familia:',
      'Modalidad:',
      'Titular/ Proyecto:',
      'Fecha Convenio:'
    ];
    const contexto = {};
    for (let r = 0; r < t4Rotulos.length; r++) {
      const [rotulo, key] = t4Rotulos[r];
      const cell = directChildren(t4Rows[r], 'tc')[0];
      const rawLines = directChildren(cell, 'p')
        .map((p) => pTextWithBr(p))
        .join('\n')
        .split('\n');

      let strippedRot = false;
      const cleaned = [];
      for (let line of rawLines) {
        if (!strippedRot) {
          const ts = line.replace(/^\s+/, '');
          if (ts.startsWith(rotulo)) {
            line = ts.slice(rotulo.length);
            if (key === 'inicioContexto' && line.startsWith(':')) {
              line = line.slice(1);
            }
            strippedRot = true;
          }
        }
        for (const resto of restosPlantilla) {
          if (line.includes(resto)) line = line.split(resto).join('');
        }
        cleaned.push(line);
      }

      if (key === 'acogimiento') {
        const joined = cleaned.join(' ').trim();
        if (joined.includes('Marcado: SI') || (joined.endsWith('SI') && !joined.includes('NO'))) {
          contexto.acogimiento = 'SI';
        } else if (joined.includes('Marcado: NO')) {
          contexto.acogimiento = 'NO';
        } else {
          contexto.acogimiento = '';
        }
      } else {
        contexto[key] = cleanMultilineField(cleaned);
      }
    }

    return { nucleo, contacto, ingreso, contexto };
  }

  return { leerZip, armarZip, llenarFicha, leerFicha };
})();
