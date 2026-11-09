/* ==========================================================
   JERCAT — Clip publicitaire premium
   recorder.js — Enregistrement & téléchargement de la vidéo

   Principe (repris de Popi) :
   1. l'utilisateur partage CET onglet (getDisplayMedia) ;
   2. le clip repart du début, interface masquée ;
   3. MediaRecorder encode l'image + le son (MP4 si possible) ;
   4. à la fin du clip, la vidéo est vérifiée, conservée sur
      l'appareil (IndexedDB) puis proposée au téléchargement.

   Ce fichier ne modifie ni le rendu 3D ni la timeline :
   il se contente de les piloter (replay, masquage de l'interface).
   ========================================================== */

/* Formats essayés dans l'ordre : MP4 (H.264) d'abord, WebM en secours */
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.4d401f,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a',
  'video/mp4;codecs=avc1,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

const DB_NAME = 'jercat-clip';
const DB_STORE = 'videos';
const DB_KEY = 'derniere-video';
const SETTLE_MS = 1000;            // laisse le bandeau « partage d'onglet » s'afficher avant de filmer
const HOLD_END_MS = 900;           // garde la dernière image quelques instants
const CHUNK_MS = 1000;             // morceaux d'une seconde : pas de gros bloc en mémoire
const WRITE_CHUNK = 4 * 1024 * 1024; // écriture disque par blocs de 4 Mo
const MIN_SIZE = 50 * 1024;        // en dessous, la vidéo est considérée comme vide

const ICONS = {
  rec: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5"/></svg>',
  dl: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
};

