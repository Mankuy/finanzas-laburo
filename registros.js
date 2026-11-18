/**
 * Finanzas Laburo — pestaña Fichas (Fase 1b).
 *
 * Registros de texto por familia y exportación mensual (un .txt por familia)
 * con bloque legible + JSON delimitado para importar y recuperar en otro celular.
 * Almacenamiento separado en localStorage['etaf_registros_v1'], sin red.
 */
window.FLRegistros = (function () {
  'use strict';

  const REG_KEY = 'etaf_registros_v1';
  const REG_VERSION = 1;
  const APP_TAG = 'finanzas-laburo v3.2';
  const DELIM = '=====ETAF-JSON-v1=====';
  const DIAS_AVISO = 7;

  // Orden = filas 1 a 7 de la tabla «Líneas de Abordaje» de la ficha. No reordenar.
  const LINEAS = [
    { id: 'familia',    corto: 'Vivir en familia',             ficha: 'DERECHO A VIVIR EN FAMILIA' },
    { id: 'identidad',  corto: 'Identidad',                    ficha: 'DERECHO A LA IDENTIDAD' },
    { id: 'salud',      corto: 'Salud',                        ficha: 'DERECHO A LA SALUD' },
    { id: 'educacion',  corto: 'Educación',                    ficha: 'DERECHO A LA EDUCACION' },
    { id: 'recreacion', corto: 'Recreación',                   ficha: 'DERECHO A LA RECREACION Y CULTURA' },
    { id: 'habitat',    corto: 'Hábitat',                      ficha: 'DERECHO A UN HABITAT DIGNO' },
    { id: 'trabajo',    corto: 'Trabajo y protección social',  ficha: 'DERECHO AL TRABAJO Y LA PROTECCION SOCIAL' }
  ];

  const TIPOS = [
    { id: 'visita',       label: 'Visita / encuentro' },
    { id: 'llamada',      label: 'Llamada / mensaje' },
    { id: 'gestion',      label: 'Gestión / trámite' },
    { id: 'coordinacion', label: 'Coordinación con institución' },
    { id: 'valoracion',   label: 'Valoración técnica' },
    { id: 'dato',         label: 'Cambio de datos de la familia' },
    { id: 'otro',         label: 'Otro' },
    { id: 'saliente',     label: 'Aspecto saliente del mes' },
    { id: 'observacion',  label: 'Observación' }
  ];

  const MESES_CORTO = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Set', 'Oct', 'Nov', 'Dic'];
  const NO_LINEA_TIPOS = new Set(['saliente', 'observacion']);
  const TIPO_IDS = new Set(TIPOS.map((t) => t.id));
  const LINEA_IDS = LINEAS.map((l) => l.id);

  let api = null;
  let regState = defaultRegState();
  let regCorrupt = false;
  let activeFilter = 'all';
  let initialized = false;
  let plantillaCache = null;

  let draftTimer = null;
  let lastDraftSaveMs = 0;
  let pendingDraft = null;

  function defaultRegState() {
    return {
      version: REG_VERSION,
      registros: [],
      recordatorios: [],
      fichaBase: {},
      cierresMes: {},
      exports: {},
      pendiente: {},
      ultimaFamiliaId: null,
      borrador: null
    };
  }

  // ─── Helpers ───────────────────────────────────────────────
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function slug(s) {
    return String(s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function validTipo(t) {
    return TIPO_IDS.has(t) ? t : 'otro';
  }

  function tipoLabel(id) {
    return (TIPOS.find((t) => t.id === id) || TIPOS[TIPOS.length - 1]).label;
  }

  function normalizeLineas(arr) {
    const set = new Set(Array.isArray(arr) ? arr : []);
    return LINEA_IDS.filter((id) => set.has(id));
  }

  function activeFamilies() {
    const list = api ? (api.getState().families || []) : [];
    return list.filter((f) => f && f.id !== 'fam-misc' && f.active !== false);
  }

  function familyDisplayName(familyId) {
    const f = api && familyId ? api.familyById(familyId) : null;
    if (f) return f.name;
    return 'Familia borrada (' + String(familyId || '').slice(0, 6) + ')';
  }

  function monthNameLower(mes) {
    const parts = String(mes || '').split('-').map(Number);
    if (parts.length !== 2 || !parts[0] || !parts[1]) return '';
    return new Date(parts[0], parts[1] - 1, 1)
      .toLocaleDateString('es-UY', { month: 'long' })
      .toLowerCase();
  }

  function mesDisplay(mes) {
    const parts = String(mes || '').split('-').map(Number);
    if (parts.length === 2 && parts[0] && parts[1] && api) {
      return api.monthLabel(parts[0], parts[1] - 1);
    }
    return String(mes || '');
  }

  function formatDDMM(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1);
  }

  function formatFechaHoraLocal(d) {
    return (
      pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes())
    );
  }

  function tomorrowISO() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  // ─── Persistencia ──────────────────────────────────────────
  function loadReg() {
    let raw = null;
    try {
      raw = localStorage.getItem(REG_KEY);
    } catch {
      regCorrupt = true;
      regState = defaultRegState();
      if (api) api.toast('No se pudieron leer los registros');
      return false;
    }

    if (!raw) {
      regCorrupt = false;
      regState = defaultRegState();
      return true;
    }

    try {
      const p = JSON.parse(raw);
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        throw new Error('Formato inválido');
      }
      regCorrupt = false;
      const rawRecs = Array.isArray(p.recordatorios) ? p.recordatorios : [];
      const cutoff = Date.now() - 60 * 86400000;
      const cleanRecs = rawRecs.filter((r) => {
        if (!r || !r.hecho) return Boolean(r);
        const ts = Date.parse(r.updatedAt);
        return !Number.isFinite(ts) || ts >= cutoff;
      });
      const fichaBaseRaw = p.fichaBase && typeof p.fichaBase === 'object' && !Array.isArray(p.fichaBase) ? p.fichaBase : {};
      let migratedAf = false;
      for (const fb of Object.values(fichaBaseRaw)) {
        if (fb && fb.contexto && typeof fb.contexto === 'object' && !Array.isArray(fb.contexto)) {
          const cx = fb.contexto;
          if (typeof cx.af === 'string' && cx.af.trim() && !String(cx.afModalidad || '').trim()) {
            cx.afModalidad = cx.af;
          }
          if ('af' in cx) {
            delete cx.af;
            migratedAf = true;
          }
          cx.afModalidad = String(cx.afModalidad || '');
          cx.afTitular = String(cx.afTitular || '');
          cx.afConvenio = String(cx.afConvenio || '');
        }
      }
      regState = {
        version: REG_VERSION,
        registros: Array.isArray(p.registros) ? p.registros : [],
        recordatorios: cleanRecs,
        fichaBase: fichaBaseRaw,
        cierresMes: p.cierresMes && typeof p.cierresMes === 'object' && !Array.isArray(p.cierresMes) ? p.cierresMes : {},
        exports: p.exports && typeof p.exports === 'object' && !Array.isArray(p.exports) ? p.exports : {},
        pendiente: p.pendiente && typeof p.pendiente === 'object' && !Array.isArray(p.pendiente) ? p.pendiente : {},
        ultimaFamiliaId: typeof p.ultimaFamiliaId === 'string' ? p.ultimaFamiliaId : null,
        borrador: p.borrador && typeof p.borrador === 'object' && !Array.isArray(p.borrador) ? p.borrador : null
      };
      if (cleanRecs.length !== rawRecs.length || migratedAf) saveReg();
      return true;
    } catch {
      // No se pisa la clave para no destruir datos que el usuario pueda recuperar.
      regCorrupt = true;
      regState = defaultRegState();
      if (api) api.toast('No se pudieron leer los registros');
      return false;
    }
  }

  function saveReg() {
    if (regCorrupt) return false;
    try {
      localStorage.setItem(REG_KEY, JSON.stringify(regState));
      return true;
    } catch {
      if (api) api.toast('No se pudo guardar: el celular está sin espacio');
      return false;
    }
  }

  // ─── Pendientes y avisos ───────────────────────────────────
  function marcarPendiente(mes, familyId) {
    if (!mes || !familyId) return;
    const k = mes + '|' + familyId;
    if (!regState.pendiente[k]) {
      regState.pendiente[k] = new Date().toISOString();
    }
  }

  function avisoPendienteMasViejo() {
    if (regCorrupt) return null;
    const now = Date.now();
    let oldest = null;
    for (const [k, iso] of Object.entries(regState.pendiente)) {
      const ts = Date.parse(iso);
      if (!Number.isFinite(ts)) continue;
      const dias = Math.floor((now - ts) / 86400000);
      if (dias <= DIAS_AVISO) continue;
      const sep = k.indexOf('|');
      if (sep === -1) continue;
      const mes = k.slice(0, sep);
      const familyId = k.slice(sep + 1);
      if (!/^\d{4}-\d{2}$/.test(mes) || !familyId) continue;
      if (!oldest || ts < oldest.ts) {
        oldest = {
          key: k,
          ts,
          mes,
          familyId,
          dias,
          nombre: familyDisplayName(familyId),
          mesNombre: monthNameLower(mes)
        };
      }
    }
    return oldest;
  }

  // ─── Borrador ──────────────────────────────────────────────
  function clearDraftTimer() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    pendingDraft = null;
  }

  function flushDraftNow() {
    if (draftTimer) {
      clearTimeout(draftTimer);
      draftTimer = null;
    }
    if (!pendingDraft || regCorrupt) return;
    regState.borrador = pendingDraft;
    pendingDraft = null;
    lastDraftSaveMs = Date.now();
    saveReg();
  }

  function scheduleDraftSave(draft) {
    if (regCorrupt) return;
    pendingDraft = draft;
    const elapsed = Date.now() - lastDraftSaveMs;
    if (draftTimer) return;
    if (elapsed >= 500) {
      flushDraftNow();
    } else {
      draftTimer = setTimeout(flushDraftNow, 500 - elapsed);
    }
  }

  // ─── CRUD registros ────────────────────────────────────────
  function upsertRegistro(data, existingId = null) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return false;
    }

    const fam = data && data.familyId ? api.familyById(data.familyId) : null;
    if (!fam || fam.id === 'fam-misc') {
      api.toast('Elegí una familia');
      return false;
    }

    const fecha = String(data.fecha || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      api.toast('Falta la fecha');
      return false;
    }

    const tipo = validTipo(data.tipo);
    const sinLinea = NO_LINEA_TIPOS.has(tipo);
    const noConcretada = (!sinLinea && (tipo === 'visita' || tipo === 'llamada')) ? Boolean(data.noConcretada) : false;
    const lineas = sinLinea ? [] : normalizeLineas(data.lineas);
    const texto = String(data.texto || '').trim().slice(0, 4000);

    if (!texto) {
      api.toast('Escribí algo');
      return false;
    }

    const snapshot = JSON.stringify(regState);
    const now = new Date().toISOString();
    const newMes = fecha.slice(0, 7);

    if (existingId) {
      const idx = regState.registros.findIndex((r) => r.id === existingId);
      if (idx === -1) return false;
      const prev = regState.registros[idx];
      const oldMes = String(prev.fecha || '').slice(0, 7);
      const oldFam = prev.familyId;

      regState.registros[idx] = {
        id: prev.id,
        familyId: fam.id,
        fecha,
        tipo,
        noConcretada,
        lineas,
        texto,
        adjuntos: Array.isArray(prev.adjuntos) ? prev.adjuntos : [],
        createdAt: prev.createdAt || now,
        updatedAt: now
      };

      if (oldMes !== newMes || oldFam !== fam.id) {
        marcarPendiente(oldMes, oldFam);
      }
      marcarPendiente(newMes, fam.id);
    } else {
      clearDraftTimer();
      const nuevo = {
        id: api.uid(),
        familyId: fam.id,
        fecha,
        tipo,
        noConcretada,
        lineas,
        texto,
        adjuntos: [],
        createdAt: now,
        updatedAt: now
      };
      regState.registros.unshift(nuevo);
      marcarPendiente(newMes, fam.id);
      regState.borrador = null;
    }

    regState.ultimaFamiliaId = fam.id;

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return false;
    }

    render();
    const aviso = avisoPendienteMasViejo();
    const base = existingId ? 'Registro actualizado' : 'Guardado';
    api.toast(aviso ? `${base} · hace ${aviso.dias} días que no exportás` : base);
    return true;
  }

  function deleteRegistro(id) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return false;
    }
    const reg = regState.registros.find((r) => r.id === id);
    if (!reg) return false;
    if (!confirm('¿Borrar este registro?')) return false;

    const snapshot = JSON.stringify(regState);
    regState.registros = regState.registros.filter((r) => r.id !== id);
    marcarPendiente(String(reg.fecha || '').slice(0, 7), reg.familyId);

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return false;
    }

    render();
    api.toast('Borrado');
    return true;
  }

  // ─── Recordatorios ─────────────────────────────────────────
  function upsertRecordatorio(data, existingId = null) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return false;
    }
    const fam = data && data.familyId ? api.familyById(data.familyId) : null;
    if (!fam || fam.id === 'fam-misc') {
      api.toast('Elegí una familia');
      return false;
    }
    const fecha = String(data.fecha || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      api.toast('Falta la fecha');
      return false;
    }
    const texto = String(data.texto || '').trim().slice(0, 500);
    if (!texto) {
      api.toast('Escribí algo');
      return false;
    }

    const snapshot = JSON.stringify(regState);
    const now = new Date().toISOString();

    if (existingId) {
      const idx = regState.recordatorios.findIndex((r) => r.id === existingId);
      if (idx === -1) return false;
      const prev = regState.recordatorios[idx];
      regState.recordatorios[idx] = {
        id: prev.id,
        familyId: fam.id,
        fecha,
        texto,
        hecho: Boolean(prev.hecho),
        createdAt: prev.createdAt || now,
        updatedAt: now
      };
    } else {
      regState.recordatorios.push({
        id: api.uid(),
        familyId: fam.id,
        fecha,
        texto,
        hecho: false,
        createdAt: now,
        updatedAt: now
      });
    }

    regState.ultimaFamiliaId = fam.id;

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return false;
    }

    render();
    api.toast(existingId ? 'Recordatorio actualizado' : 'Recordatorio guardado');
    return true;
  }

  function deleteRecordatorio(id) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return false;
    }
    const rec = regState.recordatorios.find((r) => r.id === id);
    if (!rec) return false;
    if (!confirm('¿Borrar este recordatorio?')) return false;

    const snapshot = JSON.stringify(regState);
    regState.recordatorios = regState.recordatorios.filter((r) => r.id !== id);
    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return false;
    }

    render();
    api.toast('Borrado');
    return true;
  }

  function marcarRecordatorioHecho(id) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    const rec = regState.recordatorios.find((r) => r.id === id);
    if (!rec) return;

    const snapshot = JSON.stringify(regState);
    rec.hecho = true;
    rec.updatedAt = new Date().toISOString();

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return;
    }

    render();
    if (confirm('¿Querés anotar lo que pasó como registro?')) {
      openRegistroModal(null, { familyId: rec.familyId, texto: rec.texto });
    }
  }

  function buildRecordatorioIcs(fecha, id) {
    const [y, m, d] = String(fecha).split('-').map(Number);
    const ymd = `${y}${pad2(m)}${pad2(d)}`;
    const next = new Date(y, m - 1, d + 1);
    const ymdNext = `${next.getFullYear()}${pad2(next.getMonth() + 1)}${pad2(next.getDate())}`;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const summary = 'Recordatorio ETAF — ver Fichas';
    const text = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Finanzas Laburo//Fichas//ES',
      'BEGIN:VEVENT',
      `UID:${id}@finanzas-laburo`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${ymd}`,
      `DTEND;VALUE=DATE:${ymdNext}`,
      `SUMMARY:${summary}`,
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${summary}`,
      'TRIGGER:PT9H',
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
      ''
    ].join('\r\n');
    return {
      filename: `recordatorio-etaf_${fecha}.ics`,
      text
    };
  }

  function compartirRecordatorioIcs(fecha, id) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(fecha || ''))) {
      api.toast('Falta la fecha');
      return;
    }
    const { filename, text } = buildRecordatorioIcs(fecha, id);
    const file = new File([text], filename, { type: 'text/calendar' });
    compartirArchivos([file]);
  }

  // ─── Consultas y Cierre ────────────────────────────────────
  function registrosDelMes(mes, familyId = null) {
    return regState.registros
      .filter((r) => {
        if (!String(r.fecha || '').startsWith(mes)) return false;
        if (familyId && r.familyId !== familyId) return false;
        return true;
      })
      .slice()
      .sort((a, b) =>
        ((a.fecha || '') + (a.createdAt || '')).localeCompare((b.fecha || '') + (b.createdAt || ''))
      );
  }

  function gastosDeFamiliaEnMes(mes, familyId) {
    const f = api.familyById(familyId);
    if (!f || f.id === 'fam-misc') return [];
    const moves = api.getState().movements || [];
    return moves
      .filter((m) =>
        m &&
        m.type === 'expense' &&
        !m.teamCategoryId &&
        m.familyId === familyId &&
        String(m.date || '').startsWith(mes)
      )
      .slice()
      .sort((a, b) =>
        ((a.date || '') + (a.createdAt || '')).localeCompare((b.date || '') + (b.createdAt || ''))
      );
  }

  function familiasExportables(mes) {
    const regCounts = new Map();
    for (const r of regState.registros) {
      if (!String(r.fecha || '').startsWith(mes) || !r.familyId || r.familyId === 'fam-misc') continue;
      regCounts.set(r.familyId, (regCounts.get(r.familyId) || 0) + 1);
    }

    const gastoCounts = new Map();
    for (const m of (api.getState().movements || [])) {
      if (!m || m.type !== 'expense' || m.teamCategoryId) continue;
      if (!m.familyId || m.familyId === 'fam-misc') continue;
      if (!String(m.date || '').startsWith(mes)) continue;
      if (!api.familyById(m.familyId)) continue; // no entran gastos de familias borradas
      gastoCounts.set(m.familyId, (gastoCounts.get(m.familyId) || 0) + 1);
    }

    const ids = new Set();
    for (const f of (api.getState().families || [])) {
      if (!f || f.id === 'fam-misc') continue;
      if ((regCounts.get(f.id) || 0) > 0 || (gastoCounts.get(f.id) || 0) > 0) {
        ids.add(f.id);
      }
    }
    for (const fid of regCounts.keys()) {
      if (!api.familyById(fid)) ids.add(fid);
    }

    const list = [];
    for (const familyId of ids) {
      const k = mes + '|' + familyId;
      let estado = 'sin exportar';
      if (regState.pendiente[k]) {
        estado = 'cambios sin exportar';
      } else if (regState.exports[k]) {
        estado = '✓ exportada ' + formatDDMM(regState.exports[k]);
      }
      list.push({
        familyId,
        nombre: familyDisplayName(familyId),
        nRegistros: regCounts.get(familyId) || 0,
        nGastos: gastoCounts.get(familyId) || 0,
        estado
      });
    }

    list.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    return list;
  }

  function formatRegistroLineaTxt(r) {
    const f = String(r.fecha || '');
    const ddmm = f.length >= 10 ? f.slice(8, 10) + '/' + f.slice(5, 7) : f;
    const tLabel = tipoLabel(r.tipo);
    const noConc = r.noConcretada ? ' · NO SE CONCRETÓ' : '';
    const textoSingle = String(r.texto || '').trim().replace(/\s*\n+\s*/g, ' / ') || '(sin texto)';
    const adjLen = Array.isArray(r.adjuntos) ? r.adjuntos.length : 0;
    const adjPart = adjLen > 0 ? `  (${adjLen} ${adjLen === 1 ? 'adjunto' : 'adjuntos'})` : '';
    return `- ${ddmm} · ${tLabel}${noConc}: ${textoSingle}${adjPart}`;
  }

  function buildCierre(mes, familyId) {
    const fam = api.familyById(familyId);
    const nombre = fam ? fam.name : familyDisplayName(familyId);
    const rotulo = fam ? (fam.sheetLabel || '') : '';
    const ninos = fam && Array.isArray(fam.children)
      ? fam.children.map((c) => ({ nombre: c.name || '', sipi: c.sipi || '' }))
      : [];

    const regs = registrosDelMes(mes, familyId);
    const regsJson = regs.map((r) => ({
      id: r.id,
      fecha: r.fecha,
      tipo: validTipo(r.tipo),
      noConcretada: Boolean(r.noConcretada),
      lineas: normalizeLineas(r.lineas),
      texto: r.texto || '',
      adjuntos: Array.isArray(r.adjuntos) ? r.adjuntos : [],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt
    }));

    const gastosRaw = fam ? gastosDeFamiliaEnMes(mes, familyId) : [];
    const gastosJson = gastosRaw.map((m) => ({
      id: m.id,
      fecha: m.date,
      monto: Number(m.amount),
      que: m.what || '',
      sipis: api.expenseSipis(m),
      nota: m.note || ''
    }));

    const ahora = new Date();
    const autor = api.autor();
    const json = {
      formato: 'etaf-cierre',
      version: 1,
      mes,
      autor,
      generado: ahora.toISOString(),
      app: APP_TAG,
      familias: [
        {
          id: familyId,
          nombre,
          rotulo,
          ninos,
          registros: regsJson,
          gastos: gastosJson
        }
      ]
    };

    const [yStr, mStr] = String(mes).split('-');
    const year = Number(yStr);
    const monthIdx = Number(mStr) - 1;

    const lines = [
      `REGISTRO ETAF CAFF — ${api.monthLabel(year, monthIdx)}`,
      `Técnico/a: ${autor} · Generado: ${formatFechaHoraLocal(ahora)}`,
      'Datos sensibles de familias: no reenviar fuera del equipo.',
      ''
    ];

    const sipisFam = ninos.map((n) => String(n.sipi || '').trim()).filter(Boolean);
    const sipiHead = sipisFam.length ? ` (SIPI ${sipisFam.join(', ')})` : '';
    lines.push(`════════ ${nombre}${sipiHead} ════════`);
    lines.push('');

    for (const linea of LINEAS) {
      const matching = regsJson.filter((r) => r.lineas.includes(linea.id));
      if (!matching.length) continue;
      lines.push(`[${linea.corto}]`);
      for (const r of matching) lines.push(formatRegistroLineaTxt(r));
      lines.push('');
    }

    const sinClasificar = regsJson.filter((r) => !r.lineas.length);
    if (sinClasificar.length) {
      lines.push('[Sin clasificar]');
      for (const r of sinClasificar) lines.push(formatRegistroLineaTxt(r));
      lines.push('');
    }

    if (gastosJson.length) {
      lines.push('[Apoyos económicos del mes]');
      let suma = 0;
      for (const g of gastosJson) {
        suma += Number(g.monto) || 0;
        const f = String(g.fecha || '');
        const ddmm = f.length >= 10 ? f.slice(8, 10) + '/' + f.slice(5, 7) : f;
        lines.push(`- ${ddmm} · ${api.money(g.monto)} · ${g.que}`);
      }
      suma = Math.round(suma * 100) / 100;
      lines.push(`Total: ${api.money(suma)}`);
      lines.push('');
    }

    lines.push(DELIM);
    lines.push(JSON.stringify(json, null, 2));

    const famSlug = slug(nombre) || 'familia';
    return {
      filename: `etaf-cierre_${mes}_${famSlug}.txt`,
      text: lines.join('\n'),
      json
    };
  }

  async function compartirArchivos(files) {
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
        return 'compartido';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'cancelado';
      }
    }
    for (const file of files) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    api.toast('Quedó en Descargas del celu');
    return 'descargado';
  }

  async function exportCierre(familyId) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    if (!String(api.autor() || '').trim()) {
      api.toast('Poné tu nombre en Config');
      return;
    }
    const { year, month } = api.getView();
    const mes = api.monthKey(year, month);
    const { filename, text } = buildCierre(mes, familyId);
    const file = new File([text], filename, { type: 'text/plain' });

    const res = await compartirArchivos([file]);
    if (res !== 'cancelado') {
      const k = mes + '|' + familyId;
      regState.exports[k] = new Date().toISOString();
      delete regState.pendiente[k];
      saveReg();
      render();
    }
  }

  // ─── Recuperar y limpieza ──────────────────────────────────
  function restaurarCierre(file) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    if (!file || file.size > 5 * 1024 * 1024) {
      api.toast('Ese archivo no es una exportación de Fichas');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      let data = null;
      try {
        const raw = String(reader.result || '').replace(/\r\n?/g, '\n');
        const lines = raw.split('\n');
        const delimIdx = lines.lastIndexOf(DELIM);
        if (delimIdx === -1) throw new Error('Sin delimitador');
        const jsonStr = lines.slice(delimIdx + 1).join('\n');
        data = JSON.parse(jsonStr);
        if (!data || data.formato !== 'etaf-cierre' || !Array.isArray(data.familias)) {
          throw new Error('Formato inválido');
        }
      } catch {
        api.toast('Ese archivo no es una exportación de Fichas');
        return;
      }

      const faltan = data.familias.some((fam) => !fam || !fam.id || !api.familyById(fam.id));
      if (faltan) {
        api.toast('Hay registros de familias que no están en este celular. Importá primero el backup de Finanzas (Config) y después volvé a recuperar');
        return;
      }

      let totalRegs = 0;
      for (const fam of data.familias) {
        if (Array.isArray(fam.registros)) totalRegs += fam.registros.length;
      }

      const mesTxt = mesDisplay(data.mes);
      if (!confirm(`¿Recuperar ${totalRegs} registros de ${mesTxt}? No se borra nada de lo que ya tenés.`)) {
        return;
      }

      const snapshot = JSON.stringify(regState);
      const byId = new Map();
      regState.registros.forEach((r, idx) => byId.set(r.id, idx));

      for (const fam of data.familias) {
        const list = Array.isArray(fam.registros) ? fam.registros : [];
        for (const r of list) {
          if (!r || !r.id) continue;
          const normalized = {
            id: String(r.id),
            familyId: fam.id,
            fecha: String(r.fecha || ''),
            tipo: validTipo(r.tipo),
            noConcretada: (r.tipo === 'visita' || r.tipo === 'llamada') ? Boolean(r.noConcretada) : false,
            lineas: normalizeLineas(r.lineas),
            texto: String(r.texto || '').trim().slice(0, 4000),
            adjuntos: Array.isArray(r.adjuntos) ? r.adjuntos : [],
            createdAt: r.createdAt || new Date().toISOString(),
            updatedAt: r.updatedAt || r.createdAt || new Date().toISOString()
          };
          const existingIdx = byId.get(normalized.id);
          if (existingIdx === undefined) {
            byId.set(normalized.id, regState.registros.length);
            regState.registros.push(normalized);
          } else {
            const current = regState.registros[existingIdx];
            if (String(normalized.updatedAt) > String(current.updatedAt || '')) {
              regState.registros[existingIdx] = normalized;
            }
          }
        }

        if (data.mes && data.generado) {
          const k = data.mes + '|' + fam.id;
          if (!regState.exports[k] || String(data.generado) > String(regState.exports[k])) {
            regState.exports[k] = data.generado;
          }
        }
      }

      if (!saveReg()) {
        regState = JSON.parse(snapshot);
        return;
      }

      render();
      api.toast('Registros recuperados');
    };
    reader.readAsText(file);
  }

  function borrarMesesExportados() {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    const now = new Date();
    const mesActual = api.monthKey(now.getFullYear(), now.getMonth());

    const famsPorMes = new Map();
    const countPorMes = new Map();
    for (const r of regState.registros) {
      const mes = String(r.fecha || '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(mes) || mes >= mesActual) continue;
      if (!famsPorMes.has(mes)) famsPorMes.set(mes, new Set());
      if (r.familyId) famsPorMes.get(mes).add(r.familyId);
      countPorMes.set(mes, (countPorMes.get(mes) || 0) + 1);
    }

    const mesesListos = new Set();
    let totalRegistros = 0;
    for (const [mes, fams] of famsPorMes.entries()) {
      let ok = true;
      for (const fid of fams) {
        const k = mes + '|' + fid;
        if (!regState.exports[k] || regState.pendiente[k]) {
          ok = false;
          break;
        }
      }
      if (ok && fams.size > 0) {
        mesesListos.add(mes);
        totalRegistros += countPorMes.get(mes) || 0;
      }
    }

    if (!mesesListos.size) {
      api.toast('No hay meses anteriores listos para borrar');
      return;
    }

    if (!confirm(`¿Borrar ${totalRegistros} registro(s) de ${mesesListos.size} mes(es) ya exportado(s)?`)) {
      return;
    }

    const snapshot = JSON.stringify(regState);
    regState.registros = regState.registros.filter((r) => !mesesListos.has(String(r.fecha || '').slice(0, 7)));
    for (const k of Object.keys(regState.cierresMes)) {
      if (mesesListos.has(k.slice(0, 7))) delete regState.cierresMes[k];
    }

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return;
    }

    render();
    api.toast('Meses exportados borrados');
  }

  function borrarTodoRegistros() {
    if (!confirm('¿Borrar TODOS los registros y los datos de las fichas?')) return;
    if (!confirm('Confirmá: se borran todos los registros, recordatorios y datos de las fichas guardados en este celular.')) return;

    clearDraftTimer();
    try {
      localStorage.removeItem(REG_KEY);
    } catch (_) {}
    regCorrupt = false;
    loadReg();
    render();
    api.toast('Registros borrados');
  }

  // ─── Modal formulario ──────────────────────────────────────
  function defaultFamilyForNew(familias) {
    if (activeFilter !== 'all' && familias.some((f) => f.id === activeFilter)) {
      return activeFilter;
    }
    if (regState.ultimaFamiliaId && familias.some((f) => f.id === regState.ultimaFamiliaId)) {
      return regState.ultimaFamiliaId;
    }
    return familias[0] ? familias[0].id : '';
  }

  function readFormDraft(form) {
    const familySel = form.querySelector('select[name="familyId"]');
    const fechaInp = form.querySelector('input[name="fecha"]');
    const tipoBtn = form.querySelector('[data-reg-tipo].active');
    const noConcChk = form.querySelector('input[name="noConcretada"]');
    const lineaBtns = form.querySelectorAll('[data-reg-linea].active');
    const textoArea = form.querySelector('textarea[name="texto"]');

    const tipo = validTipo(tipoBtn ? tipoBtn.dataset.regTipo : 'visita');
    const sinLinea = NO_LINEA_TIPOS.has(tipo);
    return {
      familyId: familySel ? familySel.value : '',
      fecha: fechaInp ? fechaInp.value : '',
      tipo,
      noConcretada: (!sinLinea && (tipo === 'visita' || tipo === 'llamada')) && Boolean(noConcChk && noConcChk.checked),
      lineas: sinLinea ? [] : normalizeLineas([...lineaBtns].map((b) => b.dataset.regLinea)),
      texto: textoArea ? textoArea.value : ''
    };
  }

  function applyFormState(form, values) {
    const familySel = form.querySelector('select[name="familyId"]');
    if (familySel && values.familyId) familySel.value = values.familyId;

    const fechaInp = form.querySelector('input[name="fecha"]');
    if (fechaInp) fechaInp.value = values.fecha || '';

    const tipo = validTipo(values.tipo || 'visita');
    form.querySelectorAll('[data-reg-tipo]').forEach((b) => {
      b.classList.toggle('active', b.dataset.regTipo === tipo);
    });

    const sinLinea = NO_LINEA_TIPOS.has(tipo);
    const noConcWrap = form.querySelector('#reg-noconc-wrap');
    const noConcChk = form.querySelector('input[name="noConcretada"]');
    const showNoConc = !sinLinea && (tipo === 'visita' || tipo === 'llamada');
    if (noConcWrap) noConcWrap.classList.toggle('hidden', !showNoConc);
    if (noConcChk) noConcChk.checked = showNoConc ? Boolean(values.noConcretada) : false;

    const lineasWrap = form.querySelector('#reg-lineas-wrap');
    if (lineasWrap) lineasWrap.classList.toggle('hidden', sinLinea);

    const lineaSet = new Set(sinLinea ? [] : normalizeLineas(values.lineas));
    form.querySelectorAll('[data-reg-linea]').forEach((b) => {
      b.classList.toggle('active', lineaSet.has(b.dataset.regLinea));
    });

    const textoArea = form.querySelector('textarea[name="texto"]');
    if (textoArea) textoArea.value = values.texto || '';
  }

  function openRecordatorioModal(rec = null) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }

    const familias = activeFamilies();
    if (!rec && !familias.length) {
      api.openModal('Nuevo recordatorio', `
        <div class="space-y-4 py-2">
          <p class="text-sm text-white/70">Primero cargá una familia.</p>
          <button type="button" id="btn-rec-ir-familias"
            class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
            Ir a Familias
          </button>
        </div>
      `);
      document.getElementById('btn-rec-ir-familias')?.addEventListener('click', () => {
        api.closeModal();
        api.switchTab('families');
      });
      return;
    }

    const isEdit = Boolean(rec);
    const initFamilyId = isEdit ? rec.familyId : defaultFamilyForNew(familias);
    const initFecha = isEdit ? rec.fecha : tomorrowISO();
    const initTexto = isEdit ? (rec.texto || '') : '';

    let extraOption = '';
    if (isEdit && !familias.some((f) => f.id === rec.familyId)) {
      const existing = api.familyById(rec.familyId);
      if (existing && existing.id !== 'fam-misc') {
        extraOption = `<option value="${api.escapeAttr(existing.id)}" selected>${api.escapeHtml(existing.name)}</option>`;
      } else {
        extraOption = `<option value="" selected>${api.escapeHtml(familyDisplayName(rec.familyId))}</option>`;
      }
    }

    const familyOptionsHtml = extraOption + familias.map((f) =>
      `<option value="${api.escapeAttr(f.id)}" ${f.id === initFamilyId ? 'selected' : ''}>${api.escapeHtml(f.name)}</option>`
    ).join('');

    api.openModal(isEdit ? 'Editar recordatorio' : 'Nuevo recordatorio', `
      <form id="rec-form" class="space-y-4" data-id="${isEdit ? api.escapeAttr(rec.id) : ''}">
        <div>
          <label class="block text-xs text-white/50 mb-1">Familia</label>
          <select name="familyId"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">
            ${familyOptionsHtml}
          </select>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Para cuándo</label>
          <input name="fecha" type="date" required value="${api.escapeAttr(initFecha)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Qué hay que hacer</label>
          <textarea name="texto" rows="3" maxlength="500" placeholder="Ej. llamar a la escuela, pedir constancia…"
            class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">${api.escapeHtml(initTexto)}</textarea>
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
          ${isEdit ? 'Guardar cambios' : 'Guardar'}
        </button>
        ${isEdit ? `
          <button type="button" id="btn-rec-ics" class="w-full py-3 rounded-2xl border border-violet/40 text-violet-light text-sm">📅 Al calendario</button>
          <button type="button" id="btn-del-rec" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>
        ` : ''}
      </form>
    `);

    const form = document.getElementById('rec-form');
    if (!form) return;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const ok = upsertRecordatorio({
        familyId: fd.get('familyId'),
        fecha: fd.get('fecha'),
        texto: fd.get('texto')
      }, isEdit ? rec.id : null);
      if (ok) api.closeModal();
    });

    if (isEdit) {
      document.getElementById('btn-rec-ics')?.addEventListener('click', () => {
        const fechaVal = form.querySelector('input[name="fecha"]')?.value || rec.fecha;
        compartirRecordatorioIcs(fechaVal, rec.id);
      });
      document.getElementById('btn-del-rec')?.addEventListener('click', () => {
        if (deleteRecordatorio(rec.id)) api.closeModal();
      });
    }
  }

  function openRegistroModal(reg = null, preset = null) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }

    const familias = activeFamilies();
    if (!reg && !familias.length) {
      api.openModal('Nuevo registro', `
        <div class="space-y-4 py-2">
          <p class="text-sm text-white/70">Primero cargá una familia.</p>
          <button type="button" id="btn-reg-ir-familias"
            class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
            Ir a Familias
          </button>
        </div>
      `);
      document.getElementById('btn-reg-ir-familias')?.addEventListener('click', () => {
        api.closeModal();
        api.switchTab('families');
      });
      return;
    }

    const isEdit = Boolean(reg);
    const hasPreset = !isEdit && Boolean(preset);
    const hasDraft = !isEdit && !hasPreset && Boolean(regState.borrador);
    const draft = hasDraft ? regState.borrador : null;

    let initFamilyId = '';
    if (isEdit) {
      initFamilyId = reg.familyId;
    } else if (hasPreset) {
      initFamilyId = preset.familyId && familias.some((f) => f.id === preset.familyId)
        ? preset.familyId
        : defaultFamilyForNew(familias);
    } else if (draft && familias.some((f) => f.id === draft.familyId)) {
      initFamilyId = draft.familyId;
    } else {
      initFamilyId = defaultFamilyForNew(familias);
    }

    const initFecha = isEdit ? reg.fecha : ((draft && draft.fecha) || api.defaultDateForView());
    const initTipo = validTipo(isEdit ? reg.tipo : ((draft && draft.tipo) || 'visita'));
    const initNoConc = (initTipo === 'visita' || initTipo === 'llamada')
      ? Boolean(isEdit ? reg.noConcretada : (draft && draft.noConcretada))
      : false;
    const initLineas = normalizeLineas(isEdit ? reg.lineas : (draft && draft.lineas));
    const initTexto = isEdit ? (reg.texto || '') : (hasPreset ? String(preset.texto || '') : ((draft && draft.texto) || ''));

    let extraOption = '';
    if (isEdit && !familias.some((f) => f.id === reg.familyId)) {
      const existing = api.familyById(reg.familyId);
      if (existing && existing.id !== 'fam-misc') {
        extraOption = `<option value="${api.escapeAttr(existing.id)}" selected>${api.escapeHtml(existing.name)}</option>`;
      } else {
        extraOption = `<option value="" selected>${api.escapeHtml(familyDisplayName(reg.familyId))}</option>`;
      }
    }

    const familyOptionsHtml = extraOption + familias.map((f) =>
      `<option value="${api.escapeAttr(f.id)}" ${f.id === initFamilyId ? 'selected' : ''}>${api.escapeHtml(f.name)}</option>`
    ).join('');

    const tipoButtonsHtml = TIPOS.map((t) =>
      `<button type="button" data-reg-tipo="${api.escapeAttr(t.id)}" class="chip px-3 py-1.5 rounded-full text-xs${t.id === initTipo ? ' active' : ''}">${api.escapeHtml(t.label)}</button>`
    ).join('');

    const lineaSet = new Set(initLineas);
    const lineaButtonsHtml = LINEAS.map((l) =>
      `<button type="button" data-reg-linea="${api.escapeAttr(l.id)}" class="chip px-3 py-1.5 rounded-full text-xs${lineaSet.has(l.id) ? ' active' : ''}">${api.escapeHtml(l.corto)}</button>`
    ).join('');

    const showNoConc = !NO_LINEA_TIPOS.has(initTipo) && (initTipo === 'visita' || initTipo === 'llamada');
    const showLineas = !NO_LINEA_TIPOS.has(initTipo);

    api.openModal(isEdit ? 'Editar registro' : 'Nuevo registro', `
      <form id="reg-form" class="space-y-4" data-id="${isEdit ? api.escapeAttr(reg.id) : ''}">
        ${hasDraft ? `
          <div id="reg-draft-banner" class="rounded-xl bg-amber-500/15 border border-amber-400/35 px-3 py-2 flex items-center justify-between gap-2 text-xs text-amber-200">
            <span>Borrador recuperado</span>
            <button type="button" id="btn-reg-descartar" class="px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-400/40 font-medium text-amber-100">Descartar</button>
          </div>
        ` : ''}
        <div>
          <label class="block text-xs text-white/50 mb-1">Familia</label>
          <select name="familyId"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">
            ${familyOptionsHtml}
          </select>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Fecha</label>
          <input name="fecha" type="date" required value="${api.escapeAttr(initFecha)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1.5">Tipo</label>
          <div class="flex flex-wrap gap-1.5">
            ${tipoButtonsHtml}
          </div>
          <label id="reg-noconc-wrap" class="mt-2.5 flex items-center gap-2 text-xs text-white/80 cursor-pointer${showNoConc ? '' : ' hidden'}">
            <input type="checkbox" name="noConcretada" class="w-4 h-4 rounded accent-violet-light" ${initNoConc ? 'checked' : ''} />
            <span>No se concretó</span>
          </label>
        </div>
        <div id="reg-lineas-wrap"${showLineas ? '' : ' class="hidden"'}>
          <label class="block text-xs text-white/50 mb-1.5">Línea de abordaje (opcional)</label>
          <div class="flex flex-wrap gap-1.5">
            ${lineaButtonsHtml}
          </div>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Texto</label>
          <textarea name="texto" rows="6" maxlength="4000" placeholder="Qué pasó, qué se acordó o qué documento se recibió…"
            class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">${api.escapeHtml(initTexto)}</textarea>
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
          ${isEdit ? 'Guardar cambios' : 'Guardar'}
        </button>
        ${isEdit ? `<button type="button" id="btn-del-reg" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>` : ''}
      </form>
    `);

    const form = document.getElementById('reg-form');
    if (!form) return;

    const onDraftChange = () => {
      if (!isEdit) scheduleDraftSave(readFormDraft(form));
    };

    form.addEventListener('click', (e) => {
      const tipoBtn = e.target.closest('[data-reg-tipo]');
      if (tipoBtn) {
        const chosen = tipoBtn.dataset.regTipo;
        form.querySelectorAll('[data-reg-tipo]').forEach((b) => {
          b.classList.toggle('active', b === tipoBtn);
        });
        const sinLinea = NO_LINEA_TIPOS.has(chosen);
        const show = !sinLinea && (chosen === 'visita' || chosen === 'llamada');
        const wrap = form.querySelector('#reg-noconc-wrap');
        const chk = form.querySelector('input[name="noConcretada"]');
        if (wrap) wrap.classList.toggle('hidden', !show);
        if (!show && chk) chk.checked = false;
        const lWrap = form.querySelector('#reg-lineas-wrap');
        if (lWrap) lWrap.classList.toggle('hidden', sinLinea);
        if (sinLinea) {
          form.querySelectorAll('[data-reg-linea]').forEach((b) => b.classList.remove('active'));
        }
        onDraftChange();
        return;
      }

      const lineaBtn = e.target.closest('[data-reg-linea]');
      if (lineaBtn) {
        lineaBtn.classList.toggle('active');
        onDraftChange();
      }
    });

    form.addEventListener('input', onDraftChange);
    form.addEventListener('change', onDraftChange);

    if (hasDraft) {
      document.getElementById('btn-reg-descartar')?.addEventListener('click', () => {
        clearDraftTimer();
        regState.borrador = null;
        saveReg();
        document.getElementById('reg-draft-banner')?.remove();
        applyFormState(form, {
          familyId: defaultFamilyForNew(familias),
          fecha: api.defaultDateForView(),
          tipo: 'visita',
          noConcretada: false,
          lineas: [],
          texto: ''
        });
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const values = readFormDraft(form);
      const ok = upsertRegistro(values, isEdit ? reg.id : null);
      if (ok) api.closeModal();
    });

    if (isEdit) {
      document.getElementById('btn-del-reg')?.addEventListener('click', () => {
        if (deleteRegistro(reg.id)) api.closeModal();
      });
    }
  }

  // ─── Ficha Word (parte fija y parte del mes) ───────────────
  function trimCampo(s) {
    return String(s ?? '').trim().slice(0, 2000);
  }

  function shortDDMM(iso) {
    const f = String(iso || '');
    return f.length >= 10 ? f.slice(8, 10) + '/' + f.slice(5, 7) : f;
  }

  function formatTiempos(isoDates) {
    const uniq = [...new Set(isoDates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
    if (!uniq.length) return '';
    if (uniq.length === 1) {
      const d = uniq[0];
      return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
    }
    const parts = uniq.map((d, idx) =>
      idx === uniq.length - 1
        ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`
        : `${d.slice(8, 10)}/${d.slice(5, 7)}`
    );
    return parts.slice(0, -1).join(', ') + ' y ' + parts[parts.length - 1];
  }

  async function obtenerPlantilla() {
    if (plantillaCache) return plantillaCache;
    const res = await fetch('./plantillas/ficha-etaf.docx');
    if (!res.ok) throw new Error('No se pudo cargar la plantilla');
    plantillaCache = new Uint8Array(await res.arrayBuffer());
    return plantillaCache;
  }

  function defaultFichaBase(fam) {
    const ch = Array.isArray(fam?.children) ? fam.children : [];
    const nucleo = ch.length
      ? ch.map((c) => ({
          nombre: c.name || '',
          vinculo: '',
          ci: '',
          nacimiento: '',
          credencial: '',
          sipi: c.sipi || '',
          ingresos: ''
        }))
      : [{ nombre: '', vinculo: '', ci: '', nacimiento: '', credencial: '', sipi: '', ingresos: '' }];
    return {
      nucleo,
      contacto: {
        direccion: '',
        telefono: '',
        salud: '',
        educativos: '',
        dupla: api.autor()
      },
      ingreso: [{ nombre: '', ci: '', sipi: '', fechaInau: '', fechaCentro: '', motivo: '', juzgado: '' }],
      contexto: {
        permanece: '',
        inicioContexto: '',
        inicioEtaf: '',
        acogimiento: '',
        afModalidad: '',
        afTitular: '',
        afConvenio: '',
        tenencia: '',
        instituciones: '',
        salientesDerivacion: ''
      }
    };
  }

  function fichaFieldHtml(name, label, value, placeholder = '', multiline = false) {
    const val = String(value || '');
    if (multiline) {
      return `
        <div>
          <label class="block text-[11px] text-white/55 mb-1">${api.escapeHtml(label)}</label>
          <textarea name="${api.escapeAttr(name)}" rows="2" maxlength="2000" placeholder="${api.escapeAttr(placeholder)}"
            class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-light">${api.escapeHtml(val)}</textarea>
        </div>
      `;
    }
    return `
      <div>
        <label class="block text-[11px] text-white/55 mb-1">${api.escapeHtml(label)}</label>
        <input name="${api.escapeAttr(name)}" type="text" maxlength="2000" value="${api.escapeAttr(val)}" placeholder="${api.escapeAttr(placeholder)}"
          class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-light" />
      </div>
    `;
  }

  function nucleoRowHtml(p = {}) {
    return `
      <div class="ficha-nucleo-row rounded-xl bg-void/40 p-3 border border-white/10 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-violet-light">Persona</span>
          <button type="button" class="btn-ficha-rem-row text-[11px] text-red-400 hover:underline">Quitar</button>
        </div>
        ${fichaFieldHtml('n_nombre', 'Nombres y Apellidos', p.nombre, 'Ej. Marta Ejemplo')}
        ${fichaFieldHtml('n_vinculo', 'Vínculo / Parentesco', p.vinculo, 'Ej. Referente familiar')}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${fichaFieldHtml('n_ci', 'CI', p.ci, 'Ej. 1.111.111-1')}
          ${fichaFieldHtml('n_nacimiento', 'Fecha nacimiento', p.nacimiento, 'Ej. 01/02/1990')}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${fichaFieldHtml('n_credencial', 'Credencial Cívica', p.credencial)}
          ${fichaFieldHtml('n_sipi', 'SIPI', p.sipi)}
        </div>
        ${fichaFieldHtml('n_ingresos', 'Ingresos Totales', p.ingresos, 'Prestaciones, laborales, otros', true)}
      </div>
    `;
  }

  function ingresoRowHtml(ing = {}) {
    return `
      <div class="ficha-ingreso-row rounded-xl bg-void/40 p-3 border border-white/10 space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-[11px] font-medium text-violet-light">Ingreso 24 h</span>
          <button type="button" class="btn-ficha-rem-row text-[11px] text-red-400 hover:underline">Quitar</button>
        </div>
        ${fichaFieldHtml('i_nombre', 'Nombres y Apellidos', ing.nombre)}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${fichaFieldHtml('i_ci', 'CI', ing.ci)}
          ${fichaFieldHtml('i_sipi', 'SIPI', ing.sipi)}
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
          ${fichaFieldHtml('i_fechaInau', 'Fecha ingreso a INAU', ing.fechaInau, 'Ej. Junio 2023')}
          ${fichaFieldHtml('i_fechaCentro', 'Fecha ingreso al Centro', ing.fechaCentro, 'Ej. Junio 2023')}
        </div>
        ${fichaFieldHtml('i_motivo', 'Motivo del Ingreso', ing.motivo, '', true)}
        ${fichaFieldHtml('i_juzgado', 'Juzgado / IUE', ing.juzgado)}
      </div>
    `;
  }

  function openFichaDatosModal(familyId) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    const fam = api.familyById(familyId);
    if (!fam || fam.id === 'fam-misc') return;

    const base = regState.fichaBase[familyId] || defaultFichaBase(fam);
    const nucleoArr = Array.isArray(base.nucleo) && base.nucleo.length ? base.nucleo : [{}];
    const ingresoArr = Array.isArray(base.ingreso) && base.ingreso.length ? base.ingreso : [{}];
    const c = base.contexto || {};
    const ct = base.contacto || {};

    api.openModal(`Datos de la ficha — ${fam.name}`, `
      <div class="space-y-4">
        <label class="w-full py-2.5 px-3 rounded-xl border border-violet/40 text-xs font-medium text-violet-light flex items-center justify-center gap-2 cursor-pointer hover:bg-violet/10">
          <span>📄 Importar desde una ficha Word anterior</span>
          <input type="file" id="reg-input-ficha" accept=".docx" class="hidden" />
        </label>

        <form id="ficha-datos-form" class="space-y-5">
          <div class="space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-violet-light">Núcleo familiar actual</h4>
              <button type="button" id="btn-ficha-add-nucleo" class="text-xs text-violet-light font-medium">+ Agregar persona</button>
            </div>
            <div id="ficha-nucleo-list" class="space-y-2.5">
              ${nucleoArr.map(nucleoRowHtml).join('')}
            </div>
          </div>

          <div class="space-y-2.5">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-violet-light">Contacto</h4>
            <div class="rounded-xl bg-void/40 p-3 border border-white/10 space-y-2">
              ${fichaFieldHtml('c_direccion', 'Dirección / Barrio', ct.direccion, '', true)}
              ${fichaFieldHtml('c_telefono', 'Teléfono de contacto', ct.telefono)}
              ${fichaFieldHtml('c_salud', 'Centro de Salud', ct.salud, '', true)}
              ${fichaFieldHtml('c_educativos', 'Centros Educativos', ct.educativos, '', true)}
              ${fichaFieldHtml('c_dupla', 'Dupla Referente', ct.dupla, '', true)}
            </div>
          </div>

          <div class="space-y-2.5">
            <div class="flex items-center justify-between gap-2">
              <h4 class="text-xs font-semibold uppercase tracking-wide text-violet-light">Ingreso al sistema 24 h</h4>
              <button type="button" id="btn-ficha-add-ingreso" class="text-xs text-violet-light font-medium">+ Agregar ingreso</button>
            </div>
            <div id="ficha-ingreso-list" class="space-y-2.5">
              ${ingresoArr.map(ingresoRowHtml).join('')}
            </div>
          </div>

          <div class="space-y-2.5">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-violet-light">Contexto familiar</h4>
            <div class="rounded-xl bg-void/40 p-3 border border-white/10 space-y-2">
              ${fichaFieldHtml('x_permanece', 'Permanece en Centro (Si, No)', c.permanece)}
              ${fichaFieldHtml('x_inicioContexto', 'Fecha de inicio del Contexto', c.inicioContexto)}
              ${fichaFieldHtml('x_inicioEtaf', 'Fecha inicio intervención ETAF CAFF', c.inicioEtaf)}
              <div>
                <label class="block text-[11px] text-white/55 mb-1">Acogimiento Familiar</label>
                <select name="x_acogimiento"
                  class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-light">
                  <option value="" ${!c.acogimiento ? 'selected' : ''}>Sin marcar</option>
                  <option value="SI" ${c.acogimiento === 'SI' ? 'selected' : ''}>SI</option>
                  <option value="NO" ${c.acogimiento === 'NO' ? 'selected' : ''}>NO</option>
                </select>
              </div>
              <div class="rounded-xl bg-void/30 p-2.5 border border-white/5 space-y-2">
                <p class="text-[11px] font-medium text-white/70">En caso de tener AF</p>
                ${fichaFieldHtml('x_afModalidad', 'Modalidad', c.afModalidad)}
                ${fichaFieldHtml('x_afTitular', 'Titular / Proyecto', c.afTitular)}
                ${fichaFieldHtml('x_afConvenio', 'Fecha de convenio', c.afConvenio)}
              </div>
              ${fichaFieldHtml('x_tenencia', 'Tenencia (Si, No, En Trámite)', c.tenencia)}
              ${fichaFieldHtml('x_instituciones', 'Instituciones vinculadas al Núcleo Familiar', c.instituciones, '', true)}
              ${fichaFieldHtml('x_salientesDerivacion', 'Aspectos salientes al momento de la derivación', c.salientesDerivacion, '', true)}
            </div>
          </div>

          <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
            Guardar
          </button>
        </form>
      </div>
    `);

    const form = document.getElementById('ficha-datos-form');
    const nucleoList = document.getElementById('ficha-nucleo-list');
    const ingresoList = document.getElementById('ficha-ingreso-list');
    if (!form || !nucleoList || !ingresoList) return;

    document.getElementById('btn-ficha-add-nucleo')?.addEventListener('click', () => {
      nucleoList.insertAdjacentHTML('beforeend', nucleoRowHtml({}));
    });
    document.getElementById('btn-ficha-add-ingreso')?.addEventListener('click', () => {
      ingresoList.insertAdjacentHTML('beforeend', ingresoRowHtml({}));
    });

    form.addEventListener('click', (e) => {
      const rem = e.target.closest('.btn-ficha-rem-row');
      if (!rem) return;
      const row = rem.closest('.ficha-nucleo-row, .ficha-ingreso-row');
      if (row) row.remove();
    });

    document.getElementById('reg-input-ficha')?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      if (!window.FLDocx) {
        api.toast('No se pudo cargar el generador de fichas');
        return;
      }
      try {
        const buf = await file.arrayBuffer();
        const parsed = await window.FLDocx.leerFicha(new Uint8Array(buf));
        nucleoList.innerHTML = (parsed.nucleo && parsed.nucleo.length ? parsed.nucleo : [{}]).map(nucleoRowHtml).join('');
        ingresoList.innerHTML = (parsed.ingreso && parsed.ingreso.length ? parsed.ingreso : [{}]).map(ingresoRowHtml).join('');
        const pct = parsed.contacto || {};
        form.querySelector('[name="c_direccion"]').value = pct.direccion || '';
        form.querySelector('[name="c_telefono"]').value = pct.telefono || '';
        form.querySelector('[name="c_salud"]').value = pct.salud || '';
        form.querySelector('[name="c_educativos"]').value = pct.educativos || '';
        form.querySelector('[name="c_dupla"]').value = pct.dupla || '';
        const pcx = parsed.contexto || {};
        form.querySelector('[name="x_permanece"]').value = pcx.permanece || '';
        form.querySelector('[name="x_inicioContexto"]').value = pcx.inicioContexto || '';
        form.querySelector('[name="x_inicioEtaf"]').value = pcx.inicioEtaf || '';
        form.querySelector('[name="x_acogimiento"]').value = pcx.acogimiento || '';
        form.querySelector('[name="x_afModalidad"]').value = pcx.afModalidad || '';
        form.querySelector('[name="x_afTitular"]').value = pcx.afTitular || '';
        form.querySelector('[name="x_afConvenio"]').value = pcx.afConvenio || '';
        form.querySelector('[name="x_tenencia"]').value = pcx.tenencia || '';
        form.querySelector('[name="x_instituciones"]').value = pcx.instituciones || '';
        form.querySelector('[name="x_salientesDerivacion"]').value = pcx.salientesDerivacion || '';
        api.toast('Datos cargados. Revisá y tocá Guardar');
      } catch {
        api.toast('Ese archivo no parece una ficha ETAF');
      }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const readVal = (root, name) => trimCampo(root.querySelector(`[name="${name}"]`)?.value);

      const nucleo = [...nucleoList.querySelectorAll('.ficha-nucleo-row')]
        .map((row) => ({
          nombre: readVal(row, 'n_nombre'),
          vinculo: readVal(row, 'n_vinculo'),
          ci: readVal(row, 'n_ci'),
          nacimiento: readVal(row, 'n_nacimiento'),
          credencial: readVal(row, 'n_credencial'),
          sipi: readVal(row, 'n_sipi'),
          ingresos: readVal(row, 'n_ingresos')
        }))
        .filter((p) => p.nombre || p.vinculo || p.ci || p.nacimiento || p.credencial || p.sipi || p.ingresos);

      const ingreso = [...ingresoList.querySelectorAll('.ficha-ingreso-row')]
        .map((row) => ({
          nombre: readVal(row, 'i_nombre'),
          ci: readVal(row, 'i_ci'),
          sipi: readVal(row, 'i_sipi'),
          fechaInau: readVal(row, 'i_fechaInau'),
          fechaCentro: readVal(row, 'i_fechaCentro'),
          motivo: readVal(row, 'i_motivo'),
          juzgado: readVal(row, 'i_juzgado')
        }))
        .filter((r) => r.nombre || r.ci || r.sipi || r.fechaInau || r.fechaCentro || r.motivo || r.juzgado);

      const acogRaw = readVal(form, 'x_acogimiento');
      const acogimiento = (acogRaw === 'SI' || acogRaw === 'NO') ? acogRaw : '';

      const snapshot = JSON.stringify(regState);
      regState.fichaBase[familyId] = {
        nucleo,
        contacto: {
          direccion: readVal(form, 'c_direccion'),
          telefono: readVal(form, 'c_telefono'),
          salud: readVal(form, 'c_salud'),
          educativos: readVal(form, 'c_educativos'),
          dupla: readVal(form, 'c_dupla')
        },
        ingreso,
        contexto: {
          permanece: readVal(form, 'x_permanece'),
          inicioContexto: readVal(form, 'x_inicioContexto'),
          inicioEtaf: readVal(form, 'x_inicioEtaf'),
          acogimiento,
          afModalidad: readVal(form, 'x_afModalidad'),
          afTitular: readVal(form, 'x_afTitular'),
          afConvenio: readVal(form, 'x_afConvenio'),
          tenencia: readVal(form, 'x_tenencia'),
          instituciones: readVal(form, 'x_instituciones'),
          salientesDerivacion: readVal(form, 'x_salientesDerivacion')
        },
        updatedAt: new Date().toISOString()
      };

      if (!saveReg()) {
        regState = JSON.parse(snapshot);
        return;
      }
      render();
      api.closeModal();
      api.toast('Datos de la ficha guardados');
    });
  }

  function buildDatosFichaWord(mes, familyId, cierre) {
    const regs = registrosDelMes(mes, familyId);
    const gastos = api.familyById(familyId) ? gastosDeFamiliaEnMes(mes, familyId) : [];

    const salienteRegs = regs.filter((r) => r.tipo === 'saliente');
    const obsYValRegs = regs.filter((r) =>
      r.tipo === 'observacion' ||
      (r.tipo === 'valoracion' && (!Array.isArray(r.lineas) || !r.lineas.length))
    );

    const salientesLines = salienteRegs.map((r) => `${shortDDMM(r.fecha)}: ${String(r.texto || '').trim()}`);
    if (String(cierre.salientes || '').trim()) {
      if (salientesLines.length) salientesLines.push('');
      salientesLines.push(String(cierre.salientes).trim());
    }

    const obsLines = obsYValRegs.map((r) => `${shortDDMM(r.fecha)}: ${String(r.texto || '').trim()}`);
    if (String(cierre.observaciones || '').trim()) {
      if (obsLines.length) obsLines.push('');
      obsLines.push(String(cierre.observaciones).trim());
    }

    const lineaApoyos = LINEA_IDS.includes(cierre.lineaApoyos) ? cierre.lineaApoyos : 'trabajo';
    const lineasCols = LINEAS.map((l) => {
      const lid = l.id;
      const valRegs = regs.filter((r) =>
        r.tipo === 'valoracion' && Array.isArray(r.lineas) && r.lineas.includes(lid)
      );
      const accRegs = regs.filter((r) =>
        r.tipo !== 'saliente' &&
        r.tipo !== 'observacion' &&
        r.tipo !== 'valoracion' &&
        (Array.isArray(r.lineas) && r.lineas.length ? r.lineas.includes(lid) : lid === 'familia')
      );

      const tiemposDates = [];
      const valOverride = String((cierre.valoracion && cierre.valoracion[lid]) || '').trim();
      let col1 = '';
      if (valOverride) {
        col1 = valOverride;
      } else if (valRegs.length) {
        col1 = valRegs.map((r) => {
          tiemposDates.push(r.fecha);
          return `${shortDDMM(r.fecha)}: ${String(r.texto || '').trim()}`;
        }).join('\n');
      }

      const accLines = accRegs.map((r) => {
        tiemposDates.push(r.fecha);
        const noConc = r.noConcretada ? ' · no se concretó' : '';
        return `• ${shortDDMM(r.fecha)} · ${tipoLabel(r.tipo)}${noConc}: ${String(r.texto || '').trim()}`;
      });

      if (lid === lineaApoyos && gastos.length) {
        if (accLines.length) accLines.push('');
        accLines.push('APOYOS ECONÓMICOS DEL MES');
        let total = 0;
        for (const g of gastos) {
          total += Number(g.amount) || 0;
          tiemposDates.push(g.date);
          accLines.push(`• ${shortDDMM(g.date)} · ${api.money(g.amount)} · ${g.what || ''}`);
        }
        total = Math.round(total * 100) / 100;
        accLines.push('Total: ' + api.money(total));
      }

      const col2 = accLines.join('\n');
      const col3 = (col1 || col2) ? formatTiempos(tiemposDates) : '';
      return [col1, col2, col3];
    });

    const base = regState.fichaBase[familyId] || {};
    return {
      nucleo: Array.isArray(base.nucleo) ? base.nucleo : [],
      contacto: base.contacto || {},
      ingreso: Array.isArray(base.ingreso) ? base.ingreso : [],
      contexto: base.contexto || {},
      periodo: String(cierre.periodo || '').trim(),
      salientes: salientesLines.join('\n'),
      fecha: api.formatDateNum(api.todayISO()),
      lineas: lineasCols,
      observaciones: obsLines.join('\n')
    };
  }

  function openFichaWordModal(familyId) {
    if (regCorrupt) {
      api.toast('No se pudieron leer los registros');
      return;
    }
    if (!window.FLDocx) {
      api.toast('No se pudo cargar el generador de fichas');
      return;
    }

    obtenerPlantilla().catch(() => {});

    const { year, month } = api.getView();
    const mes = api.monthKey(year, month);
    const clave = mes + '|' + familyId;
    const famName = familyDisplayName(familyId);
    const saved = regState.cierresMes[clave] || {};
    const valSaved = saved.valoracion || {};
    const regs = registrosDelMes(mes, familyId);

    const salienteRegs = regs.filter((r) => r.tipo === 'saliente');
    const obsYValRegs = regs.filter((r) =>
      r.tipo === 'observacion' ||
      (r.tipo === 'valoracion' && (!Array.isArray(r.lineas) || !r.lineas.length))
    );
    const sinLineaAccion = regs.filter((r) =>
      r.tipo !== 'saliente' &&
      r.tipo !== 'observacion' &&
      r.tipo !== 'valoracion' &&
      (!Array.isArray(r.lineas) || !r.lineas.length)
    );

    const hasBase = Boolean(regState.fichaBase[familyId]);
    const canEditBase = Boolean(api.familyById(familyId)) && familyId !== 'fam-misc';
    const esParcial = mes >= api.todayISO().slice(0, 7);

    const salientesPreview = salienteRegs.length
      ? `<p class="text-[11px] text-white/45 mt-1">Ya cargado en el mes: ${api.escapeHtml(salienteRegs.map((r) => `${shortDDMM(r.fecha)}: ${r.texto}`).join(' · '))}</p>`
      : '';
    const obsPreview = obsYValRegs.length
      ? `<p class="text-[11px] text-white/45 mt-1">Ya cargado en el mes: ${api.escapeHtml(obsYValRegs.map((r) => `${shortDDMM(r.fecha)}: ${r.texto}`).join(' · '))}</p>`
      : '';

    const lineaApoyos = LINEA_IDS.includes(saved.lineaApoyos) ? saved.lineaApoyos : 'trabajo';
    const lineaOptionsHtml = LINEAS.map((l) =>
      `<option value="${api.escapeAttr(l.id)}" ${l.id === lineaApoyos ? 'selected' : ''}>${api.escapeHtml(l.corto)}</option>`
    ).join('');

    const valFieldsHtml = LINEAS.map((l) => `
      <div>
        <label class="block text-[11px] text-white/55 mb-1">${api.escapeHtml(l.corto)}</label>
        <textarea name="val_${api.escapeAttr(l.id)}" rows="2" maxlength="2000"
          class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2 text-xs focus:outline-none focus:border-violet-light">${api.escapeHtml(valSaved[l.id] || '')}</textarea>
      </div>
    `).join('');

    api.openModal(`Cierre del mes — ${famName}`, `
      <div class="space-y-4">
        ${esParcial ? `
          <div id="word-aviso-parcial" class="rounded-xl bg-amber-500/15 border border-amber-400/35 px-3 py-2.5 text-xs text-amber-200">
            Ficha parcial: incluye lo cargado hasta hoy. La final sacala cuando termine el mes
          </div>
        ` : ''}
        ${!hasBase ? `
          <div class="rounded-xl bg-amber-500/15 border border-amber-400/35 px-3 py-2.5 text-xs text-amber-200 flex items-center justify-between gap-2">
            <span>Esta familia no tiene datos de la ficha cargados</span>
            ${canEditBase ? `<button type="button" id="btn-word-cargar-datos" class="shrink-0 px-2.5 py-1 rounded-lg bg-amber-500/20 border border-amber-400/40 font-medium text-amber-100">Cargar</button>` : ''}
          </div>
        ` : ''}
        ${sinLineaAccion.length > 0 ? `
          <div class="rounded-xl bg-amber-500/15 border border-amber-400/35 px-3 py-2.5 text-xs text-amber-200">
            Hay ${sinLineaAccion.length} ${sinLineaAccion.length === 1 ? 'registro' : 'registros'} sin línea de abordaje: van a Vivir en familia
          </div>
        ` : ''}

        <form id="ficha-word-form" class="space-y-4">
          <div>
            <label class="block text-xs text-white/50 mb-1">Período</label>
            <input name="periodo" type="text" maxlength="2000" value="${api.escapeAttr(saved.periodo !== undefined ? saved.periodo : mesDisplay(mes))}"
              class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-light" />
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Aspectos salientes del mes</label>
            <textarea name="salientes" rows="3" maxlength="2000"
              class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-light">${api.escapeHtml(saved.salientes || '')}</textarea>
            ${salientesPreview}
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Observaciones</label>
            <textarea name="observaciones" rows="3" maxlength="2000"
              class="select-text w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-light">${api.escapeHtml(saved.observaciones || '')}</textarea>
            ${obsPreview}
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Apoyos económicos van en</label>
            <select name="lineaApoyos"
              class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-violet-light">
              ${lineaOptionsHtml}
            </select>
          </div>
          <details class="rounded-xl bg-void/40 border border-white/10 p-3">
            <summary class="text-xs font-medium text-violet-light cursor-pointer">Valoración por línea (opcional)</summary>
            <p class="text-[11px] text-white/45 mt-2 mb-3">Si lo dejás vacío, se usan tus registros de Valoración técnica de esa línea.</p>
            <div class="space-y-2.5">
              ${valFieldsHtml}
            </div>
          </details>
          <button type="submit" id="btn-generar-word" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
            Generar Word
          </button>
        </form>
      </div>
    `);

    document.getElementById('btn-word-cargar-datos')?.addEventListener('click', () => {
      openFichaDatosModal(familyId);
    });

    const form = document.getElementById('ficha-word-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!window.FLDocx) {
        api.toast('No se pudo cargar el generador de fichas');
        return;
      }

      const valoracion = {};
      for (const l of LINEAS) {
        valoracion[l.id] = trimCampo(form.querySelector(`[name="val_${l.id}"]`)?.value);
      }
      const lineaChosen = form.querySelector('[name="lineaApoyos"]')?.value;
      const cierre = {
        periodo: trimCampo(form.querySelector('[name="periodo"]')?.value),
        salientes: trimCampo(form.querySelector('[name="salientes"]')?.value),
        observaciones: trimCampo(form.querySelector('[name="observaciones"]')?.value),
        valoracion,
        lineaApoyos: LINEA_IDS.includes(lineaChosen) ? lineaChosen : 'trabajo',
        updatedAt: new Date().toISOString()
      };

      const snapshot = JSON.stringify(regState);
      regState.cierresMes[clave] = cierre;
      if (!saveReg()) {
        regState = JSON.parse(snapshot);
        return;
      }

      const btn = document.getElementById('btn-generar-word');
      if (btn) btn.disabled = true;
      try {
        const plantillaBytes = await obtenerPlantilla();
        const datos = buildDatosFichaWord(mes, familyId, cierre);
        const blob = await window.FLDocx.llenarFicha(plantillaBytes, datos);
        const safeFam = famName.replace(/[\\/:*?"<>|]/g, '-');
        const hoy = api.todayISO();
        const sufijoParcial = mes >= hoy.slice(0, 7) ? ` - parcial al ${hoy.slice(8, 10)}-${hoy.slice(5, 7)}` : '';
        const filename = `Ficha Registro Etaf Caff - ${safeFam} (${MESES_CORTO[month]} ${String(year).slice(-2)})${sufijoParcial}.docx`;
        const file = new File([blob], filename, {
          type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        });
        await compartirArchivos([file]);
        api.closeModal();
      } catch (err) {
        console.error('[Ficha Word]', err);
        api.toast('No se pudo generar la ficha Word');
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  // ─── Render de la pestaña ──────────────────────────────────
  function render() {
    if (!api) return;
    const { year, month } = api.getView();
    const mes = api.monthKey(year, month);

    const monthLabelEl = document.getElementById('reg-month-label');
    if (monthLabelEl) monthLabelEl.textContent = api.monthLabel(year, month);

    const cierreTituloEl = document.getElementById('reg-cierre-titulo');
    if (cierreTituloEl) cierreTituloEl.textContent = 'Cierre de ' + api.monthLabel(year, month);

    const avisoEl = document.getElementById('reg-aviso');
    const chipsEl = document.getElementById('reg-family-chips');
    const btnDatosEl = document.getElementById('btn-reg-datos');
    const recHeaderEl = document.getElementById('reg-rec-header');
    const recListEl = document.getElementById('reg-rec-list');
    const recEmptyBtnEl = document.getElementById('btn-add-rec-empty');
    const listEl = document.getElementById('reg-list');
    const emptyEl = document.getElementById('reg-empty');
    const cierreListEl = document.getElementById('reg-cierre-lista');
    const resumenEl = document.getElementById('reg-datos-resumen');
    const navDotEl = document.querySelector('.nav-item[data-tab="reg"] .nav-dot');

    const updateNavDot = (on) => {
      if (!navDotEl) return;
      if (on) {
        navDotEl.style.opacity = '1';
        navDotEl.style.transform = 'scale(1)';
        navDotEl.classList.add('bg-amber-400');
        navDotEl.classList.remove('bg-violet-light');
      } else {
        navDotEl.style.opacity = '';
        navDotEl.style.transform = '';
        navDotEl.classList.remove('bg-amber-400');
        navDotEl.classList.add('bg-violet-light');
      }
    };

    if (regCorrupt) {
      if (avisoEl) { avisoEl.classList.add('hidden'); avisoEl.textContent = ''; }
      if (chipsEl) chipsEl.innerHTML = '';
      if (btnDatosEl) btnDatosEl.classList.add('hidden');
      if (recHeaderEl) recHeaderEl.classList.add('hidden');
      if (recListEl) recListEl.innerHTML = '';
      if (recEmptyBtnEl) recEmptyBtnEl.classList.add('hidden');
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (cierreListEl) cierreListEl.innerHTML = '';
      if (resumenEl) resumenEl.textContent = 'No se pudieron leer los registros';
      updateNavDot(false);
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    // Aviso > 7 días
    const aviso = avisoPendienteMasViejo();
    if (avisoEl) {
      if (aviso) {
        avisoEl.textContent = `Hace ${aviso.dias} días que no exportás ${aviso.nombre} (${aviso.mesNombre}) → ver`;
        avisoEl.dataset.mes = aviso.mes;
        avisoEl.dataset.familyId = aviso.familyId;
        avisoEl.classList.remove('hidden');
      } else {
        avisoEl.classList.add('hidden');
        avisoEl.textContent = '';
      }
    }

    // Chips de filtro
    const fams = activeFamilies();
    const chipList = [{ id: 'all', name: 'Todas' }, ...fams.map((f) => ({ id: f.id, name: f.name }))];
    if (activeFilter !== 'all' && !chipList.some((c) => c.id === activeFilter)) {
      chipList.push({ id: activeFilter, name: familyDisplayName(activeFilter) });
    }
    if (chipsEl) {
      chipsEl.innerHTML = chipList.map((c) => {
        const isAct = c.id === activeFilter;
        return `<button type="button" data-reg-family="${api.escapeAttr(c.id)}" class="chip shrink-0 px-3 py-1.5 rounded-full text-xs${isAct ? ' active' : ''}">${api.escapeHtml(c.name)}</button>`;
      }).join('');
    }
    if (btnDatosEl) {
      const showDatos = activeFilter !== 'all' && activeFilter !== 'fam-misc' && Boolean(api.familyById(activeFilter));
      btnDatosEl.classList.toggle('hidden', !showDatos);
    }

    // Caja «Para hacer» (recordatorios pendientes) y punto en barra inferior
    const hoy = api.todayISO();
    const hayVencidos = regState.recordatorios.some((r) => r && !r.hecho && r.fecha && r.fecha <= hoy);
    updateNavDot(hayVencidos);

    const recsPendientes = regState.recordatorios
      .filter((r) => r && !r.hecho && (activeFilter === 'all' || r.familyId === activeFilter))
      .slice()
      .sort((a, b) => ((a.fecha || '') + (a.createdAt || '')).localeCompare((b.fecha || '') + (b.createdAt || '')));

    if (recHeaderEl && recListEl && recEmptyBtnEl) {
      if (!recsPendientes.length) {
        recHeaderEl.classList.add('hidden');
        recListEl.classList.add('hidden');
        recListEl.innerHTML = '';
        recEmptyBtnEl.classList.remove('hidden');
      } else {
        recHeaderEl.classList.remove('hidden');
        recListEl.classList.remove('hidden');
        recEmptyBtnEl.classList.add('hidden');
        recListEl.innerHTML = recsPendientes.map((r) => {
          const f = String(r.fecha || '');
          const ddmm = f.length >= 10 ? f.slice(8, 10) + '/' + f.slice(5, 7) : f;
          const famName = familyDisplayName(r.familyId);
          const isDue = Boolean(f && f <= hoy);
          const dueLabel = f === hoy ? 'vence hoy' : 'venció';
          const badgeHtml = isDue
            ? `<span class="text-amber-200 font-medium">· ${dueLabel}</span>`
            : '';
          return `
            <li class="rounded-xl px-3 py-2.5 border flex items-center justify-between gap-2 ${isDue ? 'bg-amber-500/15 border-amber-400/40' : 'bg-void/40 border-white/5'}">
              <button type="button" data-edit-rec="${api.escapeAttr(r.id)}" class="flex-1 min-w-0 text-left space-y-0.5">
                <div class="flex items-center gap-1.5 text-[11px] flex-wrap">
                  <span class="tabular-nums font-medium ${isDue ? 'text-amber-200' : 'text-violet-light'}">${api.escapeHtml(ddmm)}</span>
                  <span class="text-white/40">·</span>
                  <span class="text-white/90 font-medium truncate">${api.escapeHtml(famName)}</span>
                  ${badgeHtml}
                </div>
                <p class="text-xs text-white/75 break-words">${api.escapeHtml(r.texto || '')}</p>
              </button>
              <button type="button" data-done-rec="${api.escapeAttr(r.id)}"
                class="shrink-0 px-2.5 py-1.5 rounded-xl border border-violet/40 text-[11px] font-medium text-violet-light hover:bg-violet/15">
                Hecho
              </button>
            </li>
          `;
        }).join('');
      }
    }

    // Lista de registros agrupada por día (más reciente primero)
    const regs = registrosDelMes(mes, activeFilter === 'all' ? null : activeFilter);
    if (listEl && emptyEl) {
      if (!regs.length) {
        listEl.innerHTML = '';
        emptyEl.classList.remove('hidden');
      } else {
        emptyEl.classList.add('hidden');
        const groups = {};
        for (const r of regs) {
          if (!groups[r.fecha]) groups[r.fecha] = [];
          groups[r.fecha].push(r);
        }
        const daysDesc = Object.keys(groups).sort().reverse();
        listEl.innerHTML = daysDesc.map((day) => {
          const dayItems = groups[day].slice().reverse().map((r) => {
            const fam = api.familyById(r.familyId);
            const dotColor = fam ? fam.color : '#6B7280';
            const famName = familyDisplayName(r.familyId);
            const tLabel = tipoLabel(r.tipo);
            const linCortos = normalizeLineas(r.lineas)
              .map((lid) => LINEAS.find((l) => l.id === lid)?.corto)
              .filter(Boolean)
              .join(' · ');
            return `
              <li class="rounded-xl bg-void/40 px-3 py-2.5 border border-white/5">
                <button type="button" data-edit-reg="${api.escapeAttr(r.id)}" class="w-full text-left space-y-1">
                  <div class="flex items-center gap-1.5 text-xs font-medium text-white/90 flex-wrap">
                    <span class="w-2 h-2 rounded-full shrink-0" style="background:${api.escapeAttr(dotColor)}"></span>
                    <span>${api.escapeHtml(famName)}</span>
                    <span class="text-white/40">·</span>
                    <span class="text-violet-light">${api.escapeHtml(tLabel)}</span>
                    ${r.noConcretada ? '<span class="text-white/40">·</span><span class="text-amber-300">no se concretó</span>' : ''}
                    ${linCortos ? '<span class="text-white/40">·</span><span class="text-white/60">' + api.escapeHtml(linCortos) + '</span>' : ''}
                  </div>
                  <p class="text-xs text-white/65 line-clamp-2 whitespace-pre-line break-words">${api.escapeHtml(r.texto || '')}</p>
                </button>
              </li>
            `;
          }).join('');
          return `
            <li class="space-y-2">
              <div class="text-[11px] text-white/40 px-1 pt-1">${api.escapeHtml(api.formatDate(day))}</div>
              <ul class="space-y-2">${dayItems}</ul>
            </li>
          `;
        }).join('');
      }
    }

    // Cierre del mes
    const exportables = familiasExportables(mes);
    if (cierreListEl) {
      if (!exportables.length) {
        cierreListEl.innerHTML = '<li class="text-xs text-white/40 py-2">Sin registros ni gastos por familia este mes.</li>';
      } else {
        cierreListEl.innerHTML = exportables.map((item) => {
          const regTxt = `${item.nRegistros} ${item.nRegistros === 1 ? 'registro' : 'registros'}`;
          const gastoTxt = item.nGastos > 0 ? ` · ${item.nGastos} ${item.nGastos === 1 ? 'gasto' : 'gastos'}` : '';
          let statusClass = 'text-white/45';
          if (item.estado.startsWith('✓')) statusClass = 'text-neon';
          else if (item.estado === 'cambios sin exportar') statusClass = 'text-amber-300';

          return `
            <li class="rounded-xl bg-void/40 px-3 py-2.5 border border-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div class="min-w-0">
                <p class="text-xs font-medium text-white/90 truncate">${api.escapeHtml(item.nombre)} · ${regTxt}${gastoTxt}</p>
                <p class="text-[11px] ${statusClass} mt-0.5">${api.escapeHtml(item.estado)}</p>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button type="button" data-reg-word="${api.escapeAttr(item.familyId)}"
                  class="px-2.5 py-1.5 rounded-xl border border-violet/40 text-xs font-medium text-violet-light hover:bg-violet/15">
                  Ficha Word
                </button>
                <button type="button" data-reg-export="${api.escapeAttr(item.familyId)}"
                  class="px-2.5 py-1.5 rounded-xl border border-violet/40 text-xs font-medium text-violet-light hover:bg-violet/15">
                  Exportar
                </button>
              </div>
            </li>
          `;
        }).join('');
      }
    }

    // Resumen de datos
    if (resumenEl) {
      const n = regState.registros.length;
      let rawLen = 0;
      try { rawLen = (localStorage.getItem(REG_KEY) || '').length; } catch (_) {}
      const kb = rawLen ? Math.max(1, Math.round(rawLen / 1024)) : 0;
      resumenEl.textContent = `${n} ${n === 1 ? 'registro guardado' : 'registros guardados'} · ${kb} KB`;
    }

    if (window.lucide) window.lucide.createIcons();
  }

  // ─── Init ──────────────────────────────────────────────────
  function init(appApi) {
    api = appApi;
    loadReg();

    try {
      navigator.storage?.persist?.();
    } catch (_) {}

    if (initialized) return;
    initialized = true;

    document.getElementById('btn-add-reg-home')?.addEventListener('click', () => openRegistroModal());
    document.getElementById('btn-add-reg')?.addEventListener('click', () => openRegistroModal());
    document.getElementById('btn-reg-datos')?.addEventListener('click', () => {
      if (activeFilter !== 'all') openFichaDatosModal(activeFilter);
    });
    document.getElementById('btn-add-rec')?.addEventListener('click', () => openRecordatorioModal());
    document.getElementById('btn-add-rec-empty')?.addEventListener('click', () => openRecordatorioModal());
    document.getElementById('reg-prev-month')?.addEventListener('click', () => api.shiftViewMonth(-1));
    document.getElementById('reg-next-month')?.addEventListener('click', () => api.shiftViewMonth(1));

    document.getElementById('reg-aviso')?.addEventListener('click', (e) => {
      const btn = e.currentTarget;
      const mes = btn.dataset.mes;
      const fid = btn.dataset.familyId;
      if (!mes || !fid) return;
      const [y, m] = mes.split('-').map(Number);
      if (!y || !m) return;
      activeFilter = fid;
      api.setView(y, m - 1);
    });

    document.getElementById('btn-reg-borrar-viejos')?.addEventListener('click', borrarMesesExportados);
    document.getElementById('btn-reg-borrar-todo')?.addEventListener('click', borrarTodoRegistros);

    document.getElementById('input-reg-restaurar')?.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) restaurarCierre(f);
      e.target.value = '';
    });

    document.getElementById('tab-reg')?.addEventListener('click', (e) => {
      const famBtn = e.target.closest('[data-reg-family]');
      if (famBtn) {
        activeFilter = famBtn.dataset.regFamily || 'all';
        render();
        return;
      }

      const editBtn = e.target.closest('[data-edit-reg]');
      if (editBtn) {
        const reg = regState.registros.find((r) => r.id === editBtn.dataset.editReg);
        if (reg) openRegistroModal(reg);
        return;
      }

      const editRecBtn = e.target.closest('[data-edit-rec]');
      if (editRecBtn) {
        const rec = regState.recordatorios.find((r) => r.id === editRecBtn.dataset.editRec);
        if (rec) openRecordatorioModal(rec);
        return;
      }

      const doneRecBtn = e.target.closest('[data-done-rec]');
      if (doneRecBtn) {
        marcarRecordatorioHecho(doneRecBtn.dataset.doneRec);
        return;
      }

      const wordBtn = e.target.closest('[data-reg-word]');
      if (wordBtn) {
        openFichaWordModal(wordBtn.dataset.regWord);
        return;
      }

      const expBtn = e.target.closest('[data-reg-export]');
      if (expBtn) {
        exportCierre(expBtn.dataset.regExport);
      }
    });

    // Asegura guardar el borrador pendiente antes de que closeModal() limpie el DOM.
    document.getElementById('modal-close')?.addEventListener('click', flushDraftNow, true);
    document.getElementById('modal-root')?.addEventListener('click', (e) => {
      if (e.target.id === 'modal-root') flushDraftNow();
    }, true);
    window.addEventListener('pagehide', flushDraftNow);
  }

  return { init, render, openRegistroModal };
})();
