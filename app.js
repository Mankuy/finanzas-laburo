/**
 * Finanzas Laburo — PWA offline
 * Ingresos (quién) + Gastos (qué + familia) por mes
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'finanzas_laburo_v1';
  const FAMILY_COLORS = ['#8B5CF6', '#34D399', '#FB7185', '#FBBF24', '#38BDF8', '#A78BFA', '#F472B6', '#2DD4BF'];

  const SCHEMA_VERSION = 2;

  /** Rubros de equipo: gastos que NO son de una familia y van sin SIPI a la planilla. */
  const DEFAULT_TEAM_CATEGORIES = () => ([
    {
      id: 'team-locomocion',
      label: 'Locomocion equipo',
      keywords: ['nafta', 'combustible', 'gasoil', 'gasolina', 'super']
    },
    {
      id: 'team-equipo',
      label: 'Equipo',
      keywords: [
        'taxi', 'boleto', 'boletos', 'pasaje', 'pasajes', 'omnibus', 'remise', 'uber',
        'peaje', 'estacionamiento',
        'mouse', 'cuadernola', 'cuaderno', 'resma', 'tinta', 'cartucho',
        'libreria', 'papeleria', 'insumo', 'insumos', 'pila', 'pilas', 'cable'
      ]
    }
  ]);

  const DEFAULT_STATE = () => ({
    version: SCHEMA_VERSION,
    config: {
      name: '',
      currency: '$',
      technician: ''
    },
    families: [
      { id: 'fam-misc', name: 'Varios / sin familia', color: '#6B7280', active: true, children: [], sipis: [], sheetLabel: '' }
    ],
    teamCategories: DEFAULT_TEAM_CATEGORIES(),
    movements: [],
    // { id, type:'income'|'expense', amount, date:'YYYY-MM-DD',
    //   from?, what?, familyId?, sipi?, sipis?, teamCategoryId?, carryover?,
    //   note, createdAt, updatedAt, edited }
    auditLog: [],
    seenSipiSuggestion: false
  });

  /**
   * Migración v1 → v2. Solo AGREGA campos que faltan; nunca borra ni reescribe
   * lo que el usuario ya tiene guardado en su celular.
   */
  function migrate(p) {
    const base = DEFAULT_STATE();
    const out = {
      ...base,
      ...p,
      config: { ...base.config, ...(p.config || {}) },
      families: Array.isArray(p.families) && p.families.length ? p.families : base.families,
      teamCategories: Array.isArray(p.teamCategories) && p.teamCategories.length
        ? p.teamCategories.map((c) => (
            // El rubro pasó a escribirse con mayúscula. Solo se corrige el que
            // sigue con el texto original: si alguien lo renombró, se respeta.
            c.id === 'team-equipo' && c.label === 'equipo' ? { ...c, label: 'Equipo' } : c
          ))
        : base.teamCategories,
      movements: Array.isArray(p.movements) ? p.movements : [],
      auditLog: Array.isArray(p.auditLog) ? p.auditLog : []
    };
    out.families = out.families.map((f) => {
      let children = Array.isArray(f.children) ? f.children : [];
      if (!children.length) {
        const raw = Array.isArray(f.sipis) ? f.sipis : (f.sipi ? [String(f.sipi)] : []);
        children = raw.map((s, idx) => ({ id: 'ch-' + idx + '-' + String(s).trim(), name: '', sipi: String(s).trim() }));
      }
      // `children` queda como única fuente: se descartan los campos viejos para que
      // no puedan quedar desincronizados con la lista real de chiquilines.
      const { sipis, sipi, ...resto } = f;
      return {
        ...resto,
        children,
        sheetLabel: typeof f.sheetLabel === 'string' ? f.sheetLabel : ''
      };
    });
    out.movements = out.movements.map((m) => {
      const sipis = Array.isArray(m.sipis) ? m.sipis : (m.sipi ? [String(m.sipi)] : []);
      const { sipi, ...resto } = m;   // idem: el gasto guarda sus SIPI en un solo lugar
      return { ...resto, sipis };
    });
    out.version = SCHEMA_VERSION;
    return out;
  }

  let state = load();
  let viewYear, viewMonth; // 0-indexed month
  let moveFilter = 'all';
  {
    const now = new Date();
    viewYear = now.getFullYear();
    viewMonth = now.getMonth();
  }

  // ─── Persistence ───────────────────────────────────────────
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULT_STATE();
      const p = JSON.parse(raw);
      return migrate(p);
    } catch {
      return DEFAULT_STATE();
    }
  }

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() :
      'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function audit(action, detail, meta = {}) {
    state.auditLog.unshift({
      id: uid(),
      action,
      detail,
      at: new Date().toISOString(),
      meta
    });
    if (state.auditLog.length > 500) state.auditLog = state.auditLog.slice(0, 500);
  }

  // ─── Helpers ───────────────────────────────────────────────
  function cur() {
    return state.config.currency || '$';
  }

  function money(n) {
    const v = Number(n) || 0;
    const abs = Math.abs(v).toLocaleString('es-UY', {
      minimumFractionDigits: v % 1 ? 2 : 0,
      maximumFractionDigits: 2
    });
    const sign = v < 0 ? '−' : '';
    return sign + cur() + abs;
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, '&#39;');
  }

  function monthKey(y, m) {
    return y + '-' + String(m + 1).padStart(2, '0');
  }

  function monthLabel(y, m) {
    const d = new Date(y, m, 1);
    const s = d.toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function todayISO() {
    const d = new Date();
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  }

  /** Fecha por defecto al cargar un movimiento: hoy si es el mes en vista, si no el día 1 de ese mes. */
  function defaultDateForView() {
    const now = new Date();
    if (now.getFullYear() === viewYear && now.getMonth() === viewMonth) {
      return todayISO();
    }
    return monthKey(viewYear, viewMonth) + '-01';
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const [y, m, day] = iso.split('-').map(Number);
    const d = new Date(y, m - 1, day);
    return d.toLocaleDateString('es-UY', { weekday: 'short', day: '2-digit', month: 'short' });
  }

  /** Fecha como en la planilla: 04/08/2026. */
  function formatDateNum(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-');
    return `${d}/${m}/${y}`;
  }

  function formatDateTime(iso) {
    return new Date(iso).toLocaleString('es-UY', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    });
  }

  function movementsInView() {
    const key = monthKey(viewYear, viewMonth);
    return state.movements
      .filter((m) => (m.date || '').startsWith(key))
      .sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  }

  function monthTotals() {
    const list = movementsInView();
    let income = 0;
    let expense = 0;
    for (const m of list) {
      if (m.type === 'income') income += Number(m.amount) || 0;
      else expense += Number(m.amount) || 0;
    }
    return { income, expense, balance: income - expense, count: list.length, list };
  }

  // ─── Saldo que pasa de un mes al siguiente ─────────────────
  function monthBalanceOf(y, m) {
    const key = monthKey(y, m);
    let bal = 0;
    for (const mv of state.movements) {
      if (!(mv.date || '').startsWith(key)) continue;
      bal += mv.type === 'income' ? (Number(mv.amount) || 0) : -(Number(mv.amount) || 0);
    }
    return bal;
  }

  function prevMonthOf(y, m) {
    return m === 0 ? [y - 1, 11] : [y, m - 1];
  }

  /** El rótulo que ya usan las planillas para cualquier ingreso: "Ingreso Agosto". */
  function incomeConcept(y, m) {
    const name = new Date(y, m, 1).toLocaleDateString('es-UY', { month: 'long' });
    return 'Ingreso ' + name.charAt(0).toUpperCase() + name.slice(1);
  }

  /**
   * Deja el arrastre del mes al día: es un ingreso más, con el mismo nombre que
   * el resto ("Ingreso Setiembre"). Si lo editaste a mano queda congelado.
   */
  function syncCarryover(y, m) {
    const key = monthKey(y, m);
    const [py, pm] = prevMonthOf(y, m);
    const prevKey = monthKey(py, pm);
    if (!state.movements.some((mv) => (mv.date || '').startsWith(prevKey))) return false;

    const prevBal = Math.round(monthBalanceOf(py, pm) * 100) / 100;
    const existing = state.movements.find((mv) => mv.carryover && (mv.date || '').startsWith(key));

    if (existing) {
      if (existing.edited) return false;
      if (prevBal <= 0) {
        state.movements = state.movements.filter((x) => x.id !== existing.id);
        return true;
      }
      if (Number(existing.amount) === prevBal) return false;
      existing.amount = prevBal;
      existing.from = incomeConcept(y, m);
      existing.updatedAt = new Date().toISOString();
      return true;
    }

    if (prevBal <= 0) return false;
    const now = new Date().toISOString();
    state.movements.push({
      id: uid(),
      type: 'income',
      amount: prevBal,
      date: key + '-01',
      from: incomeConcept(y, m),
      what: '',
      familyId: null,
      teamCategoryId: null,
      sipis: [],
      note: 'Saldo que viene de ' + monthLabel(py, pm),
      carryover: true,
      edited: false,
      createdAt: now,
      updatedAt: now
    });
    return true;
  }

  /** Rehace la cadena completa, del mes más viejo al que estás mirando. */
  function syncAllCarryovers() {
    const keys = state.movements
      .filter((mv) => !mv.carryover && mv.date)
      .map((mv) => mv.date.slice(0, 7))
      .sort();
    if (!keys.length) return false;
    let [y, m] = keys[0].split('-').map(Number);
    m -= 1;
    const last = new Date(viewYear, viewMonth, 1);
    let changed = false;
    let cursor = new Date(y, m, 1);
    let guard = 0;
    // `<` y no `<=`: el incremento va adentro, así no se crea un arrastre en el mes siguiente.
    while (cursor < last && guard++ < 600) {
      cursor.setMonth(cursor.getMonth() + 1);
      if (syncCarryover(cursor.getFullYear(), cursor.getMonth())) changed = true;
    }
    return changed;
  }

  function familyById(id) {
    return state.families.find((f) => f.id === id);
  }

  /** Garantiza que la familia tenga su estructura children sincronizada con sipis. */
  function ensureFamilyChildren(f) {
    if (!f) return [];
    if (!Array.isArray(f.children)) f.children = [];
    if (!f.children.length && Array.isArray(f.sipis) && f.sipis.length) {
      f.children = f.sipis.map((s, idx) => ({ id: 'ch-' + idx + '-' + String(s).trim(), name: '', sipi: String(s).trim() }));
      delete f.sipis;
    }
    return f.children;
  }

  function familyName(id) {
    return familyById(id)?.name || 'Sin familia';
  }

  function teamCategoryById(id) {
    return state.teamCategories.find((c) => c.id === id);
  }

  /** Nombre tal cual va a la planilla: el rótulo propio si lo definiste, si no el nombre. */
  function familySheetLabel(f) {
    if (!f) return '';
    return (f.sheetLabel || '').trim() || f.name;
  }

  /** Etiqueta de planilla de cualquier gasto (familia o rubro de equipo). */
  function expenseSheetLabel(m) {
    if (m.teamCategoryId) return teamCategoryById(m.teamCategoryId)?.label || 'equipo';
    return familySheetLabel(familyById(m.familyId));
  }

  /**
   * SIPI que va a la planilla (primer SIPI o único).
   */
  function expenseSipi(m) {
    if (m.teamCategoryId) return '';
    if (Array.isArray(m.sipis) && m.sipis.length) return m.sipis[0];
    if (m.sipi) return m.sipi;
    const f = familyById(m.familyId);
    if (f) {
      const ch = ensureFamilyChildren(f);
      if (ch.length) return ch[0].sipi || '';
    }
    return '';
  }

  /**
   * Todos los SIPIs asignados a un gasto.
   */
  function expenseSipis(m) {
    if (m.teamCategoryId) return [];
    if (Array.isArray(m.sipis) && m.sipis.length) return m.sipis;
    if (m.sipi) return [m.sipi];
    // Un gasto viejo no tiene SIPI propio: se completa con el primero de la familia,
    // aunque tenga varios chiquilines. Es lo que ya salió en las rendiciones entregadas;
    // dejarlo vacío las pondría en desacuerdo con lo presentado.
    const f = familyById(m.familyId);
    if (f) {
      const ch = ensureFamilyChildren(f);
      if (ch.length) return [ch[0].sipi];
    }
    return [];
  }

  /**
   * Etiqueta amigable de los chiquilines/SIPIs para mostrar en la lista de movimientos.
   */
  function moveChildrenLabel(m) {
    if (m.teamCategoryId || !m.familyId) return '';
    const f = familyById(m.familyId);
    if (!f) return '';
    const sipis = expenseSipis(m);
    if (!sipis.length) return '';
    const ch = ensureFamilyChildren(f);
    if (ch.length > 1 && sipis.length === ch.length) {
      return 'Todos';
    }
    const names = sipis.map((s) => {
      const child = ch.find((c) => c.sipi === s);
      return child?.name || s;
    });
    return names.join(', ');
  }

  /** Clave con la que se agrupan los gastos: familia o rubro de equipo. */
  function moveGroupKey(m) {
    if (m.teamCategoryId) return 'team:' + m.teamCategoryId;
    return m.familyId || 'none';
  }

  /** Nombre y color de un grupo, sirva para familia o para rubro de equipo. */
  function groupMeta(key) {
    if (String(key).startsWith('team:')) {
      const c = teamCategoryById(String(key).slice(5));
      return { name: c?.label || 'equipo', color: '#A855F7' };
    }
    const f = familyById(key);
    return { name: f?.name || 'Sin familia', color: f?.color || '#6B7280' };
  }

  /** Cómo se llama el grupo del gasto dentro de la app (familia o rubro de equipo). */
  function moveGroupName(m) {
    if (m.teamCategoryId) return teamCategoryById(m.teamCategoryId)?.label || 'equipo';
    return familyName(m.familyId);
  }

  /** "Familia  Gómez " → "gomez". Saca tildes, el prefijo Familia/Famila y espacios de más. */
  function normalizeName(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/^\s*fam[ií]l?[ií]?a\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * SIPI leídos de las planillas que ya usa el equipo. Se ofrecen UNA vez, con
   * confirmación, y solo para familias que existan en este celular.
   */
  /**
   * Cruza una tabla de SIPI (la que viene en el archivo que carga el usuario) contra
   * las familias de este celular. Los SIPI NUNCA viven en el código: son datos de
   * chiquilines bajo protección y esto se publica en un repo abierto.
   * Solo devuelve familias que todavía no tienen SIPI, así nada se pisa.
   */

  /**
   * Familias que en realidad son un rubro de equipo, detectadas porque se llaman
   * igual que el rubro (ej. una familia "Equipo" y el rubro "equipo").
   */
  function pendingTeamMatches() {
    return state.families
      .map((f) => {
        // 1) La familia se llama igual que un rubro (ej. una familia "Equipo").
        let cat = state.teamCategories.find((c) => normalizeName(c.label) === normalizeName(f.name));

        // 2) O todos sus gastos apuntan al mismo rubro (ej. una familia "Facu"
        //    donde todo es nafta). Con un solo gasto no alcanza como evidencia.
        if (!cat) {
          const gastos = state.movements.filter((m) => m.type === 'expense' && m.familyId === f.id);
          if (gastos.length < 2) return null;
          const cats = new Set(gastos.map((m) => suggestTeamCategory(m.what)));
          const only = cats.size === 1 ? [...cats][0] : null;
          if (!only) return null;
          cat = teamCategoryById(only);
        }
        return cat
          ? { familyId: f.id, familyName: f.name, categoryId: cat.id, categoryLabel: cat.label }
          : null;
      })
      .filter(Boolean);
  }

  /** Rubro de equipo sugerido a partir de lo que escribiste en "¿En qué salió?". */
  function suggestTeamCategory(what) {
    const t = normalizeName(what);
    if (!t) return null;
    for (const c of state.teamCategories) {
      if ((c.keywords || []).some((k) => t.includes(normalizeName(k)))) return c.id;
    }
    return null;
  }

  // ─── CRUD movements ────────────────────────────────────────
  function upsertMovement(data, existingId = null) {
    const amount = Number(data.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast('Ingresá un monto válido');
      return false;
    }
    if (!data.date) {
      toast('Falta la fecha');
      return false;
    }
    const type = data.type === 'income' ? 'income' : 'expense';
    if (type === 'income' && !String(data.from || '').trim()) {
      toast('¿Quién te dio la plata?');
      return false;
    }
    if (type === 'expense' && !String(data.what || '').trim()) {
      toast('¿En qué salió?');
      return false;
    }

    // Un gasto va contra una familia (con SIPI) o contra un rubro de equipo (sin SIPI).
    const isTeam = type === 'expense' && String(data.familyId || '').startsWith('team:');
    const teamCategoryId = isTeam ? String(data.familyId).slice(5) : null;

    let moveSipis = [];
    if (type === 'expense' && !isTeam) {
      if (Array.isArray(data.sipis) && data.sipis.length) {
        moveSipis = data.sipis.map(String).map((s) => s.trim()).filter(Boolean);
      } else if (data.sipi) {
        const s = String(data.sipi).trim();
        if (s) moveSipis = [s];
      }
    }

    const now = new Date().toISOString();
    const payload = {
      type,
      amount: Math.round(amount * 100) / 100,
      date: data.date,
      from: type === 'income' ? String(data.from || '').trim() : '',
      what: type === 'expense' ? String(data.what || '').trim() : '',
      familyId: type === 'expense' && !isTeam ? (data.familyId || null) : null,
      teamCategoryId,
      sipis: moveSipis,
      sipi: moveSipis[0] || '',
      note: String(data.note || '').trim()
    };

    if (payload.familyId) {
      const f = familyById(payload.familyId);
      if (f) {
        const ch = ensureFamilyChildren(f);
        if (!payload.sipis.length && ch.length === 1) {
          payload.sipis = [ch[0].sipi];
        } else if (payload.sipis.length) {
          for (const s of payload.sipis) {
            if (s && !ch.some((c) => c.sipi === s)) {
              ch.push({ id: uid(), name: '', sipi: s });
              audit('add_sipi', `SIPI ${s} → ${f.name}`, { id: f.id });
            }
          }
        }
      }
    }

    if (existingId) {
      const idx = state.movements.findIndex((m) => m.id === existingId);
      if (idx === -1) return false;
      const prev = { ...state.movements[idx] };
      state.movements[idx] = {
        ...state.movements[idx],
        ...payload,
        edited: true,
        updatedAt: now
      };
      audit('edit_move', `Editó ${type === 'income' ? 'entrada' : 'gasto'} ${money(payload.amount)}`, {
        id: existingId, before: prev, after: payload
      });
    } else {
      const m = {
        id: uid(),
        ...payload,
        edited: false,
        createdAt: now,
        updatedAt: now
      };
      state.movements.unshift(m);
      audit(
        type === 'income' ? 'income' : 'expense',
        type === 'income'
          ? `+ ${money(m.amount)} de ${m.from}`
          : `− ${money(m.amount)} · ${m.what} · ${moveGroupName(m)}`,
        { id: m.id }
      );
    }
    save();
    render();
    toast(existingId ? 'Movimiento actualizado' : 'Guardado');
    return true;
  }

  function deleteMovement(id) {
    const m = state.movements.find((x) => x.id === id);
    if (!m) return;
    if (!confirm('¿Borrar este movimiento? Queda en el log.')) return;
    state.movements = state.movements.filter((x) => x.id !== id);
    audit('delete_move', `Borró ${m.type} ${money(m.amount)}`, { snapshot: m });
    save();
    render();
    toast('Borrado');
  }

  // ─── Families ──────────────────────────────────────────────
  function addFamily(dataOrName) {
    const isObj = typeof dataOrName === 'object' && dataOrName !== null;
    const n = String(isObj ? dataOrName.name : dataOrName || '').trim();
    if (!n) {
      toast('Nombre vacío');
      return false;
    }
    const color = FAMILY_COLORS[state.families.length % FAMILY_COLORS.length];
    const children = isObj && Array.isArray(dataOrName.children) ? dataOrName.children : [];
    const sipis = children.map((c) => String(c.sipi || '').trim()).filter(Boolean);
    const f = {
      id: uid(),
      name: n,
      color,
      active: true,
      children,
      sipis,
      sheetLabel: isObj && dataOrName.sheetLabel ? String(dataOrName.sheetLabel).trim() : ''
    };
    state.families.push(f);
    audit('add_family', `Familia: ${n}`, { id: f.id });
    save();
    render();
    toast('Familia agregada');
    return true;
  }

  function updateFamily(id, data) {
    const f = familyById(id);
    if (!f) return;
    const n = String(data.name || '').trim();
    if (!n) return;
    const before = {
      name: f.name,
      children: JSON.parse(JSON.stringify(f.children || [])),
      sheetLabel: f.sheetLabel || ''
    };
    f.name = n;
    if (Array.isArray(data.children)) {
      f.children = data.children;
    } else if (data.sipis !== undefined) {
      const raw = String(data.sipis || '')
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      f.children = raw.map((s, idx) => ({ id: 'ch-' + idx + '-' + s, name: '', sipi: s }));
    }
    f.sheetLabel = String(data.sheetLabel || '').trim();
    audit('edit_family', `Editó familia ${n}`, {
      id,
      before,
      after: { name: f.name, children: f.children, sipis: f.sipis, sheetLabel: f.sheetLabel }
    });
    save();
    render();
    toast('Familia actualizada');
  }

  /**
   * Pasa una "familia" que en realidad era un gasto de equipo (ej. la nafta cargada
   * como familia "Facu") al rubro que corresponda. Los movimientos no se pierden:
   * cambian de grupo y quedan sin SIPI, como van en la planilla.
   */
  function convertFamilyToTeam(id, teamCategoryId, opts = {}) {
    const f = familyById(id);
    const cat = teamCategoryById(teamCategoryId);
    if (!f || !cat) return;
    const affected = state.movements.filter((m) => m.familyId === id);
    if (!opts.skipConfirm &&
        !confirm(`¿Pasar "${f.name}" a "${cat.label}"? Son ${affected.length} movimiento(s), no se borra ninguno.`)) return;
    for (const m of affected) {
      m.familyId = null;
      m.teamCategoryId = teamCategoryId;
      m.sipis = [];
      m.updatedAt = new Date().toISOString();
    }
    if (id !== 'fam-misc') state.families = state.families.filter((x) => x.id !== id);
    audit('family_to_team', `"${f.name}" pasó a rubro de equipo "${cat.label}"`, {
      id, teamCategoryId, moved: affected.length
    });
    save();
    render();
    toast(`${affected.length} movimiento(s) pasaron a ${cat.label}`);
  }

  function deleteFamily(id) {
    if (id === 'fam-misc') {
      toast('Esa no se puede borrar');
      return;
    }
    const f = familyById(id);
    if (!f) return;
    if (!confirm(`¿Borrar familia "${f.name}"? Los gastos quedan sin reasignar (se muestran como "Sin familia").`)) return;
    state.families = state.families.filter((x) => x.id !== id);
    audit('delete_family', `Borró familia ${f.name}`, { id });
    save();
    render();
    toast('Familia borrada');
  }

  // ─── UI toast / modal ──────────────────────────────────────
  let toastTimer = null;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('opacity-0');
    el.classList.add('opacity-100');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.add('opacity-0');
      el.classList.remove('opacity-100');
    }, 2500);
  }

  function openModal(title, html) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    const root = document.getElementById('modal-root');
    root.classList.remove('hidden');
    root.classList.add('flex');
    lucide.createIcons({ nodes: [document.getElementById('modal-panel')] });
  }

  function closeModal() {
    const root = document.getElementById('modal-root');
    root.classList.add('hidden');
    root.classList.remove('flex');
    document.getElementById('modal-body').innerHTML = '';
  }

  function familyOptions(selected) {
    const fams = state.families
      .filter((f) => f.active !== false)
      .map((f) => `<option value="${escapeAttr(f.id)}" ${f.id === selected ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
      .join('');
    const teams = state.teamCategories
      .map((c) => {
        const v = 'team:' + c.id;
        return `<option value="${escapeAttr(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(c.label)}</option>`;
      })
      .join('');
    return `<optgroup label="Familias">${fams}</optgroup><optgroup label="Equipo (sin SIPI)">${teams}</optgroup>`;
  }

  /** Valor del <select> para un gasto ya guardado. */
  function moveGroupValue(m) {
    if (!m) return 'fam-misc';
    if (m.teamCategoryId) return 'team:' + m.teamCategoryId;
    return m.familyId || 'fam-misc';
  }

  /**
   * Bloque SIPI del formulario de gasto. Se redibuja al cambiar de familia:
   * - equipo → nada
   * - familia con 1 chiquilín/SIPI → indicador informativo (se asigna directo)
   * - familia con varios → casillas de verificación (uno, varios o todos)
   * - familia sin SIPI → input para cargarlo y guardarlo en la familia
   */
  function sipiFieldHtml(groupValue, currentSipis) {
    if (!groupValue || groupValue.startsWith('team:')) return '';
    const f = familyById(groupValue);
    if (!f) return '';
    const children = ensureFamilyChildren(f);

    const activeSipis = Array.isArray(currentSipis)
      ? currentSipis.map(String).filter(Boolean)
      : (currentSipis ? [String(currentSipis).trim()].filter(Boolean) : []);

    if (children.length === 0) {
      const singleVal = activeSipis[0] || '';
      return `
        <div>
          <label class="block text-xs text-white/50 mb-1">SIPI de ${escapeHtml(f.name || 'la familia')}</label>
          <input name="sipi" type="text" inputmode="numeric" maxlength="20" value="${escapeAttr(singleVal)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. 123456" />
          <p class="text-[10px] text-white/35 mt-1">Se guarda en la familia. No te lo vuelve a pedir.</p>
        </div>
      `;
    }

    if (children.length === 1) {
      const ch = children[0];
      const namePart = ch.name ? `${escapeHtml(ch.name)} · ` : '';
      return `
        <div class="rounded-xl bg-void/40 px-3 py-2 border border-white/5 flex items-center justify-between text-xs">
          <span class="text-white/40">Imputa a:</span>
          <span class="text-white/80 tabular-nums font-medium">${namePart}SIPI ${escapeHtml(ch.sipi)}</span>
        </div>
      `;
    }

    // Familia con varios chiquilines: casillas con Nombre · SIPI y botón Todos
    // Arrancan desmarcadas a propósito: marcar todos por defecto hace fácil imputarle
    // un gasto a un chiquilín que no correspondía sin darse cuenta, y eso se descubre
    // tarde. Elegir es un toque más; la validación no deja guardar sin ninguno.
    const selectedSet = new Set(activeSipis);
    const allChecked = children.every((c) => selectedSet.has(c.sipi));

    return `
      <div class="space-y-2 bg-void/40 p-3 rounded-xl border border-violet/20">
        <div class="flex items-center justify-between">
          <label class="block text-xs font-medium text-white/70">¿A quién(es) corresponde?</label>
          <button type="button" id="btn-toggle-all-sipis" class="text-[11px] text-violet-light hover:text-white font-medium transition">
            ${allChecked ? 'Desmarcar todos' : 'Marcar todos'}
          </button>
        </div>
        <div class="space-y-1.5" id="sipi-checkboxes-group">
          ${children.map((c) => {
            const isChecked = selectedSet.has(c.sipi);
            const namePart = c.name ? `<span class="font-medium text-white">${escapeHtml(c.name)}</span>` : '';
            const sipiPart = `<span class="text-white/40 tabular-nums text-[11px]">SIPI ${escapeHtml(c.sipi)}</span>`;
            const fullLabel = c.name ? `${namePart} <span class="text-white/30">·</span> ${sipiPart}` : `<span class="text-white/80 tabular-nums">SIPI ${escapeHtml(c.sipi)}</span>`;
            return `
              <label class="flex items-center gap-2.5 p-2 rounded-lg bg-void/60 border border-white/5 hover:border-violet/30 cursor-pointer select-none transition">
                <input type="checkbox" name="move_sipis" value="${escapeAttr(c.sipi)}" class="sipi-move-chk w-4 h-4 rounded accent-violet-light cursor-pointer opacity-80" ${isChecked ? 'checked' : ''} />
                <span class="text-xs flex-1 flex items-center gap-1.5">${fullLabel}</span>
              </label>
            `;
          }).join('')}
        </div>
        <p class="text-[10px] text-white/35">Elegí uno, varios o todos. Se rinde en renglones separados por SIPI.</p>
      </div>
    `;
  }

  function movementFormHtml(type, m = null) {
    const isIncome = type === 'income';
    const date = m?.date || defaultDateForView();
    const amount = m ? m.amount : '';
    const note = m?.note || '';
    if (isIncome) {
      return `
        <form id="move-form" class="space-y-4" data-type="income" data-id="${m ? m.id : ''}">
          <div>
            <label class="block text-xs text-white/50 mb-1">Monto</label>
            <input name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${escapeAttr(amount)}"
              class="w-full bg-void/60 border border-neon/30 rounded-xl px-3 py-3 text-lg tabular-nums focus:outline-none focus:border-neon" placeholder="0" />
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">¿Quién te dio la plata?</label>
            <input name="from" type="text" required maxlength="80" value="${escapeAttr(m?.from || '')}"
              class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
              placeholder="Ej. Caro" />
            <p class="text-[10px] text-white/35 mt-1">Es para vos: en la planilla va como «${escapeHtml(incomeConcept(viewYear, viewMonth))}», sin importar quién.</p>
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Día (fecha del movimiento)</label>
            <input name="date" type="date" required value="${escapeAttr(date)}"
              class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
            <p class="text-[10px] text-white/35 mt-1">El resumen usa solo los movimientos de ese mes. El saldo que sobra pasa al siguiente.</p>
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Nota (opcional, solo para vos)</label>
            <input name="note" type="text" maxlength="160" value="${escapeAttr(note)}"
              class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
              placeholder="Ej. pago parcial" />
          </div>
          <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-emerald-500 to-emerald-700 font-semibold text-sm">
            ${m ? 'Guardar cambios' : 'Registrar entrada'}
          </button>
          ${m ? `<button type="button" id="btn-del-move" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>` : ''}
        </form>
      `;
    }
    return `
      <form id="move-form" class="space-y-4" data-type="expense" data-id="${m ? m.id : ''}">
        <div>
          <label class="block text-xs text-white/50 mb-1">Monto</label>
          <input name="amount" type="number" min="0.01" step="0.01" required inputmode="decimal" value="${escapeAttr(amount)}"
            class="w-full bg-void/60 border border-rose/30 rounded-xl px-3 py-3 text-lg tabular-nums focus:outline-none focus:border-rose" placeholder="0" />
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">¿En qué salió?</label>
          <input name="what" id="move-what" type="text" required maxlength="100" value="${escapeAttr(m?.what || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. surtido, ferretería, nafta…" />
          <p class="text-[10px] text-white/35 mt-1">Es para vos: en la planilla va la familia o el rubro, no este detalle.</p>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Familia/equipo</label>
          <select name="familyId" id="move-group"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">
            ${familyOptions(moveGroupValue(m))}
          </select>
        </div>
        <div id="sipi-slot">${sipiFieldHtml(moveGroupValue(m), m?.sipis || m?.sipi)}</div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Día (fecha del movimiento)</label>
          <input name="date" type="date" required value="${escapeAttr(date)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
          <p class="text-[10px] text-white/35 mt-1">El resumen usa solo los movimientos de ese mes. El saldo que sobra pasa al siguiente.</p>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Nota (opcional, solo para vos)</label>
          <input name="note" type="text" maxlength="160" value="${escapeAttr(note)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-rose-500 to-rose-700 font-semibold text-sm">
          ${m ? 'Guardar cambios' : 'Registrar gasto'}
        </button>
        ${m ? `<button type="button" id="btn-del-move" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>` : ''}
      </form>
    `;
  }

  function openMoveModal(type, m = null) {
    openModal(
      m ? 'Editar movimiento' : (type === 'income' ? 'Nueva entrada' : 'Nuevo gasto'),
      movementFormHtml(type, m)
    );
    const form = document.getElementById('move-form');

    // El campo SIPI depende de la familia elegida, así que se redibuja al cambiarla.
    const groupSel = document.getElementById('move-group');
    const whatInput = document.getElementById('move-what');
    const sipiSlot = document.getElementById('sipi-slot');
    let groupTouched = Boolean(m); // editando un gasto viejo no auto-sugerimos nada
    if (groupSel && sipiSlot) {
      groupSel.addEventListener('change', () => {
        groupTouched = true;
        sipiSlot.innerHTML = sipiFieldHtml(groupSel.value, m?.sipis || m?.sipi);
      });
    }

    if (sipiSlot) {
      sipiSlot.addEventListener('click', (e) => {
        const btn = e.target.closest('#btn-toggle-all-sipis');
        if (!btn) return;
        const chks = sipiSlot.querySelectorAll('.sipi-move-chk');
        const allChecked = [...chks].every((c) => c.checked);
        chks.forEach((c) => { c.checked = !allChecked; });
        btn.textContent = allChecked ? 'Marcar todos' : 'Desmarcar todos';
      });

      sipiSlot.addEventListener('change', (e) => {
        if (!e.target.classList.contains('sipi-move-chk')) return;
        const btn = sipiSlot.querySelector('#btn-toggle-all-sipis');
        if (!btn) return;
        const chks = sipiSlot.querySelectorAll('.sipi-move-chk');
        const allChecked = [...chks].every((c) => c.checked);
        btn.textContent = allChecked ? 'Desmarcar todos' : 'Marcar todos';
      });
    }

    // "nafta" → Locomocion equipo, "boletos" → equipo. Solo mientras no toques el selector.
    if (whatInput && groupSel && sipiSlot) {
      whatInput.addEventListener('input', () => {
        if (groupTouched) return;
        const sug = suggestTeamCategory(whatInput.value);
        if (sug && groupSel.value !== 'team:' + sug) {
          groupSel.value = 'team:' + sug;
          sipiSlot.innerHTML = '';
        }
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const moveType = form.dataset.type;
      const groupVal = fd.get('familyId');
      const isTeam = moveType === 'expense' && String(groupVal || '').startsWith('team:');

      let sipis = [];
      if (moveType === 'expense' && !isTeam) {
        const chks = form.querySelectorAll('.sipi-move-chk');
        if (chks.length > 0) {
          sipis = [...chks].filter((c) => c.checked).map((c) => c.value);
          if (!sipis.length) {
            toast('Seleccioná al menos un chiquilín / SIPI');
            return;
          }
        } else {
          const singleSipi = String(fd.get('sipi') || '').trim();
          if (singleSipi) sipis = [singleSipi];
        }
      }

      const ok = upsertMovement({
        type: moveType,
        amount: fd.get('amount'),
        date: fd.get('date'),
        from: fd.get('from'),
        what: fd.get('what'),
        familyId: fd.get('familyId'),
        sipi: sipis[0] || fd.get('sipi') || '',
        sipis,
        note: fd.get('note')
      }, form.dataset.id || null);
      if (ok) closeModal();
    });
    document.getElementById('btn-del-move')?.addEventListener('click', () => {
      deleteMovement(form.dataset.id);
      closeModal();
    });
  }

  function openFamilyModal(f = null) {
    const children = f ? ensureFamilyChildren(f) : [];

    function renderChildRow(c = { id: '', name: '', sipi: '' }) {
      const cid = c.id || uid();
      return `
        <div class="child-row flex items-center gap-2 bg-void/40 p-2 rounded-xl border border-white/5" data-id="${escapeAttr(cid)}">
          <input type="text" name="child_name" placeholder="Nombre (ej. Valentín)" value="${escapeAttr(c.name || '')}"
            class="flex-1 min-w-0 bg-void/60 border border-violet/30 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-white/30 focus:outline-none focus:border-violet-light" />
          <input type="text" name="child_sipi" inputmode="numeric" placeholder="SIPI (ej. 700963)" value="${escapeAttr(c.sipi || '')}"
            class="w-28 sm:w-32 bg-void/60 border border-violet/30 rounded-lg px-2.5 py-1.5 text-xs text-white tabular-nums placeholder-white/30 focus:outline-none focus:border-violet-light" />
          <button type="button" class="btn-remove-child p-1.5 text-white/40 hover:text-red-400 shrink-0" title="Quitar">
            <i data-lucide="trash-2" class="w-3.5 h-3.5 pointer-events-none"></i>
          </button>
        </div>
      `;
    }

    const initialRows = children.length
      ? children.map(renderChildRow).join('')
      : renderChildRow();

    openModal(f ? 'Editar familia' : 'Nueva familia', `
      <form id="fam-form" class="space-y-4">
        <div>
          <label class="block text-xs text-white/50 mb-1">Nombre</label>
          <input name="name" type="text" required maxlength="60" value="${escapeAttr(f?.name || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. Familia Pérez" />
        </div>
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-xs text-white/50">Chiquilines (nombre y SIPI)</label>
            <button type="button" id="btn-add-child-row" class="text-xs text-violet-light hover:text-white flex items-center gap-1 font-medium transition">
              <i data-lucide="plus" class="w-3.5 h-3.5 pointer-events-none"></i> Agregar
            </button>
          </div>
          <div id="children-list-container" class="space-y-2">
            ${initialRows}
          </div>
          <p class="text-[10px] text-white/35 mt-1.5">El nombre es opcional. Sirve para reconocerlo fácil al cargar gastos (ej. "Valentín · 700963").</p>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Nombre en la planilla (opcional)</label>
          <input name="sheetLabel" type="text" maxlength="80" value="${escapeAttr(f?.sheetLabel || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="${escapeAttr(f?.name || 'Ej. Familia Pérez')}" />
          <p class="text-[10px] text-white/35 mt-1">Cómo querés que salga en la columna CONCEPTO. Si lo dejás vacío usa el nombre.</p>
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
          ${f ? 'Guardar' : 'Agregar'}
        </button>
      </form>
      ${f && f.id !== 'fam-misc' ? `
      <div class="mt-5 pt-4 border-t border-white/10">
        <button type="button" id="btn-del-fam" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>
      </div>` : ''}
    `);

    if (window.lucide) window.lucide.createIcons();

    const container = document.getElementById('children-list-container');
    document.getElementById('btn-add-child-row')?.addEventListener('click', () => {
      container.insertAdjacentHTML('beforeend', renderChildRow());
      if (window.lucide) window.lucide.createIcons();
    });

    container?.addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-remove-child');
      if (!btn) return;
      const row = btn.closest('.child-row');
      const allRows = container.querySelectorAll('.child-row');
      if (allRows.length <= 1) {
        row.querySelectorAll('input').forEach((inp) => { inp.value = ''; });
      } else {
        row.remove();
      }
    });

    document.getElementById('fam-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const childRows = document.querySelectorAll('#children-list-container .child-row');
      const parsedChildren = [];
      childRows.forEach((row) => {
        const name = (row.querySelector('input[name="child_name"]')?.value || '').trim();
        const sipi = (row.querySelector('input[name="child_sipi"]')?.value || '').trim();
        if (sipi || name) {
          parsedChildren.push({ id: row.dataset.id || uid(), name, sipi });
        }
      });

      if (f) {
        updateFamily(f.id, {
          name: fd.get('name'),
          children: parsedChildren,
          sheetLabel: fd.get('sheetLabel')
        });
      } else {
        addFamily({
          name: fd.get('name'),
          children: parsedChildren,
          sheetLabel: fd.get('sheetLabel')
        });
      }
      closeModal();
    });

    if (f) {
      document.getElementById('btn-del-fam')?.addEventListener('click', () => {
        deleteFamily(f.id);
        closeModal();
      });
    }
  }

  // ─── Render ────────────────────────────────────────────────
  function moveRowHtml(m) {
    const isIn = m.type === 'income';
    const color = isIn ? 'text-neon' : 'text-rose';
    const sign = isIn ? '+' : '−';
    const title = isIn ? (m.from || 'Entrada') : (m.what || 'Gasto');
    const chLabel = moveChildrenLabel(m);
    const sub = isIn
      ? (m.carryover ? 'Saldo del mes anterior' : (m.note || 'Ingreso'))
      : `${moveGroupName(m)}${chLabel ? ' · ' + chLabel : ''}${m.note ? ' · ' + m.note : ''}`;
    const dotColor = isIn ? null : groupMeta(moveGroupKey(m)).color;
    const dot = dotColor
      ? `<span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${dotColor}"></span>`
      : '';
    return `
      <li class="rounded-xl bg-void/40 px-3 py-2.5 border border-white/5 flex items-center gap-2">
        <button type="button" data-edit-move="${m.id}" class="flex-1 min-w-0 text-left">
          <div class="flex justify-between gap-2">
            <p class="text-sm font-medium truncate">${escapeHtml(title)}</p>
            <span class="tabular-nums font-semibold ${color} shrink-0">${sign}${money(m.amount)}</span>
          </div>
          <p class="text-[11px] text-white/40 truncate mt-0.5">
            ${dot}${escapeHtml(sub)} · ${formatDate(m.date)}
            ${m.edited ? ' · <span class="text-amber-300">editado</span>' : ''}
          </p>
        </button>
      </li>
    `;
  }

  function renderHome() {
    const t = monthTotals();
    document.getElementById('month-label').textContent = monthLabel(viewYear, viewMonth);
    document.getElementById('month-balance').textContent = money(t.balance);
    document.getElementById('month-balance').className =
      'text-4xl font-bold tabular-nums text-center tracking-tight ' +
      (t.balance >= 0 ? 'text-neon' : 'text-rose');
    document.getElementById('month-income').textContent = money(t.income);
    document.getElementById('month-expense').textContent = money(t.expense);
    document.getElementById('month-count').textContent =
      t.count + (t.count === 1 ? ' movimiento' : ' movimientos');
    document.getElementById('sheets-month').textContent = monthLabel(viewYear, viewMonth);

    const total = t.income + t.expense;
    const pi = total > 0 ? (t.income / total) * 100 : 50;
    const pe = total > 0 ? (t.expense / total) * 100 : 50;
    document.getElementById('bar-income').style.width = pi + '%';
    document.getElementById('bar-expense').style.width = pe + '%';

    const recent = t.list.slice(0, 6);
    const ul = document.getElementById('home-recent');
    const empty = document.getElementById('home-empty');
    if (!recent.length) {
      ul.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      ul.innerHTML = recent.map(moveRowHtml).join('');
    }

    // family breakdown
    const byFam = {};
    for (const m of t.list.filter((x) => x.type === 'expense')) {
      const id = moveGroupKey(m);
      byFam[id] = (byFam[id] || 0) + Number(m.amount);
    }
    // Los gastos de familia y los del equipo se muestran por separado: son dos
    // cosas distintas y mezclarlas obligaba a leer la lista entera para saber cuál
    // es cuál.
    const todas = Object.entries(byFam).sort((a, b) => b[1] - a[1]);
    const pintarLista = (ulId, emptyId, entries) => {
      const ul = document.getElementById(ulId);
      const empty = document.getElementById(emptyId);
      if (!entries.length) {
        ul.innerHTML = '';
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      const max = entries[0][1] || 1;
      ul.innerHTML = entries.map(([id, amt]) => {
        const { name, color } = groupMeta(id);
        const pct = Math.round((amt / max) * 100);
        return `
          <li>
            <div class="flex justify-between text-xs mb-1">
              <span class="truncate flex items-center gap-1.5">
                <span class="w-2 h-2 rounded-full shrink-0" style="background:${color}"></span>
                ${escapeHtml(name)}
              </span>
              <span class="tabular-nums text-rose">${money(amt)}</span>
            </div>
            <div class="h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div class="h-full rounded-full bar-fill" style="width:${pct}%;background:${color}"></div>
            </div>
          </li>
        `;
      }).join('');
    };
    pintarLista('home-families', 'home-fam-empty', todas.filter(([id]) => !String(id).startsWith('team:')));
    pintarLista('home-team', 'home-team-empty', todas.filter(([id]) => String(id).startsWith('team:')));
  }

  function renderMoves() {
    document.getElementById('moves-month-label').textContent = monthLabel(viewYear, viewMonth);
    document.querySelectorAll('.move-filter').forEach((b) => {
      b.classList.toggle('active', b.dataset.moveFilter === moveFilter);
    });
    let list = movementsInView();
    if (moveFilter !== 'all') list = list.filter((m) => m.type === moveFilter);
    const ul = document.getElementById('moves-list');
    const empty = document.getElementById('moves-empty');
    if (!list.length) {
      ul.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      // group by day
      const groups = {};
      for (const m of list) {
        if (!groups[m.date]) groups[m.date] = [];
        groups[m.date].push(m);
      }
      ul.innerHTML = Object.keys(groups).sort().reverse().map((day) => {
        const dayTotal = groups[day].reduce((a, m) =>
          a + (m.type === 'income' ? Number(m.amount) : -Number(m.amount)), 0);
        return `
          <li class="space-y-2">
            <div class="flex justify-between text-[11px] text-white/40 px-1 pt-1">
              <span>${formatDate(day)}</span>
              <span class="tabular-nums ${dayTotal >= 0 ? 'text-neon/70' : 'text-rose/70'}">${money(dayTotal)}</span>
            </div>
            <ul class="space-y-2">${groups[day].map(moveRowHtml).join('')}</ul>
          </li>
        `;
      }).join('');
    }
  }

  // ─── Rubros del equipo ─────────────────────────────────────
  function addTeamCategory(label) {
    const l = String(label || '').trim();
    if (!l) { toast('Poné un nombre'); return false; }
    if (state.teamCategories.some((c) => normalizeName(c.label) === normalizeName(l))) {
      toast('Ya existe un rubro con ese nombre');
      return false;
    }
    const c = { id: uid(), label: l, keywords: [] };
    state.teamCategories.push(c);
    audit('add_team', `Rubro de equipo: ${l}`, { id: c.id });
    save();
    render();
    toast('Rubro agregado');
    return true;
  }

  function updateTeamCategory(id, label) {
    const c = teamCategoryById(id);
    const l = String(label || '').trim();
    if (!c || !l) return;
    const before = c.label;
    c.label = l;
    audit('edit_team', `Rubro ${before} → ${l}`, { id });
    save();
    render();
    toast('Rubro actualizado');
  }

  /** Borrar un rubro no borra sus gastos: quedan sin rubro y se ven al exportar. */
  function deleteTeamCategory(id) {
    const c = teamCategoryById(id);
    if (!c) return;
    const usados = state.movements.filter((m) => m.teamCategoryId === id).length;
    if (state.teamCategories.length === 1) { toast('Tiene que quedar al menos un rubro'); return; }
    if (!confirm(usados
      ? `¿Borrar "${c.label}"? Tiene ${usados} gasto(s); no se borran, quedan sin rubro.`
      : `¿Borrar "${c.label}"?`)) return;
    state.teamCategories = state.teamCategories.filter((x) => x.id !== id);
    audit('delete_team', `Borró el rubro ${c.label}`, { id, usados });
    save();
    render();
    toast('Rubro borrado');
  }

  function openTeamModal(c = null) {
    openModal(c ? 'Editar rubro' : 'Nuevo rubro', `
      <form id="team-form" class="space-y-4">
        <div>
          <label class="block text-xs text-white/50 mb-1">Nombre</label>
          <input name="label" type="text" required maxlength="60" value="${escapeAttr(c?.label || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. Locomocion equipo" />
          <p class="text-[10px] text-white/35 mt-1">Así sale en la columna CONCEPTO de la planilla.</p>
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
          ${c ? 'Guardar' : 'Agregar'}
        </button>
      </form>
      ${c ? `<button type="button" id="btn-del-team" class="w-full py-3 mt-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>` : ''}
    `);
    document.getElementById('team-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const l = new FormData(e.target).get('label');
      if (c) updateTeamCategory(c.id, l); else addTeamCategory(l);
      closeModal();
    });
    document.getElementById('btn-del-team')?.addEventListener('click', () => {
      deleteTeamCategory(c.id);
      closeModal();
    });
  }

  function renderTeam() {
    const ul = document.getElementById('team-list');
    ul.innerHTML = state.teamCategories.map((c) => {
      const usados = state.movements.filter((m) => m.teamCategoryId === c.id).length;
      return `
        <li class="rounded-xl bg-void/40 px-3 py-3 border border-white/5 flex items-center justify-between gap-2">
          <button type="button" data-edit-team="${escapeAttr(c.id)}" class="flex items-center gap-2 min-w-0 text-left flex-1">
            <span class="w-3 h-3 rounded-full shrink-0" style="background:#A855F7"></span>
            <span class="min-w-0">
              <span class="text-sm truncate block">${escapeHtml(c.label)}</span>
              <span class="text-[10px] text-white/40 block">${usados} gasto(s)</span>
            </span>
          </button>
          <i data-lucide="pencil" class="w-3.5 h-3.5 text-violet-light/60 shrink-0 pointer-events-none"></i>
        </li>
      `;
    }).join('');

    const t = monthTotals();
    const porRubro = {};
    for (const m of t.list.filter((x) => x.type === 'expense' && x.teamCategoryId)) {
      porRubro[m.teamCategoryId] = (porRubro[m.teamCategoryId] || 0) + Number(m.amount);
    }
    const totUl = document.getElementById('team-month-totals');
    const entries = Object.entries(porRubro).sort((a, b) => b[1] - a[1]);
    totUl.innerHTML = entries.length
      ? entries.map(([id, amt]) => `
          <li class="flex justify-between text-sm py-1.5 border-b border-white/5">
            <span class="truncate">${escapeHtml(teamCategoryById(id)?.label || 'Sin rubro')}</span>
            <span class="tabular-nums text-rose">${money(amt)}</span>
          </li>
        `).join('')
      : '<li class="text-xs text-white/40 py-2">Sin gastos del equipo este mes.</li>';
  }

  function renderFamilies() {
    const ul = document.getElementById('families-list');
    const empty = document.getElementById('families-empty');
    if (!state.families.length) {
      ul.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      ul.innerHTML = state.families.map((f) => {
        const ch = ensureFamilyChildren(f);
        let sipiText = '';
        if (!ch.length) {
          sipiText = '<span class="text-amber-300/70">sin SIPI</span>';
        } else {
          const formatted = ch.map((c) => {
            if (c.name && c.sipi) return `${escapeHtml(c.name)} (${escapeHtml(c.sipi)})`;
            if (c.name) return escapeHtml(c.name);
            return escapeHtml(c.sipi);
          }).join(' · ');
          sipiText = `<span class="text-white/40">SIPI ${formatted}</span>`;
        }
        return `
          <li class="rounded-xl bg-void/40 px-3 py-3 border border-white/5 flex items-center justify-between gap-2">
            <button type="button" data-edit-fam="${f.id}" class="flex items-center gap-2 min-w-0 text-left flex-1">
              <span class="w-3 h-3 rounded-full shrink-0" style="background:${f.color}"></span>
              <span class="min-w-0">
                <span class="text-sm truncate block">${escapeHtml(f.name)}</span>
                <span class="text-[10px] tabular-nums block">
                  ${sipiText}
                </span>
              </span>
            </button>
            <i data-lucide="pencil" class="w-3.5 h-3.5 text-violet-light/60 shrink-0 pointer-events-none"></i>
          </li>
        `;
      }).join('');
    }

    const t = monthTotals();
    const byFam = {};
    for (const m of t.list.filter((x) => x.type === 'expense')) {
      const id = moveGroupKey(m);
      byFam[id] = (byFam[id] || 0) + Number(m.amount);
    }
    const totUl = document.getElementById('fam-month-totals');
    const entries = Object.entries(byFam).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      totUl.innerHTML = '<li class="text-xs text-white/40 py-2">Sin gastos este mes.</li>';
    } else {
      totUl.innerHTML = entries.map(([id, amt]) => {
        const meta = groupMeta(id);
        return `
          <li class="flex justify-between text-sm py-1.5 border-b border-white/5">
            <span class="flex items-center gap-2 truncate">
              <span class="w-2 h-2 rounded-full" style="background:${meta.color}"></span>
              ${escapeHtml(meta.name)}
            </span>
            <span class="tabular-nums text-rose">${money(amt)}</span>
          </li>
        `;
      }).join('');
    }
  }

  function renderLog() {
    const ul = document.getElementById('audit-list');
    const empty = document.getElementById('audit-empty');
    if (!state.auditLog.length) {
      ul.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      ul.innerHTML = state.auditLog.slice(0, 100).map((a) => `
        <li class="rounded-xl bg-void/40 px-3 py-2.5 border border-white/5">
          <div class="flex justify-between gap-2">
            <span class="text-[10px] uppercase tracking-wide text-violet-light/80">${escapeHtml(a.action)}</span>
            <span class="text-[10px] text-white/30 tabular-nums shrink-0">${formatDateTime(a.at)}</span>
          </div>
          <p class="text-sm text-white/80 mt-0.5">${escapeHtml(a.detail)}</p>
        </li>
      `).join('');
    }
  }

  function renderConfig() {
    document.getElementById('cfg-name').value = state.config.name || '';
    document.getElementById('cfg-technician').value = state.config.technician || '';
    document.getElementById('cfg-currency').value = state.config.currency || '$';
  }

  function render() {
    if (syncAllCarryovers()) save();
    renderHome();
    renderMoves();
    renderFamilies();
    renderTeam();
    renderLog();
    renderConfig();
    lucide.createIcons();
  }

  // ─── Tabs ──────────────────────────────────────────────────
  const TITLES = {
    home: 'Inicio',
    moves: 'Movimientos',
    families: 'Familias',
    team: 'Equipo',
    log: 'Log',
    config: 'Configuración'
  };

  function switchTab(tab) {
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    document.getElementById('tab-' + tab)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach((n) => {
      n.classList.toggle('active', n.dataset.tab === tab);
    });
    let title = TITLES[tab] || '';
    if (tab === 'home' && state.config.name) title = 'Hola, ' + state.config.name;
    document.getElementById('header-title').textContent = title;
    lucide.createIcons();
    window.scrollTo(0, 0);
  }

  // ─── Planillas del equipo ──────────────────────────────────
  /** Movimientos del mes ordenados como van en la planilla: del 1 al 31. */
  function sheetMovements() {
    return movementsInView()
      .slice()
      .sort((a, b) => (a.date + (a.createdAt || '')).localeCompare(b.date + (b.createdAt || '')));
  }

  function cajaData() {
    const concept = incomeConcept(viewYear, viewMonth);
    const rows = [];
    for (const m of sheetMovements()) {
      if (m.type === 'income') {
        rows.push({
          date: m.date,
          concept,
          sipi: '',
          income: Number(m.amount),
          expense: ''
        });
      } else {
        const sipis = expenseSipis(m);
        const label = expenseSheetLabel(m);
        if (sipis.length <= 1) {
          rows.push({
            date: m.date,
            concept: label,
            sipi: sipis[0] || '',
            income: '',
            expense: Number(m.amount)
          });
        } else {
          sipis.forEach((s, idx) => {
            const isFirst = idx === 0;
            const isLast = idx === sipis.length - 1;
            rows.push({
              date: isFirst ? m.date : '',
              concept: isFirst ? label : '',
              sipi: s,
              income: '',
              expense: isLast ? Number(m.amount) : ''
            });
          });
        }
      }
    }
    return {
      monthLabel: monthLabel(viewYear, viewMonth),
      technician: state.config.technician || state.config.name || '',
      rows
    };
  }

  function sircData() {
    const rows = [];
    for (const m of sheetMovements().filter((x) => x.type === 'expense')) {
      const sipis = expenseSipis(m);
      const fam = expenseSheetLabel(m);
      if (sipis.length <= 1) {
        rows.push({
          date: m.date,
          family: fam,
          sipi: sipis[0] || '',
          amount: Number(m.amount)
        });
      } else {
        sipis.forEach((s, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === sipis.length - 1;
          rows.push({
            date: isFirst ? m.date : '',
            family: isFirst ? fam : '',
            sipi: s,
            amount: isLast ? Number(m.amount) : ''
          });
        });
      }
    }
    return {
      monthLabel: monthLabel(viewYear, viewMonth),
      technician: state.config.technician || state.config.name || '',
      rows
    };
  }

  /** Nombre de archivo tipo "caja-agosto-2026.xlsx". */
  function sheetFileName(kind, ext) {
    const slug = monthLabel(viewYear, viewMonth).toLowerCase().replace(/\s+/g, '-');
    return `${kind}-${slug}.${ext}`;
  }

  /**
   * Abre el menú de compartir del celular (ahí aparece "Guardar en Drive").
   * Si el navegador no puede compartir archivos, lo descarga.
   */
  async function shareFile(blob, filename) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        audit('share_sheet', 'Compartió ' + filename);
        save();
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    audit('export_sheet', 'Descargó ' + filename);
    save();
    // Chrome no deja compartir .xlsx (solo pdf, csv, imágenes, audio y video),
    // así que este es el camino real: queda en Descargas y se sube desde ahí.
    toast('Quedó en Descargas del celu. Compartila a Drive desde ahí.');
  }

  function exportCaja() {
    const d = cajaData();
    if (!d.rows.length) { toast('No hay movimientos este mes'); return; }
    shareFile(window.FLSheets.buildCaja(d), sheetFileName('caja', 'xlsx'));
  }

  function exportSirc() {
    const d = sircData();
    if (!d.rows.length) { toast('No hay gastos este mes'); return; }
    shareFile(window.FLSheets.buildSirc(d), sheetFileName('sirc', 'xlsx'));
  }

  /**
   * El PDF se genera como archivo (no se manda a imprimir) porque es el
   * entregable: se comparte para que lo impriman en otro lado. Chrome sí deja
   * compartir application/pdf, así que este sale por el menú del celular.
   */
  function printCaja() {
    const d = cajaData();
    if (!d.rows.length) { toast('No hay movimientos este mes'); return; }
    let saldo = 0;
    const rows = d.rows.map((r) => {
      saldo += (Number(r.income) || 0) - (Number(r.expense) || 0);
      return [
        r.date ? formatDateNum(r.date) : '',
        r.concept || '',
        r.sipi ? String(r.sipi) : '',
        r.income ? money(r.income) : '',
        r.expense ? money(r.expense) : '',
        money(saldo)
      ];
    });
    audit('print_sheet', 'Generó el PDF de la caja de ' + d.monthLabel);
    const blob = window.FLPdf.build({
      title: 'CAJA DE: ' + d.monthLabel,
      technician: d.technician,
      headers: ['FECHA', 'CONCEPTO', 'SIPI', 'INGRESO', 'EGRESO', 'SALDO'],
      cols: [62, 152, 62, 78, 78, 83],
      aligns: ['c', 'l', 'r', 'r', 'r', 'r'],
      rows,
      footer: { label: 'SALDO FINAL', value: money(saldo) }
    });
    shareFile(blob, sheetFileName('caja', 'pdf'));
  }

  function printSirc() {
    const d = sircData();
    if (!d.rows.length) { toast('No hay gastos este mes'); return; }
    let total = 0;
    const rows = d.rows.map((r) => {
      total += Number(r.amount) || 0;
      return [
        r.date ? formatDateNum(r.date) : '',
        r.family || '',
        r.sipi ? String(r.sipi) : '',
        r.amount ? money(r.amount) : ''
      ];
    });
    audit('print_sheet', 'Generó el PDF del SIRC de ' + d.monthLabel);
    const blob = window.FLPdf.build({
      title: 'CAJA DE: ' + d.monthLabel,
      technician: d.technician,
      headers: ['FECHA:', 'FAMILIA:', 'SIPI:', 'GASTO:'],
      cols: [90, 215, 90, 120],
      aligns: ['c', 'l', 'r', 'r'],
      rows,
      footer: { label: 'TOTAL', value: money(total) }
    });
    shareFile(blob, sheetFileName('sirc', 'pdf'));
  }

  // ─── Export / import ───────────────────────────────────────
  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `finanzas-laburo-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    audit('export', 'Exportó backup');
    save();
    toast('Backup exportado');
  }

  function importData(file) {
    if (file.size > 5 * 1024 * 1024) {
      toast('Ese archivo es muy grande, no parece un backup');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.movements)) {
          toast('Archivo inválido');
          return;
        }
        if (!confirm('¿Reemplazar todos los datos actuales?')) return;
        state = migrate(data); // un backup viejo entra con los campos nuevos vacíos, no roto
        audit('import', 'Importó backup', { file: file.name });
        save();
        render();
        toast('Importado');
      } catch {
        toast('JSON inválido');
      }
    };
    reader.readAsText(file);
  }

  /**
   * Carga el archivo de SIPI del equipo. A diferencia de "Importar backup", esto
   * NO reemplaza nada: solo completa el SIPI y el rótulo de las familias que hoy
   * están vacías. No mira los movimientos ni crea o borra familias.
   */

  function resetAll() {
    if (!confirm('¿Borrar TODO? Exportá backup antes.')) return;
    if (!confirm('Confirmá: se pierden ingresos, gastos y familias.')) return;
    state = DEFAULT_STATE();
    save();
    render();
    toast('Datos borrados');
  }

  // ─── Events ────────────────────────────────────────────────
  function bindEvents() {
    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('btn-prev-month').addEventListener('click', () => {
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      render();
    });
    document.getElementById('btn-next-month').addEventListener('click', () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      render();
    });

    document.getElementById('btn-add-income').addEventListener('click', () => openMoveModal('income'));
    document.getElementById('btn-add-expense').addEventListener('click', () => openMoveModal('expense'));
    document.getElementById('btn-add-income-2').addEventListener('click', () => openMoveModal('income'));
    document.getElementById('btn-add-expense-2').addEventListener('click', () => openMoveModal('expense'));
    document.getElementById('btn-go-moves').addEventListener('click', () => switchTab('moves'));
    document.getElementById('btn-add-family').addEventListener('click', () => openFamilyModal());
    document.getElementById('btn-add-team').addEventListener('click', () => openTeamModal());

    document.querySelectorAll('.move-filter').forEach((btn) => {
      btn.addEventListener('click', () => {
        moveFilter = btn.dataset.moveFilter;
        renderMoves();
        lucide.createIcons();
      });
    });

    document.addEventListener('click', (e) => {
      const em = e.target.closest('[data-edit-move]');
      if (em) {
        const m = state.movements.find((x) => x.id === em.dataset.editMove);
        if (m) openMoveModal(m.type, m);
      }
      const ef = e.target.closest('[data-edit-fam]');
      if (ef) {
        const f = familyById(ef.dataset.editFam);
        if (f) openFamilyModal(f);
      }
      const et = e.target.closest('[data-edit-team]');
      if (et) {
        const c = teamCategoryById(et.dataset.editTeam);
        if (c) openTeamModal(c);
      }
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-root').addEventListener('click', (e) => {
      if (e.target.id === 'modal-root') closeModal();
    });

    document.getElementById('btn-save-config').addEventListener('click', () => {
      const before = { ...state.config };
      state.config.name = document.getElementById('cfg-name').value.trim().slice(0, 40);
      state.config.technician = document.getElementById('cfg-technician').value.trim().slice(0, 60);
      state.config.currency = document.getElementById('cfg-currency').value.trim().slice(0, 4) || '$';
      audit('config', 'Actualizó configuración', { before, after: { ...state.config } });
      save();
      render();
      toast('Config guardada');
    });

    document.getElementById('btn-sheet-caja').addEventListener('click', exportCaja);
    document.getElementById('btn-sheet-sirc').addEventListener('click', exportSirc);
    document.getElementById('btn-sheet-pdf').addEventListener('click', printCaja);
    document.getElementById('btn-sirc-pdf').addEventListener('click', printSirc);

    document.getElementById('btn-export').addEventListener('click', exportData);
    document.getElementById('input-import').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) importData(f);
      e.target.value = '';
    });
    document.getElementById('btn-reset').addEventListener('click', resetAll);

    const badge = document.getElementById('online-badge');
    const sync = () => {
      badge.textContent = navigator.onLine ? 'Listo · offline OK' : 'Modo offline';
    };
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    sync();
  }

  /**
   * El service worker sirve primero lo que tiene guardado, así que una versión
   * nueva tardaba dos aperturas en verse. Acá se le pide que se fije si hay
   * actualización y, cuando la nueva toma el control, se recarga sola una vez.
   * No se pierde nada: todo movimiento se guarda apenas se carga.
   */
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const yaTeniaSW = Boolean(navigator.serviceWorker.controller);
    let recargando = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!yaTeniaSW || recargando) return;  // primera instalación: no hay nada viejo que reemplazar
      recargando = true;
      location.reload();
    });
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => reg.update().catch(() => {}))
        .catch(() => {});
    });
  }

  function setupInstallHint() {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (isStandalone || localStorage.getItem('fl_hide_install') === '1') return;
    const bar = document.createElement('div');
    bar.className =
      'mx-4 mt-2 mb-1 rounded-2xl px-3 py-2.5 text-xs leading-snug border border-violet/40 bg-violet/15 text-violet-light flex gap-2 items-start';
    bar.innerHTML = `
      <span class="flex-1"><strong class="text-white">Instalá la app</strong> en pantalla de inicio (HTTPS). Después funciona offline en el laburo.</span>
      <button type="button" id="fl-install-close" class="shrink-0 text-white/50 text-lg leading-none px-1">×</button>
    `;
    document.querySelector('header')?.insertAdjacentElement('afterend', bar);
    document.getElementById('fl-install-close')?.addEventListener('click', () => {
      localStorage.setItem('fl_hide_install', '1');
      bar.remove();
    });
  }

  /**
   * Ofrece una sola vez los SIPI que ya figuran en las planillas del equipo, para
   * las familias que este celular tenga cargadas. Nunca los escribe sin confirmar:
   * un SIPI equivocado se va derecho a una rendición.
   */
  /**
   * Al abrir por primera vez, ofrece pasar a rubro de equipo las familias que en
   * realidad lo son (una llamada "Equipo", o una cuyos gastos son todos del mismo
   * rubro). Se muestra una sola vez.
   */
  function openSipiSuggestionModal() {
    const teams = pendingTeamMatches();
    if (!teams.length) {
      state.seenSipiSuggestion = true;
      save();
      return;
    }

    const teamRows = teams.map((tm, i) => `
      <li class="flex items-center gap-3 py-2.5 border-b border-white/5">
        <input type="checkbox" class="team-chk w-4 h-4 accent-violet-light shrink-0" data-i="${i}" checked />
        <span class="flex-1 min-w-0">
          <span class="text-sm block truncate">${escapeHtml(tm.familyName)}</span>
          <span class="text-[11px] text-white/40 block truncate">pasa a ${escapeHtml(tm.categoryLabel)} · sin SIPI</span>
        </span>
      </li>
    `).join('');

    openModal('Ajustes de tus familias', `
      <p class="text-xs text-white/50 mb-2">Esto no parece una familia sino un gasto del equipo. Los movimientos se conservan.</p>
      <ul class="mb-4">${teamRows}</ul>
      <button type="button" id="btn-sipi-apply" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">Aplicar</button>
      <button type="button" id="btn-sipi-skip" class="w-full py-3 mt-2 rounded-2xl border border-violet/30 text-violet-light text-sm">Ahora no</button>
    `);

    const finish = () => {
      state.seenSipiSuggestion = true;
      save();
      closeModal();
    };
    document.getElementById('btn-sipi-apply').addEventListener('click', () => {
      const chosen = [...document.querySelectorAll('.team-chk')]
        .filter((chk) => chk.checked)
        .map((chk) => teams[Number(chk.dataset.i)]);
      for (const tm of chosen) {
        convertFamilyToTeam(tm.familyId, tm.categoryId, { skipConfirm: true });
      }
      finish();
      render();
      toast(chosen.length ? 'Listo, quedó ajustado' : 'No se cambió nada');
    });
    document.getElementById('btn-sipi-skip').addEventListener('click', finish);
  }

  /**
   * Dos fechas de agosto 2026 quedaron mal al pasarlas a mano; las correctas son
   * las de la planilla. Solo corrige si el movimiento todavía tiene la fecha vieja,
   * así no pisa un arreglo hecho a mano, y corre una sola vez. Queda en el log.
   * Se puede borrar de acá cuando los dos celulares estén actualizados.
   */
  const DATE_FIXES = [
    { id: '8c103c3c-4c1d-4ba5-9018-2bd5ae92007d', from: '2026-08-14', to: '2026-08-19' },
    { id: 'f5b0952b-3b89-454e-a0ce-324a779485f4', from: '2026-08-23', to: '2026-08-22' }
  ];

  function applyDateFixes() {
    if (state.fixedAugustDates) return false;
    let n = 0;
    for (const fix of DATE_FIXES) {
      const m = state.movements.find((x) => x.id === fix.id && x.date === fix.from);
      if (!m) continue;
      m.date = fix.to;
      m.updatedAt = new Date().toISOString();
      audit('fix_date', `Fecha corregida en ${m.what || 'un movimiento'}: ${fix.from} → ${fix.to}`, { id: m.id });
      n++;
    }
    state.fixedAugustDates = true;
    save();
    return n > 0;
  }

  function boot() {
    bindEvents();
    applyDateFixes();
    render();
    if (!state.seenSipiSuggestion) openSipiSuggestionModal();
    registerSW();
    setupInstallHint();
    if (state.config.name) {
      document.getElementById('header-title').textContent = 'Hola, ' + state.config.name;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
