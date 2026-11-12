(() => {
  'use strict';

  /* =====================================================================
     Config + helpers
     ===================================================================== */
  const cfg = Object.assign(
    { N8N_BASE: '', SHEET_URL: '#', MANAGER_NAME: 'Manager' },
    window.JARVIS_CONFIG || {}
  );
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const hook = p => cfg.N8N_BASE.replace(/\/+$/, '') + '/webhook/' + p;
  const notConfigured = () => !cfg.N8N_BASE || /YOUR-N8N-DOMAIN/i.test(cfg.N8N_BASE);
  const TZ = 'Asia/Karachi';

  // tiny DOM builder (text is always set via textContent -> XSS safe)
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === false || v == null) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else if (k === 'style') e.setAttribute('style', v);
        else e.setAttribute(k, v);
      }
    }
    kids.flat().forEach(c => {
      if (c == null || c === false) return;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return e;
  }

  const state = {
    pin: localStorage.getItem('jarvis_pin') || '',
    view: 'assistant',
    tasks: [], team: [],
    tasksLoaded: false, tasksStale: true, teamLoaded: false,
    sample: false, loadingTasks: false,
    filter: 'all', search: '',
    busy: false,
    chat: safeJSON(localStorage.getItem('jarvis_chat'), []),
    speak: localStorage.getItem('jarvis_speak') === '1'
  };

  function safeJSON(s, fallback) { try { return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; } }

  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || ''), text: msg });
    $('#toasts').append(t);
    setTimeout(() => t.remove(), 4200);
  }

  function initials(name) {
    return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase() || '?';
  }
  function colorFor(name) {
    let x = 0;
    for (const c of String(name)) x = (x * 31 + c.charCodeAt(0)) % 360;
    return 'hsl(' + x + ' 55% 42%)';
  }
  function avatar(name) {
    return h('div', { class: 'avatar', style: 'background:' + colorFor(name), text: initials(name) });
  }
  const clock = ts => new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });

  /* ---- dates: sheet stores "YYYY-MM-DD HH:mm" in Karachi time ---- */
  function parseDT(s) {
    const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    const d = m ? new Date(m[1] + 'T' + m[2] + ':00+05:00') : new Date(s);
    return isNaN(d) ? null : d;
  }
  function fmtDeadline(d) {
    if (!d) return '—';
    const day = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: TZ });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
    return day + ', ' + time;
  }
  function relTime(d) {
    const diff = d - Date.now();
    const mins = Math.max(1, Math.round(Math.abs(diff) / 60000));
    let s;
    if (mins < 60) s = mins + ' min';
    else if (mins < 60 * 48) s = Math.round(mins / 60) + ' ghante';
    else s = Math.round(mins / 1440) + ' din';
    return diff >= 0 ? s + ' baaki' : s + ' late';
  }
  function nowStr() {
    return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
  }

  /* =====================================================================
     Auth (single user = PIN)
     ===================================================================== */
  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#configBanner').hidden = !notConfigured();
    $('#sheetLink').href = cfg.SHEET_URL;
    initChat();
    showView('assistant');
  }
  function logout(msg) {
    state.pin = '';
    localStorage.removeItem('jarvis_pin');
    $('#app').hidden = true;
    $('#login').hidden = false;
    const e = $('#loginError');
    if (msg) { e.textContent = msg; e.hidden = false; } else e.hidden = true;
    $('#pinInput').value = '';
    $('#pinInput').focus();
  }
  $('#loginForm').addEventListener('submit', ev => {
    ev.preventDefault();
    const v = $('#pinInput').value.trim();
    if (!v) return;
    state.pin = v;
    localStorage.setItem('jarvis_pin', v);
    $('#loginError').hidden = true;
    showApp();
  });
  $('#logoutBtn').addEventListener('click', () => logout());

  /* =====================================================================
     Navigation
     ===================================================================== */
  function showView(name) {
    state.view = name;
    $$('.view').forEach(v => (v.hidden = v.id !== 'view-' + name));
    $$('.nav[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    if (name === 'tasks') loadTasks(false);
    if (name === 'team') loadTeam(false);
    if (name === 'assistant') scrollLog();
  }
  $$('.nav[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

  /* =====================================================================
     API
     ===================================================================== */
  async function getJSON(path) {
    const u = new URL(hook(path));
    u.searchParams.set('pin', state.pin);
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data && data.error === 'bad_pin') { const e = new Error('bad_pin'); e.code = 'bad_pin'; throw e; }
    return data;
  }

  /* =====================================================================
     Assistant: chat
     ===================================================================== */
  const examples = [
    'Ali ko kal shaam 5 baje tak Karachi Electric ka bill report bhejne ka task do',
    'Sara ko email bhejo ke kal 11 baje meeting hai',
    'Poori team ko msg karo: Friday ko office band hai',
    'Hamza ko parso dopahar 2 baje tak client quotation bhejne ka task do',
    'Ali ke kitne tasks pending hain?',
    'Client ko late delivery ka polite apology email draft karke do'
  ];

  function initChat() {
    const chips = $('#chips');
    chips.replaceChildren();
    examples.forEach(t => chips.append(h('button', {
      class: 'chip', type: 'button', title: t, text: t,
      onclick: () => { const i = $('#textInput'); i.value = t; i.focus(); }
    })));

    const log = $('#log');
    log.replaceChildren();
    if (!state.chat.length) {
      pushMsg('bot', 'Salam ' + cfg.MANAGER_NAME + '! Main Jarvis hoon.\nTask assign karna, email bhejna ya team ko message karna ho to text likho ya mic dabao.');
    } else {
      state.chat.forEach(m => renderMsg(m));
    }
    $('#speakToggle').checked = state.speak;
    scrollLog();
  }

  function saveChat() {
    try { localStorage.setItem('jarvis_chat', JSON.stringify(state.chat.slice(-60))); } catch (_) {}
  }
  function scrollLog() { const l = $('#log'); l.scrollTop = l.scrollHeight; }

  function renderMsg(m) {
    const bubble = h('div', { class: 'bubble', text: m.text });
    const wrap = h('div', { class: 'msg ' + m.role + (m.error ? ' err' : '') }, bubble, h('div', { class: 'time', text: clock(m.ts) }));
    $('#log').append(wrap);
    scrollLog();
    return { wrap, bubble };
  }
  // adds message to history + screen; returns an updater
  function pushMsg(role, text, opts) {
    const m = Object.assign({ role, text, ts: Date.now() }, opts || {});
    state.chat.push(m);
    saveChat();
    const ui = renderMsg(m);
    return { update(newText) { m.text = newText; ui.bubble.textContent = newText; saveChat(); } };
  }

  function setBusy(b, label) {
    state.busy = b;
    $('#sendBtn').disabled = b;
    $('#micBtn').disabled = b;
    $('#headOrb').classList.toggle('thinking', b);
    $('#statusLine').textContent = b ? (label || 'Soch raha hoon...') : 'Tayyar hoon';
    const old = $('#typing');
    if (old) old.remove();
    if (b) {
      $('#log').append(h('div', { class: 'msg bot typing', id: 'typing' }, h('div', { class: 'bubble' }, h('i'), h('i'), h('i'))));
      scrollLog();
    }
  }

  async function sendToAssistant({ text, audioBlob }) {
    if (notConfigured()) {
      pushMsg('bot', 'config.js mein N8N_BASE abhi set nahi hai. Usay apne n8n URL se badlo.', { error: true });
      return;
    }
    // pichli baatein, taake Jarvis context samjhe (current message se pehle ki)
    const history = state.chat
      .filter(m => !m.error)
      .slice(-6)
      .map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', text: String(m.text || '').slice(0, 500) }));

    let voiceMsg = null;
    if (text) pushMsg('me', text);
    if (audioBlob) voiceMsg = pushMsg('me', '🎤 Voice message (transcribe ho raha hai...)');

    const fd = new FormData();
    fd.append('pin', state.pin);
    fd.append('history', JSON.stringify(history));
    if (text) fd.append('text', text);
    if (audioBlob) {
      const ext = (audioBlob.type || '').includes('mp4') ? 'mp4' : 'webm';
      fd.append('audio', audioBlob, 'voice.' + ext);
    }

    setBusy(true, audioBlob ? 'Voice sun raha hoon...' : 'Soch raha hoon...');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const r = await fetch(hook('jarvis'), { method: 'POST', body: fd, signal: ctl.signal });
      const data = await r.json();
      if (data && data.ok === false && data.error === 'bad_pin') {
        setBusy(false);
        logout('PIN galat hai. Dobara try karein.');
        return;
      }
      if (voiceMsg) voiceMsg.update('🎤 ' + (data.transcript || '(awaaz samajh nahi aayi)'));
      const reply = data.reply || 'Ho gaya.';
      pushMsg('bot', reply);
      state.tasksStale = true;
      if (state.speak) speak(reply);
    } catch (e) {
      const msg = e.name === 'AbortError'
        ? 'Jawab mein bohat der lag gayi. n8n workflow check karein.'
        : 'Server se rabta nahi hua (' + e.message + '). n8n workflow Active hai? URL aur CORS sahi hain?';
      if (voiceMsg) voiceMsg.update('🎤 Voice message');
      pushMsg('bot', msg, { error: true });
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  }

  function speak(text) {
    try {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    } catch (_) {}
  }

  $('#composer').addEventListener('submit', ev => {
    ev.preventDefault();
    if (state.busy) return;
    const t = $('#textInput').value.trim();
    if (!t) return;
    $('#textInput').value = '';
    sendToAssistant({ text: t });
  });
  $('#speakToggle').addEventListener('change', e => {
    state.speak = e.target.checked;
    localStorage.setItem('jarvis_speak', state.speak ? '1' : '0');
    if (!state.speak && 'speechSynthesis' in window) speechSynthesis.cancel();
  });
  $('#clearChat').addEventListener('click', () => {
    state.chat = [];
    saveChat();
    initChat();
  });

  /* =====================================================================
     Assistant: voice recording
     ===================================================================== */
  const rec = { r: null, stream: null, ctx: null, raf: 0, timer: 0, t0: 0, chunks: [], cancelled: false };

  async function startRec() {
    if (state.busy || rec.r) return;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast('Is browser mein voice recording support nahi hai. Chrome use karein.', 'bad');
      return;
    }
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      toast('Mic access nahi mila. Browser mein mic permission allow karein.', 'bad');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(m => MediaRecorder.isTypeSupported(m));
    rec.r = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
    rec.chunks = [];
    rec.cancelled = false;
    rec.r.ondataavailable = e => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.r.onstop = onRecStop;
    rec.r.start();
    rec.t0 = Date.now();

    $('#recBar').hidden = false;
    $('#composer').hidden = true;
    $('#chips').hidden = true;
    $('#headOrb').classList.add('listening');
    $('#statusLine').textContent = 'Sun raha hoon...';
    startWave();
    rec.timer = setInterval(() => {
      const s = Math.floor((Date.now() - rec.t0) / 1000);
      $('#recTimer').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      if (s >= 90) stopRec(false);
    }, 250);
  }

  function stopRec(cancel) {
    rec.cancelled = !!cancel;
    if (rec.r && rec.r.state !== 'inactive') rec.r.stop();
  }

  function onRecStop() {
    const dur = Date.now() - rec.t0;
    const type = (rec.r && rec.r.mimeType) || 'audio/webm';
    const blob = new Blob(rec.chunks, { type });
    const cancelled = rec.cancelled;
    cleanupRec();
    if (cancelled) return;
    if (dur < 1200) { toast('Recording bohat chhoti thi. 2 se 3 second bolein.', 'bad'); return; }
    sendToAssistant({ audioBlob: blob });
  }

  function cleanupRec() {
    clearInterval(rec.timer);
    cancelAnimationFrame(rec.raf);
    if (rec.stream) rec.stream.getTracks().forEach(t => t.stop());
    if (rec.ctx) { try { rec.ctx.close(); } catch (_) {} }
    rec.r = null; rec.stream = null; rec.ctx = null;
    $('#recBar').hidden = true;
    $('#composer').hidden = false;
    $('#chips').hidden = false;
    $('#recTimer').textContent = '0:00';
    $('#headOrb').classList.remove('listening');
    $('#statusLine').textContent = 'Tayyar hoon';
  }

  function startWave() {
    const canvas = $('#wave');
    const g = canvas.getContext('2d');
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      rec.ctx = new AC();
      const src = rec.ctx.createMediaStreamSource(rec.stream);
      const an = rec.ctx.createAnalyser();
      an.fftSize = 64;
      src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const draw = () => {
        rec.raf = requestAnimationFrame(draw);
        const w = canvas.clientWidth, hgt = canvas.clientHeight;
        if (canvas.width !== w) canvas.width = w;
        if (canvas.height !== hgt) canvas.height = hgt;
        an.getByteFrequencyData(data);
        g.clearRect(0, 0, w, hgt);
        const bars = Math.min(data.length, Math.floor(w / 7));
        g.fillStyle = '#fb7185';
        for (let i = 0; i < bars; i++) {
          const v = data[i] / 255;
          const bh = Math.max(3, v * hgt);
          g.fillRect(i * 7, (hgt - bh) / 2, 4, bh);
        }
      };
      draw();
    } catch (_) { /* waveform optional */ }
  }

  $('#micBtn').addEventListener('click', startRec);
  $('#recStop').addEventListener('click', () => stopRec(false));
  $('#recCancel').addEventListener('click', () => stopRec(true));

  /* =====================================================================
     Tasks
     ===================================================================== */
  function normalizeTasks(data) {
    const rows = Array.isArray(data) ? data
      : (data && Array.isArray(data.tasks)) ? data.tasks
      : (data && data.TaskID) ? [data] : [];
    const list = rows.filter(r => r && r.TaskID).map(r => ({
      id: String(r.TaskID),
      assignee: r.Assignee || '',
      email: r.AssigneeEmail || '',
      task: r.Task || '',
      assignedAt: r.AssignedAt || '',
      deadlineText: r.Deadline || '',
      deadline: parseDT(r.Deadline),
      status: String(r.Status || 'Pending').trim().toLowerCase() === 'done' ? 'done' : 'pending',
      followUps: Number(r.FollowUps || 0),
      completedAt: r.CompletedAt || ''
    }));
    return sortTasks(list);
  }
  function sortTasks(list) {
    return list.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
      const da = a.deadline ? a.deadline.getTime() : Infinity;
      const db = b.deadline ? b.deadline.getTime() : Infinity;
      return a.status === 'pending' ? da - db : db - da;
    });
  }
  const isOverdue = t => t.status === 'pending' && t.deadline && t.deadline.getTime() < Date.now();

  function sampleTasks() {
    const hr = 3600e3, now = Date.now();
    const fmt = ms => new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);
    return sortTasks([
      { id: 'S1', assignee: 'Ali', task: 'Karachi Electric ka bill report bhejna', deadline: new Date(now + 20 * hr), status: 'pending', followUps: 0 },
      { id: 'S2', assignee: 'Sara', task: 'Weekly sales sheet update karna', deadline: new Date(now - 5 * hr), status: 'pending', followUps: 1 },
      { id: 'S3', assignee: 'Hamza', task: 'Client ko quotation email karna', deadline: new Date(now + 52 * hr), status: 'pending', followUps: 0 },
      { id: 'S4', assignee: 'Ali', task: 'Site visit report finalize karna', deadline: new Date(now - 30 * hr), status: 'done', followUps: 2, completedAt: fmt(now - 26 * hr) },
      { id: 'S5', assignee: 'Sara', task: 'Vendor payments ki list check karna', deadline: new Date(now - 50 * hr), status: 'pending', followUps: 3 }
    ].map(t => Object.assign({ email: '', assignedAt: '', deadlineText: '', completedAt: '' }, t)));
  }

  async function loadTasks(force) {
    if (state.loadingTasks) return;
    if (!force && state.tasksLoaded && !state.tasksStale && !state.sample) { renderTasks(); return; }
    if (state.sample && !force) { renderTasks(); return; }
    if (notConfigured()) {
      showTaskBanner('bad', 'config.js mein N8N_BASE set nahi hai.');
      renderTasks();
      return;
    }
    state.loadingTasks = true;
    $('#refreshTasks').classList.add('spin');
    try {
      const data = await getJSON('tasks');
      state.tasks = normalizeTasks(data);
      state.sample = false;
      state.tasksLoaded = true;
      state.tasksStale = false;
      $('#taskBanner').hidden = true;
    } catch (e) {
      if (e.code === 'bad_pin') { logout('PIN galat hai.'); return; }
      showTaskBanner('bad', 'Tasks load nahi hue (' + e.message + '). n8n mein "tasks" endpoint abhi bana nahi, ya URL/CORS ka masla hai.', true);
    } finally {
      state.loadingTasks = false;
      $('#refreshTasks').classList.remove('spin');
      renderTasks();
    }
  }

  function showTaskBanner(kind, text, withSample) {
    const b = $('#taskBanner');
    b.className = 'banner ' + kind;
    b.replaceChildren(h('span', { text }));
    if (withSample) {
      b.append(h('button', { class: 'btn ghost sm', type: 'button', text: 'Sample data dekho', onclick: () => {
        state.tasks = sampleTasks(); state.sample = true; state.tasksLoaded = true;
        showTaskBanner('warn', 'SAMPLE DATA dikh raha hai (asli nahi). Asli tasks ke liye n8n "tasks" endpoint connect karein.');
        renderTasks();
      } }));
    }
    b.hidden = false;
  }

  function renderTasks() {
    const all = state.tasks;
    const counts = {
      all: all.length,
      pending: all.filter(t => t.status === 'pending' && !isOverdue(t)).length,
      overdue: all.filter(isOverdue).length,
      done: all.filter(t => t.status === 'done').length
    };

    // nav badge = overdue count
    const nb = $('#navBadge');
    nb.hidden = !counts.overdue;
    nb.textContent = counts.overdue;

    // stats
    const pct = counts.all ? Math.round(counts.done / counts.all * 100) : 0;
    $('#stats').replaceChildren(
      h('div', { class: 'stat' }, h('div', { class: 'n', text: counts.all }), h('div', { class: 'l', text: 'Total tasks' }),
        h('div', { class: 'progress' }, h('i', { style: 'width:' + pct + '%' }))),
      h('div', { class: 'stat pending' }, h('div', { class: 'n', text: counts.pending }), h('div', { class: 'l', text: 'Pending' })),
      h('div', { class: 'stat overdue' }, h('div', { class: 'n', text: counts.overdue }), h('div', { class: 'l', text: 'Overdue' })),
      h('div', { class: 'stat done' }, h('div', { class: 'n', text: counts.done }), h('div', { class: 'l', text: 'Done (' + pct + '%)' }))
    );

    // filters
    const defs = [['all', 'Sab'], ['pending', 'Pending'], ['overdue', 'Overdue'], ['done', 'Done']];
    $('#filters').replaceChildren(...defs.map(([k, label]) => h('button', {
      class: 'filter' + (state.filter === k ? ' active' : ''), type: 'button',
      onclick: () => { state.filter = k; renderTasks(); }
    }, label, h('em', { text: counts[k] }))));

    // list
    const q = state.search.trim().toLowerCase();
    const shown = all.filter(t => {
      if (state.filter === 'pending' && !(t.status === 'pending' && !isOverdue(t))) return false;
      if (state.filter === 'overdue' && !isOverdue(t)) return false;
      if (state.filter === 'done' && t.status !== 'done') return false;
      if (q && !(t.assignee + ' ' + t.task).toLowerCase().includes(q)) return false;
      return true;
    });

    const list = $('#taskList');
    if (!shown.length) {
      list.replaceChildren(h('div', { class: 'empty', text: all.length ? 'Is filter mein koi task nahi.' : 'Abhi koi task nahi. Assistant se pehla task assign karein.' }));
      return;
    }
    list.replaceChildren(...shown.map(taskCard));
  }

  function taskCard(t) {
    const over = isOverdue(t);
    const cls = t.status === 'done' ? 'done' : over ? 'overdue' : 'pending';
    const meta = h('div', { class: 't-meta' },
      h('span', { class: 'pill ' + cls, text: cls === 'done' ? 'Done' : over ? 'Overdue' : 'Pending' }),
      h('span', { text: t.assignee || 'Unassigned' }),
      t.deadline ? h('span', { text: 'Deadline: ' + fmtDeadline(t.deadline) + (t.status === 'pending' ? ' · ' + relTime(t.deadline) : '') }) : null,
      t.followUps ? h('span', { class: 'pill fu', text: t.followUps + ' follow-up' + (t.followUps > 1 ? 's' : '') }) : null,
      t.status === 'done' && t.completedAt ? h('span', { text: 'Complete: ' + t.completedAt }) : null
    );
    const action = h('div', { class: 't-actions' },
      t.status === 'pending'
        ? h('button', { class: 'btn good sm', type: 'button', text: '✓ Done mark karo', onclick: ev => markDone(t, ev.currentTarget) })
        : null
    );
    return h('div', { class: 'task ' + cls }, avatar(t.assignee), h('div', {}, h('div', { class: 't-title', text: t.task }), meta), action);
  }

  async function markDone(t, btn) {
    if (!confirm('"' + t.task + '" ko Done mark karna hai?')) return;
    btn.disabled = true;
    try {
      if (!state.sample) {
        // done webhook returns an HTML page, so we only need the request to go out
        await fetch(hook('done') + '?id=' + encodeURIComponent(t.id), { mode: 'no-cors' });
      }
      t.status = 'done';
      t.completedAt = nowStr();
      sortTasks(state.tasks);
      renderTasks();
      toast('Task done mark ho gaya.', 'good');
      if (!state.sample) setTimeout(() => loadTasks(true), 2500);
    } catch (e) {
      btn.disabled = false;
      toast('Done mark nahi hua: ' + e.message, 'bad');
    }
  }

  $('#refreshTasks').addEventListener('click', () => { state.sample = false; loadTasks(true); });
  $('#searchInput').addEventListener('input', e => { state.search = e.target.value; renderTasks(); });
  $('#newTaskBtn').addEventListener('click', () => prefill('[Naam] ko [kab tak] [kaam] ka task do'));

  function prefill(text) {
    showView('assistant');
    const i = $('#textInput');
    i.value = text;
    i.focus();
  }

  /* =====================================================================
     Team
     ===================================================================== */
  async function loadTeam(force) {
    if (!force && state.teamLoaded) { renderTeam(); return; }
    $('#teamBanner').hidden = true;
    let usedFallback = false;
    try {
      if (notConfigured()) throw new Error('N8N_BASE set nahi');
      const data = await getJSON('team');
      const rows = Array.isArray(data) ? data : (data && Array.isArray(data.team) ? data.team : []);
      state.team = rows.filter(r => r && r.Name).map(r => ({ name: r.Name, email: r.Email || '' }));
      state.teamLoaded = true;
    } catch (e) {
      if (e.code === 'bad_pin') { logout('PIN galat hai.'); return; }
      usedFallback = true;
      // fallback: team = unique assignees from tasks
      const names = Array.from(new Set(state.tasks.map(t => t.assignee).filter(Boolean)));
      state.team = names.map(n => ({ name: n, email: (state.tasks.find(t => t.assignee === n) || {}).email || '' }));
    }
    if (usedFallback) {
      const b = $('#teamBanner');
      b.className = 'banner warn';
      b.textContent = 'Team endpoint connect nahi hai, isliye sirf tasks se naam dikh rahe hain (agar tasks load hue hon).';
      b.hidden = false;
    }
    renderTeam();
  }

  function renderTeam() {
    const grid = $('#teamGrid');
    if (!state.team.length) {
      grid.replaceChildren(h('div', { class: 'empty', text: 'Team list khali hai. Google Sheet ke "Team" tab mein members daalein.' }));
      return;
    }
    grid.replaceChildren(...state.team.map(m => {
      const mine = state.tasks.filter(t => t.assignee.toLowerCase() === m.name.toLowerCase());
      const open = mine.filter(t => t.status === 'pending').length;
      const over = mine.filter(isOverdue).length;
      return h('div', { class: 'member' },
        h('div', { class: 'top' }, avatar(m.name), h('div', { style: 'min-width:0' }, h('div', { class: 'nm', text: m.name }), h('div', { class: 'em', text: m.email || '—' }))),
        h('div', { class: 'counts' },
          h('span', { class: 'pill pending', text: open + ' open' }),
          over ? h('span', { class: 'pill overdue', text: over + ' overdue' }) : null,
          h('span', { class: 'pill done', text: (mine.length - open) + ' done' })),
        h('button', { class: 'btn sm', type: 'button', text: 'Task assign karo', onclick: () => prefill(m.name + ' ko kal shaam 5 baje tak ') })
      );
    }));
  }
  $('#refreshTeam').addEventListener('click', () => loadTeam(true));

  /* =====================================================================
     Boot
     ===================================================================== */
  if (state.pin) showApp();
  else $('#pinInput').focus();
})();
