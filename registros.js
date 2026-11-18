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
    { id: 'otro',         label: 'Otro' }
  ];

  const TIPO_IDS = new Set(TIPOS.map((t) => t.id));
  const LINEA_IDS = LINEAS.map((l) => l.id);

  let api = null;
  let regState = defaultRegState();
  let regCorrupt = false;
  let activeFilter = 'all';
  let initialized = false;

  let draftTimer = null;
  let lastDraftSaveMs = 0;
  let pendingDraft = null;

  function defaultRegState() {
    return {
      version: REG_VERSION,
      registros: [],
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
      regState = {
        version: REG_VERSION,
        registros: Array.isArray(p.registros) ? p.registros : [],
        exports: p.exports && typeof p.exports === 'object' && !Array.isArray(p.exports) ? p.exports : {},
        pendiente: p.pendiente && typeof p.pendiente === 'object' && !Array.isArray(p.pendiente) ? p.pendiente : {},
        ultimaFamiliaId: typeof p.ultimaFamiliaId === 'string' ? p.ultimaFamiliaId : null,
        borrador: p.borrador && typeof p.borrador === 'object' && !Array.isArray(p.borrador) ? p.borrador : null
      };
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
    const noConcretada = (tipo === 'visita' || tipo === 'llamada') ? Boolean(data.noConcretada) : false;
    const lineas = normalizeLineas(data.lineas);
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

    if (!saveReg()) {
      regState = JSON.parse(snapshot);
      return;
    }

    render();
    api.toast('Meses exportados borrados');
  }

  function borrarTodoRegistros() {
    if (!confirm('¿Borrar TODOS los registros de familias?')) return;
    if (!confirm('Confirmá: se borran todos los registros guardados en este celular.')) return;

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
    return {
      familyId: familySel ? familySel.value : '',
      fecha: fechaInp ? fechaInp.value : '',
      tipo,
      noConcretada: (tipo === 'visita' || tipo === 'llamada') && Boolean(noConcChk && noConcChk.checked),
      lineas: normalizeLineas([...lineaBtns].map((b) => b.dataset.regLinea)),
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

    const noConcWrap = form.querySelector('#reg-noconc-wrap');
    const noConcChk = form.querySelector('input[name="noConcretada"]');
    const showNoConc = tipo === 'visita' || tipo === 'llamada';
    if (noConcWrap) noConcWrap.classList.toggle('hidden', !showNoConc);
    if (noConcChk) noConcChk.checked = showNoConc ? Boolean(values.noConcretada) : false;

    const lineaSet = new Set(normalizeLineas(values.lineas));
    form.querySelectorAll('[data-reg-linea]').forEach((b) => {
      b.classList.toggle('active', lineaSet.has(b.dataset.regLinea));
    });

    const textoArea = form.querySelector('textarea[name="texto"]');
    if (textoArea) textoArea.value = values.texto || '';
  }

  function openRegistroModal(reg = null) {
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
    const hasDraft = !isEdit && Boolean(regState.borrador);
    const draft = hasDraft ? regState.borrador : null;

    let initFamilyId = '';
    if (isEdit) {
      initFamilyId = reg.familyId;
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
    const initTexto = isEdit ? (reg.texto || '') : ((draft && draft.texto) || '');

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

    const showNoConc = initTipo === 'visita' || initTipo === 'llamada';

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
        <div>
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
        const show = chosen === 'visita' || chosen === 'llamada';
        const wrap = form.querySelector('#reg-noconc-wrap');
        const chk = form.querySelector('input[name="noConcretada"]');
        if (wrap) wrap.classList.toggle('hidden', !show);
        if (!show && chk) chk.checked = false;
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
    const listEl = document.getElementById('reg-list');
    const emptyEl = document.getElementById('reg-empty');
    const cierreListEl = document.getElementById('reg-cierre-lista');
    const resumenEl = document.getElementById('reg-datos-resumen');

    if (regCorrupt) {
      if (avisoEl) { avisoEl.classList.add('hidden'); avisoEl.textContent = ''; }
      if (chipsEl) chipsEl.innerHTML = '';
      if (listEl) listEl.innerHTML = '';
      if (emptyEl) emptyEl.classList.remove('hidden');
      if (cierreListEl) cierreListEl.innerHTML = '';
      if (resumenEl) resumenEl.textContent = 'No se pudieron leer los registros';
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
            <li class="rounded-xl bg-void/40 px-3 py-2.5 border border-white/5 flex items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="text-xs font-medium text-white/90 truncate">${api.escapeHtml(item.nombre)} · ${regTxt}${gastoTxt}</p>
                <p class="text-[11px] ${statusClass} mt-0.5">${api.escapeHtml(item.estado)}</p>
              </div>
              <button type="button" data-reg-export="${api.escapeAttr(item.familyId)}"
                class="shrink-0 px-3 py-1.5 rounded-xl border border-violet/40 text-xs font-medium text-violet-light hover:bg-violet/15">
                Exportar
              </button>
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