export function initRecorder(api) {
  const { tl, T, audio, replay, toggleUI, toggleSound, controls, before } = api;
  if (!tl || !controls) return;

  const canCapture = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  const baseTitle = document.title;

  let phase = 'idle';   // idle | arming | recording | finalizing | ready | downloading
  let video = null;     // { blob, mime, ext, size, date, width, height, audio, saved }
  let session = null;
  let recDest = null;
  let toastTimer = null;

  /* ---------- Boutons dans la barre de contrôle ---------- */
  const btnRec = document.createElement('button');
  btnRec.className = 'ctl ctl-rec';
  btnRec.id = 'btnRec';
  btnRec.type = 'button';
  btnRec.setAttribute('aria-label', 'Enregistrer la vidéo');
  btnRec.title = 'Enregistrer la vidéo';
  btnRec.innerHTML = ICONS.rec;

  const btnDl = document.createElement('button');
  btnDl.className = 'ctl ctl-dl';
  btnDl.id = 'btnDownload';
  btnDl.type = 'button';
  btnDl.setAttribute('aria-label', 'Télécharger la vidéo');
  btnDl.title = 'Télécharger la vidéo';
  btnDl.innerHTML = ICONS.dl;

  controls.insertBefore(btnRec, before && before.parentNode === controls ? before : null);
  controls.insertBefore(btnDl, btnRec.nextSibling);

  /* ---------- Panneau d'état + message ---------- */
  const panel = document.createElement('div');
  panel.className = 'rec-panel glass';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-labelledby', 'recTitle');
  panel.innerHTML = `
    <div class="rec-head">
      <span class="rec-state" aria-hidden="true"></span>
      <strong id="recTitle"></strong>
      <button type="button" class="rec-close" aria-label="Fermer">${ICONS.close}</button>
    </div>
    <div class="rec-msg" aria-live="polite"></div>
    <div class="rec-bar" hidden><span></span></div>
    <p class="rec-meta"></p>
    <div class="rec-actions"></div>`;
  document.body.appendChild(panel);

  const toastEl = document.createElement('div');
  toastEl.className = 'rec-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);

  const $p = (s) => panel.querySelector(s);
  $p('.rec-close').addEventListener('click', closePanel);

  function render({ tone = 'info', title, msg = '', progress = null, meta = '', actions = [] }) {
    panel.dataset.tone = tone;
    $p('#recTitle').textContent = title;
    $p('.rec-msg').innerHTML = msg;
    const bar = $p('.rec-bar');
    const fill = bar.firstElementChild;
    bar.hidden = progress === null;
    bar.classList.toggle('is-indeterminate', progress === 'indeterminate');
    fill.style.width = typeof progress === 'number' ? `${Math.round(progress * 100)}%` : '';
    $p('.rec-meta').textContent = meta;
    const box = $p('.rec-actions');
    box.textContent = '';
    actions.forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = a.primary ? 'btn btn-primary' : 'btn btn-ghost glass';
      b.innerHTML = `${a.icon ? ICONS[a.icon] : ''}<span></span>`;
      b.querySelector('span').textContent = a.label;
      b.addEventListener('click', a.onClick);
      box.appendChild(b);
    });
    panel.classList.add('is-open');
  }

  function setProgress(p) {
    const bar = $p('.rec-bar');
    bar.hidden = false;
    bar.classList.remove('is-indeterminate');
    bar.firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }

  function closePanel() { panel.classList.remove('is-open'); }

  function toast(text, tone = 'ok') {
    toastEl.textContent = text;
    toastEl.dataset.tone = tone;
    toastEl.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 5500);
  }

  function showError(title, msg, retry = true) {
    render({
      tone: 'error', title, msg,
      actions: retry && canCapture ? [{ label: 'Réessayer', primary: true, icon: 'rec', onClick: startRecording }] : [],
    });
  }

  /* ---------- Outils ---------- */
  const fmtSize = (b) => (b >= 1024 * 1024 * 1024
    ? `${(b / 1024 / 1024 / 1024).toFixed(2).replace('.', ',')} Go`
    : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`);
  const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  function fileName(v) {
    const d = new Date(v.date);
    const p = (n) => String(n).padStart(2, '0');
    return `jercat-clip-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}h${p(d.getMinutes())}.${v.ext}`;
  }

  function describe(v) {
    const parts = [v.ext.toUpperCase(), fmtDur(T.end), fmtSize(v.size)];
    if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
    return parts.join(' · ');
  }

  function soundNote(v) {
    if (v.audio === 'tab') return 'Son de l\'onglet inclus.';
    if (v.audio === 'internal') return 'Son : musique et effets. Pour inclure aussi la voix off, cochez « Partager l\'audio de l\'onglet » au prochain enregistrement.';
    return 'Vidéo sans son.';
  }

  function updateDlButton() {
    const ready = !!video && (phase === 'ready' || phase === 'idle' || phase === 'downloading');
    btnDl.setAttribute('aria-disabled', ready ? 'false' : 'true');
    btnDl.classList.toggle('is-ready', ready && phase !== 'downloading');
    btnDl.classList.toggle('is-busy', phase === 'downloading' || phase === 'finalizing');
    btnDl.title = ready ? `Télécharger la vidéo (${describe(video)})` : 'Télécharger la vidéo (enregistrez-la d\'abord)';
  }

  /* ---------- Sauvegarde sur l'appareil (IndexedDB) ---------- */
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) { reject(new Error('IndexedDB indisponible')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloquée'));
    });
  }

  async function dbRun(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, mode);
        const req = fn(tx.objectStore(DB_STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
      });
    } finally {
      db.close();
    }
  }

  async function saveVideo(v) {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const { quota, usage } = await navigator.storage.estimate();
        if (quota && usage + v.size * 1.1 > quota) return false;
      }
      const { blob, mime, ext, size, date, width, height, audio: a } = v;
      await dbRun('readwrite', (s) => s.put({ blob, mime, ext, size, date, width, height, audio: a }, DB_KEY));
      return true;
    } catch (e) {
      return false;
    }
  }

  async function loadVideo() {
    try {
      const v = await dbRun('readonly', (s) => s.get(DB_KEY));
      if (v && v.blob instanceof Blob && v.blob.size >= MIN_SIZE) return { ...v, size: v.blob.size, saved: true };
    } catch (e) { /* pas de vidéo sauvegardée */ }
    return null;
  }

  /* ---------- Vérification : la vidéo est-elle lisible ? ---------- */
  function probe(blob) {
    return new Promise((resolve) => {
      const el = document.createElement('video');
      const url = URL.createObjectURL(blob);
      let done = false;
      const end = (ok) => {
        if (done) return;
        done = true;
        el.removeAttribute('src');
        el.load();
        URL.revokeObjectURL(url);
        resolve(ok);
      };
      el.muted = true;
      el.preload = 'metadata';
      el.onloadedmetadata = () => end(true);
      el.onerror = () => end(false);
      setTimeout(() => end(true), 10000); // certains navigateurs ne lisent pas les métadonnées : on ne bloque pas
      el.src = url;
    });
  }

  /* ---------- Son du clip vers l'enregistreur ---------- */
  function internalAudioTrack() {
    if (!audio.ctx || !audio.output || !audio.ctx.createMediaStreamDestination) return null;
    if (!recDest) {
      recDest = audio.ctx.createMediaStreamDestination();
      audio.output.connect(recDest);
    }
    return recDest.stream.getAudioTracks()[0] || null;
  }

  /* ---------- Pendant l'enregistrement : la souris et le clavier ne perturbent pas le clip ---------- */
  function blockInput(e) {
    if (e.type === 'keydown') {
      if (e.key === 'Escape') cancelRecording();
      e.preventDefault();
    }
    e.stopImmediatePropagation();
  }
  const BLOCKED = ['keydown', 'pointermove', 'pointerdown'];
  const lockInput = () => BLOCKED.forEach((t) => window.addEventListener(t, blockInput, true));
  const unlockInput = () => BLOCKED.forEach((t) => window.removeEventListener(t, blockInput, true));

  function onVisibility() {
    const r = session && session.rec;
    if (!r) return;
    if (document.hidden && r.state === 'recording') r.pause();
    else if (!document.hidden && r.state === 'paused') r.resume();
  }

  /* ==========================================================
     ENREGISTREMENT
     ========================================================== */
  async function startRecording() {
    if (['arming', 'recording', 'finalizing', 'downloading'].includes(phase)) return;
    if (!canCapture) { showMobileHelp(); return; }

    const mime = pickMime();
    phase = 'arming';
    updateDlButton();
    render({
      tone: 'busy', title: 'Préparation de l\'enregistrement',
      msg: 'Dans la fenêtre qui s\'ouvre, choisissez <strong>« Cet onglet »</strong>, cochez <strong>« Partager aussi l\'audio de l\'onglet »</strong>, puis cliquez sur <strong>« Partager »</strong>.',
      progress: 'indeterminate',
    });

    // Le son est activé pour la vidéo (il sera remis comme avant à la fin)
    const soundWasOn = audio.enabled;
    try { if (!soundWasOn) await toggleSound(); } catch (e) { /* le clip reste muet */ }
    const restoreSound = () => { if (!soundWasOn && audio.enabled) toggleSound(); };

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
        systemAudio: 'exclude',
      });
    } catch (e) {
      phase = video ? 'ready' : 'idle';
      updateDlButton();
      restoreSound();
      if (e && e.name === 'NotAllowedError') {
        showError('Enregistrement annulé', 'Le partage de l\'onglet a été refusé. Pour enregistrer le clip, choisissez « Cet onglet » puis « Partager ».');
      } else {
        showError('Capture impossible', `Votre navigateur n'a pas pu capturer l'onglet (${esc(e && e.name || 'erreur inconnue')}). Fermez les autres partages d'écran puis réessayez, de préférence avec Chrome ou Edge.`);
      }
      return;
    }

    const vTrack = stream.getVideoTracks()[0];
    const settings = vTrack.getSettings ? vTrack.getSettings() : {};
    const tracks = [vTrack];
    let audioSrc = 'none';
    const tabAudio = stream.getAudioTracks()[0];
    if (tabAudio) { tracks.push(tabAudio); audioSrc = 'tab'; } else {
      const inner = internalAudioTrack();
      if (inner) { tracks.push(inner); audioSrc = 'internal'; }
    }

    const w = settings.width || innerWidth * (devicePixelRatio || 1);
    const h = settings.height || innerHeight * (devicePixelRatio || 1);
    const fps = settings.frameRate || 60;
    const videoBitsPerSecond = Math.round(Math.min(14e6, Math.max(4e6, w * h * fps * 0.07)));

    let rec;
    try {
      rec = new MediaRecorder(new MediaStream(tracks), {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond,
        audioBitsPerSecond: 160000,
      });
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      phase = video ? 'ready' : 'idle';
      updateDlButton();
      restoreSound();
      showError('Format vidéo non pris en charge', 'Votre navigateur ne sait pas encoder cette vidéo. Mettez-le à jour ou utilisez Chrome ou Edge.', false);
      return;
    }

    const s = session = {
      rec, stream, chunks: [], bytes: 0, audioSrc, restoreSound,
      mime: rec.mimeType || mime || 'video/webm',
      width: settings.width, height: settings.height,
      completed: false, interrupted: null, error: null, ending: false, timer: null,
      uiWasHidden: document.body.classList.contains('ui-hidden'),
    };

    rec.ondataavailable = (e) => { if (e.data && e.data.size) { s.chunks.push(e.data); s.bytes += e.data.size; } };
    rec.onerror = (e) => {
      s.error = (e && (e.error || e)) || new Error('MediaRecorder');
      if (rec.state !== 'inactive') rec.stop();
    };
    rec.onstop = () => finalize(s);
    vTrack.addEventListener('ended', () => {
      if (rec.state !== 'inactive') { s.interrupted = s.interrupted || 'share'; rec.stop(); }
      else if (!s.started) { s.interrupted = 'share'; }
    });

    // Mode tournage : interface masquée, entrées bloquées, titre de l'onglet = indicateur
    phase = 'recording';
    updateDlButton();
    closePanel();
    document.body.classList.add('is-recording');
    toggleUI(true);
    lockInput();
    document.addEventListener('visibilitychange', onVisibility);
    document.title = '● REC 0 % — ' + baseTitle;

    await wait(SETTLE_MS);
    if (vTrack.readyState === 'ended' || s.interrupted) {
      // Partage arrêté avant le début : rien n'a été filmé
      s.interrupted = s.interrupted || 'share';
      finalize(s);
      return;
    }

    replay();
    rec.start(CHUNK_MS);
    s.started = performance.now();

    s.timer = setInterval(() => {
      const p = Math.min(1, tl.progress());
      document.title = `● REC ${Math.round(p * 100)} % — ${baseTitle}`;
      if (p >= 1 && !s.ending) {
        s.ending = true;
        s.completed = true;
        setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, HOLD_END_MS);
      }
    }, 200);
  }

  function cancelRecording() {
    const s = session;
    if (!s || phase !== 'recording') return;
    s.interrupted = 'user';
    if (s.rec.state !== 'inactive') s.rec.stop(); else finalize(s);
  }

  async function finalize(s) {
    if (s.finalized) return;
    s.finalized = true;
    clearInterval(s.timer);
    unlockInput();
    document.removeEventListener('visibilitychange', onVisibility);
    document.title = baseTitle;
    s.stream.getTracks().forEach((t) => t.stop()); // ferme le partage d'onglet
    document.body.classList.remove('is-recording');
    toggleUI(s.uiWasHidden);
    s.restoreSound();
    session = null;

    phase = 'finalizing';
    updateDlButton();
    render({ tone: 'busy', title: 'Finalisation de la vidéo', msg: 'Assemblage et vérification du fichier…', progress: 'indeterminate' });

    const keep = video ? 'ready' : 'idle';
    const fail = (title, msg) => { s.chunks = null; phase = keep; updateDlButton(); showError(title, msg); };

    if (s.error) {
      fail('Erreur pendant l\'enregistrement', `L'encodage s'est interrompu (${esc(s.error.name || s.error.message || 'erreur inconnue')}). ${video ? 'Votre vidéo précédente est conservée. ' : ''}Réessayez.`);
      return;
    }
    if (s.interrupted || !s.completed) {
      const why = s.interrupted === 'user' ? 'Vous avez arrêté l\'enregistrement (Échap)'
        : s.interrupted === 'share' ? 'Le partage de l\'onglet a été arrêté'
        : 'L\'enregistrement s\'est arrêté';
      fail('Enregistrement interrompu', `${why} avant la fin du clip : la vidéo est incomplète et n'a pas été conservée.${video ? ' Votre vidéo précédente est toujours disponible.' : ''}`);
      return;
    }

    const base = (s.mime.split(';')[0] || 'video/webm').trim();
    const blob = new Blob(s.chunks, { type: base });
    s.chunks = null;

    if (blob.size < MIN_SIZE) {
      fail('Vidéo vide', 'Aucune image n\'a été capturée. Vérifiez que vous avez bien partagé « Cet onglet », puis réessayez.');
      return;
    }
    if (!(await probe(blob))) {
      fail('Vidéo illisible', 'Le fichier généré est endommagé. Réessayez, de préférence avec Chrome ou Edge à jour.');
      return;
    }

    video = {
      blob, mime: base, ext: base.includes('mp4') ? 'mp4' : 'webm', size: blob.size,
      date: Date.now(), width: s.width, height: s.height, audio: s.audioSrc, saved: false,
    };
    phase = 'ready';
    updateDlButton();
    showReady('Vidéo prête', 'Le clip complet a été enregistré et vérifié.');
    toast('Vidéo enregistrée : prête à être téléchargée');

    video.saved = await saveVideo(video);
    if (phase === 'ready' && panel.classList.contains('is-open')) showReady('Vidéo prête', 'Le clip complet a été enregistré et vérifié.');
  }

  function showReady(title, lead) {
    const v = video;
    const fmtNote = v.ext === 'webm'
      ? '<br>Format WebM : ce navigateur ne sait pas créer de MP4. Pour un MP4, enregistrez avec Chrome ou Edge à jour.' : '';
    render({
      tone: 'ok', title,
      msg: `${lead} ${soundNote(v)}${fmtNote}`,
      progress: 1,
      meta: describe(v) + (v.saved ? ' · sauvegardée sur cet appareil' : ''),
      actions: [
        { label: `Télécharger en ${v.ext.toUpperCase()}`, primary: true, icon: 'dl', onClick: download },
        ...(canCapture ? [{ label: 'Nouvel enregistrement', icon: 'rec', onClick: startRecording }] : []),
      ],
    });
  }

  /* ==========================================================
     TÉLÉCHARGEMENT
     ========================================================== */
  async function download() {
    if (phase === 'downloading') return;
    if (phase === 'recording' || phase === 'arming') return;
    if (phase === 'finalizing') { toast('La vidéo est en cours de finalisation, patientez quelques secondes.', 'info'); return; }
    if (!video || !video.blob || video.blob.size < MIN_SIZE) {
      render({
        tone: 'info', title: 'Aucune vidéo à télécharger',
        msg: canCapture ? 'Enregistrez d\'abord le clip : il sera vérifié puis prêt à être téléchargé.' : 'Sur téléphone, utilisez l\'enregistrement d\'écran de votre appareil.',
        actions: canCapture ? [{ label: 'Enregistrer la vidéo', primary: true, icon: 'rec', onClick: startRecording }] : [{ label: 'Voir comment faire', primary: true, onClick: showMobileHelp }],
      });
      return;
    }

    const v = video;
    const name = fileName(v);
    const prev = phase;
    phase = 'downloading';
    updateDlButton();

    // Ordinateur (Chrome / Edge) : choix de l'emplacement + vraie progression d'écriture
    if (window.showSaveFilePicker && window.isSecureContext) {
      let handle = null;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: `Vidéo ${v.ext.toUpperCase()}`, accept: { [v.mime]: [`.${v.ext}`] } }],
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { phase = prev; updateDlButton(); return; }
        handle = null; // sélecteur indisponible : on passe au téléchargement classique
      }
      if (handle) {
        let writable = null;
        try {
          render({ tone: 'busy', title: 'Téléchargement en cours', msg: `Écriture de <strong>${esc(handle.name)}</strong>…`, progress: 0, meta: describe(v) });
          writable = await handle.createWritable();
          for (let off = 0; off < v.size; off += WRITE_CHUNK) {
            await writable.write(v.blob.slice(off, Math.min(v.size, off + WRITE_CHUNK)));
            setProgress(Math.min(1, (off + WRITE_CHUNK) / v.size));
          }
          await writable.close();
          phase = 'ready';
          updateDlButton();
          showReady('Vidéo téléchargée', `<strong>${esc(handle.name)}</strong> a été enregistrée sur votre ordinateur.`);
          toast(`Vidéo téléchargée : ${handle.name} (${fmtSize(v.size)})`);
        } catch (e) {
          try { if (writable) await writable.abort(); } catch (_) { /* rien */ }
          phase = 'ready';
          updateDlButton();
          const full = e && (e.name === 'QuotaExceededError' || /space|quota/i.test(e.message || ''));
          render({
            tone: 'error', title: 'Téléchargement impossible',
            msg: full ? 'Espace disque insuffisant pour enregistrer la vidéo. Libérez de la place puis réessayez.'
              : `L'écriture du fichier a échoué (${esc(e && e.name || 'erreur inconnue')}). Réessayez ou choisissez un autre dossier.`,
            meta: describe(v),
            actions: [{ label: 'Réessayer', primary: true, icon: 'dl', onClick: download }],
          });
        }
        return;
      }
    }

    // Autres navigateurs : téléchargement direct
    try {
      render({ tone: 'busy', title: 'Téléchargement en cours', msg: `Préparation de <strong>${esc(name)}</strong>…`, progress: 'indeterminate', meta: describe(v) });
      const url = URL.createObjectURL(v.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Le lien reste valide le temps que le navigateur copie le fichier (gros fichiers compris)
      setTimeout(() => URL.revokeObjectURL(url), 120000);
      await wait(600);
      phase = 'ready';
      updateDlButton();
      showReady('Téléchargement lancé', `<strong>${esc(name)}</strong> est enregistrée dans votre dossier <strong>Téléchargements</strong>.`);
      toast(`Téléchargement lancé : ${name} (${fmtSize(v.size)})`);
    } catch (e) {
      phase = 'ready';
      updateDlButton();
      render({
        tone: 'error', title: 'Téléchargement impossible',
        msg: `Le navigateur a refusé le téléchargement (${esc(e && e.name || 'erreur inconnue')}). Autorisez les téléchargements pour ce site puis réessayez.`,
        actions: [{ label: 'Réessayer', primary: true, icon: 'dl', onClick: download }],
      });
    }
  }

  /* ==========================================================
     TÉLÉPHONE & TABLETTE : enregistrement d'écran de l'appareil
     ========================================================== */
  function showMobileHelp() {
    render({
      tone: 'info', title: 'Enregistrer sur téléphone ou tablette',
      msg: `Sur téléphone et tablette, les navigateurs ne permettent pas à une page de filmer son propre écran. Utilisez l'enregistrement d'écran intégré (vidéo MP4 dans vos Photos) :
        <ol class="rec-steps">
          <li>Lancez l'enregistrement d'écran : <strong>Centre de contrôle</strong> sur iPhone/iPad, <strong>Réglages rapides</strong> sur Android.</li>
          <li>Touchez <strong>« Mode tournage »</strong> : le clip repart du début, sans interface et avec le son.</li>
          <li>Arrêtez l'enregistrement d'écran à la fin du clip.</li>
        </ol>`,
      actions: [{ label: 'Mode tournage', primary: true, icon: 'rec', onClick: shootMode }],
    });
  }

  async function shootMode() {
    closePanel();
    const wasHidden = document.body.classList.contains('ui-hidden');
    try { if (!audio.enabled) await toggleSound(); } catch (e) { /* sans son */ }
    toggleUI(true);
    replay();
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      clearInterval(timer);
      window.removeEventListener('pointerdown', onTap, true);
      toggleUI(wasHidden);
    };
    // Une fois le clip lancé, toucher l'écran réaffiche l'interface
    const onTap = () => exit();
    setTimeout(() => { if (!exited) window.addEventListener('pointerdown', onTap, true); }, 1500);
    const timer = setInterval(() => { if (tl.progress() >= 1) setTimeout(exit, 1500); }, 300);
  }

  /* ---------- Événements ---------- */
  btnRec.addEventListener('click', startRecording);
  btnDl.addEventListener('click', download);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && panel.classList.contains('is-open') && phase !== 'recording') closePanel();
  });

  updateDlButton();

  // Vidéo enregistrée lors d'une visite précédente ?
  loadVideo().then((v) => {
    if (v && !video) {
      video = v;
      if (phase === 'idle') phase = 'ready';
      updateDlButton();
    }
  });
}
