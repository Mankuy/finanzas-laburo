/**
 * Finanzas Laburo — PWA offline
 * Ingresos (quién) + Gastos (qué + familia) por mes
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'finanzas_laburo_v1';
  const FAMILY_COLORS = ['#8B5CF6', '#34D399', '#FB7185', '#FBBF24', '#38BDF8', '#A78BFA', '#F472B6', '#2DD4BF'];

  const DEFAULT_STATE = () => ({
    config: {
      name: '',
      currency: '$'
    },
    families: [
      { id: 'fam-misc', name: 'Varios / sin familia', color: '#6B7280', active: true }
    ],
    movements: [],
    // { id, type:'income'|'expense', amount, date:'YYYY-MM-DD',
    //   from?, what?, familyId?, note, createdAt, updatedAt, edited }
    auditLog: []
  });

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
      return {
        ...DEFAULT_STATE(),
        ...p,
        config: { ...DEFAULT_STATE().config, ...(p.config || {}) },
        families: Array.isArray(p.families) && p.families.length ? p.families : DEFAULT_STATE().families
      };
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
    return d.toLocaleDateString('es-UY', { month: 'long', year: 'numeric' });
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

  function familyById(id) {
    return state.families.find((f) => f.id === id);
  }

  function familyName(id) {
    return familyById(id)?.name || 'Sin familia';
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

    const now = new Date().toISOString();
    const payload = {
      type,
      amount: Math.round(amount * 100) / 100,
      date: data.date,
      from: type === 'income' ? String(data.from || '').trim() : '',
      what: type === 'expense' ? String(data.what || '').trim() : '',
      familyId: type === 'expense' ? (data.familyId || null) : null,
      note: String(data.note || '').trim()
    };

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
          : `− ${money(m.amount)} · ${m.what} · ${familyName(m.familyId)}`,
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
  function addFamily(name) {
    const n = String(name || '').trim();
    if (!n) {
      toast('Nombre vacío');
      return false;
    }
    const color = FAMILY_COLORS[state.families.length % FAMILY_COLORS.length];
    const f = { id: uid(), name: n, color, active: true };
    state.families.push(f);
    audit('add_family', `Familia: ${n}`, { id: f.id });
    save();
    render();
    toast('Familia agregada');
    return true;
  }

  function renameFamily(id, name) {
    const f = familyById(id);
    if (!f) return;
    const n = String(name || '').trim();
    if (!n) return;
    const before = f.name;
    f.name = n;
    audit('edit_family', `Renombró familia ${before} → ${n}`, { id });
    save();
    render();
    toast('Familia actualizada');
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
    return state.families
      .filter((f) => f.active !== false)
      .map((f) => `<option value="${escapeAttr(f.id)}" ${f.id === selected ? 'selected' : ''}>${escapeHtml(f.name)}</option>`)
      .join('');
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
              placeholder="Ej. Cliente Pérez, jefa, transferencia…" />
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Día (fecha del movimiento)</label>
            <input name="date" type="date" required value="${escapeAttr(date)}"
              class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
            <p class="text-[10px] text-white/35 mt-1">El resumen del mes usa solo movimientos de ese mes. Cada mes arranca en cero.</p>
          </div>
          <div>
            <label class="block text-xs text-white/50 mb-1">Nota (opcional)</label>
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
          <input name="what" type="text" required maxlength="100" value="${escapeAttr(m?.what || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. materiales, viáticos, regalo…" />
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Familia / grupo</label>
          <select name="familyId"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light">
            ${familyOptions(m?.familyId || 'fam-misc')}
          </select>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Día (fecha del movimiento)</label>
          <input name="date" type="date" required value="${escapeAttr(date)}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light" />
          <p class="text-[10px] text-white/35 mt-1">El resumen del mes usa solo movimientos de ese mes. Cada mes arranca en cero.</p>
        </div>
        <div>
          <label class="block text-xs text-white/50 mb-1">Nota (opcional)</label>
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
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const ok = upsertMovement({
        type: form.dataset.type,
        amount: fd.get('amount'),
        date: fd.get('date'),
        from: fd.get('from'),
        what: fd.get('what'),
        familyId: fd.get('familyId'),
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
    openModal(f ? 'Editar familia' : 'Nueva familia', `
      <form id="fam-form" class="space-y-4">
        <div>
          <label class="block text-xs text-white/50 mb-1">Nombre</label>
          <input name="name" type="text" required maxlength="60" value="${escapeAttr(f?.name || '')}"
            class="w-full bg-void/60 border border-violet/30 rounded-xl px-3 py-3 text-sm focus:outline-none focus:border-violet-light"
            placeholder="Ej. Familia Pérez" />
        </div>
        <button type="submit" class="w-full py-3 rounded-2xl bg-gradient-to-r from-violet to-violet-soft font-semibold text-sm">
          ${f ? 'Guardar' : 'Agregar'}
        </button>
        ${f && f.id !== 'fam-misc' ? `<button type="button" id="btn-del-fam" class="w-full py-3 rounded-2xl border border-red-500/40 text-red-400 text-sm">Eliminar</button>` : ''}
      </form>
    `);
    document.getElementById('fam-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = new FormData(e.target).get('name');
      if (f) renameFamily(f.id, name);
      else addFamily(name);
      closeModal();
    });
    document.getElementById('btn-del-fam')?.addEventListener('click', () => {
      deleteFamily(f.id);
      closeModal();
    });
  }

  // ─── Render ────────────────────────────────────────────────
  function moveRowHtml(m) {
    const isIn = m.type === 'income';
    const color = isIn ? 'text-neon' : 'text-rose';
    const sign = isIn ? '+' : '−';
    const title = isIn ? (m.from || 'Entrada') : (m.what || 'Gasto');
    const sub = isIn
      ? (m.note || 'Ingreso')
      : `${familyName(m.familyId)}${m.note ? ' · ' + m.note : ''}`;
    const fam = !isIn && m.familyId ? familyById(m.familyId) : null;
    const dot = fam
      ? `<span class="inline-block w-2 h-2 rounded-full mr-1" style="background:${fam.color}"></span>`
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
      const id = m.familyId || 'none';
      byFam[id] = (byFam[id] || 0) + Number(m.amount);
    }
    const famUl = document.getElementById('home-families');
    const famEmpty = document.getElementById('home-fam-empty');
    const entries = Object.entries(byFam).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      famUl.innerHTML = '';
      famEmpty.classList.remove('hidden');
    } else {
      famEmpty.classList.add('hidden');
      const max = entries[0][1] || 1;
      famUl.innerHTML = entries.map(([id, amt]) => {
        const f = familyById(id);
        const name = f?.name || 'Sin familia';
        const color = f?.color || '#6B7280';
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
    }
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

  function renderFamilies() {
    const ul = document.getElementById('families-list');
    const empty = document.getElementById('families-empty');
    if (!state.families.length) {
      ul.innerHTML = '';
      empty.classList.remove('hidden');
    } else {
      empty.classList.add('hidden');
      ul.innerHTML = state.families.map((f) => `
        <li class="rounded-xl bg-void/40 px-3 py-3 border border-white/5 flex items-center justify-between gap-2">
          <button type="button" data-edit-fam="${f.id}" class="flex items-center gap-2 min-w-0 text-left flex-1">
            <span class="w-3 h-3 rounded-full shrink-0" style="background:${f.color}"></span>
            <span class="text-sm truncate">${escapeHtml(f.name)}</span>
          </button>
          <i data-lucide="pencil" class="w-3.5 h-3.5 text-violet-light/60 shrink-0 pointer-events-none"></i>
        </li>
      `).join('');
    }

    const t = monthTotals();
    const byFam = {};
    for (const m of t.list.filter((x) => x.type === 'expense')) {
      const id = m.familyId || 'none';
      byFam[id] = (byFam[id] || 0) + Number(m.amount);
    }
    const totUl = document.getElementById('fam-month-totals');
    const entries = Object.entries(byFam).sort((a, b) => b[1] - a[1]);
    if (!entries.length) {
      totUl.innerHTML = '<li class="text-xs text-white/40 py-2">Sin gastos este mes.</li>';
    } else {
      totUl.innerHTML = entries.map(([id, amt]) => {
        const f = familyById(id);
        return `
          <li class="flex justify-between text-sm py-1.5 border-b border-white/5">
            <span class="flex items-center gap-2 truncate">
              <span class="w-2 h-2 rounded-full" style="background:${f?.color || '#6B7280'}"></span>
              ${escapeHtml(f?.name || 'Sin familia')}
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
    document.getElementById('cfg-currency').value = state.config.currency || '$';
  }

  function render() {
    renderHome();
    renderMoves();
    renderFamilies();
    renderLog();
    renderConfig();
    lucide.createIcons();
  }

  // ─── Tabs ──────────────────────────────────────────────────
  const TITLES = {
    home: 'Inicio',
    moves: 'Movimientos',
    families: 'Familias',
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
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.movements)) {
          toast('Archivo inválido');
          return;
        }
        if (!confirm('¿Reemplazar todos los datos actuales?')) return;
        state = {
          ...DEFAULT_STATE(),
          ...data,
          config: { ...DEFAULT_STATE().config, ...(data.config || {}) },
          families: data.families?.length ? data.families : DEFAULT_STATE().families
        };
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
    });

    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-root').addEventListener('click', (e) => {
      if (e.target.id === 'modal-root') closeModal();
    });

    document.getElementById('btn-save-config').addEventListener('click', () => {
      const before = { ...state.config };
      state.config.name = document.getElementById('cfg-name').value.trim().slice(0, 40);
      state.config.currency = document.getElementById('cfg-currency').value.trim().slice(0, 4) || '$';
      audit('config', 'Actualizó configuración', { before, after: { ...state.config } });
      save();
      render();
      toast('Config guardada');
    });

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

  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
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

  function boot() {
    bindEvents();
    render();
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
