/* ==========================================================
   JERCAT — Clip publicitaire premium
   recorder.js — Enregistrement de la vidéo, identique à Popi

   Fonctionnement (même logique que popi-sigma.vercel.app) :
   1. bouton « ● Enregistrer la vidéo » ;
   2. l'utilisateur partage CET onglet (getDisplayMedia) ;
   3. le clip repart du début, interface masquée (enregistrement propre) ;
   4. MediaRecorder encode l'image + le son ;
   5. à la fin du clip, la vidéo se télécharge automatiquement.

   Ce fichier ne modifie ni le rendu 3D ni la timeline :
   il se contente de les piloter (replay, masquage de l'interface).
   ========================================================== */

const FILE_BASE = 'jercat-clip-44s';

export function initRecorder(api) {
  const { tl, audio, replay, toggleUI, toggleSound, controls, before } = api;
  if (!tl || !controls) return;

  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  const BASE_TITLE = document.title;

  let recorder = null, chunks = [], stream = null, recDest = null;
  let recording = false, discardRec = false, endTimer = null, toastTimer = null;
  let soundWasOn = false, uiWasHidden = false;

  // Nettoyage : la version précédente gardait une copie de la vidéo dans le navigateur
  try { if (window.indexedDB) indexedDB.deleteDatabase('jercat-clip'); } catch (e) { /* rien */ }

  /* ---------- Bouton (même libellé que Popi) ---------- */
  const recBtn = document.createElement('button');
  recBtn.type = 'button';
  recBtn.id = 'rec';
  recBtn.className = 'rec-btn';
  recBtn.setAttribute('aria-label', 'Enregistrer la vidéo');
  recBtn.innerHTML = '● <span class="long">Enregistrer la vidéo</span><span class="short">Enregistrer</span>';
  controls.insertBefore(recBtn, before && before.parentNode === controls ? before : null);

  /* ---------- Message (toast), comme Popi ---------- */
  const toastEl = document.createElement('div');
  toastEl.className = 'rec-toast';
  toastEl.setAttribute('role', 'status');
  toastEl.setAttribute('aria-live', 'polite');
  document.body.appendChild(toastEl);

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 5000);
  }

  /* ---------- Format vidéo : MP4 si le navigateur sait le faire, sinon WebM ---------- */
  function pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
    return [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,opus',
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find((t) => MediaRecorder.isTypeSupported(t)) || '';
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

  function stopStream() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  }

  /* ---------- Pendant l'enregistrement : souris et clavier ne perturbent pas le clip ---------- */
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
    if (!recorder) return;
    if (document.hidden && recorder.state === 'recording') recorder.pause();
    else if (!document.hidden && recorder.state === 'paused') recorder.resume();
  }

  function endRecordingUI() {
    recording = false;
    clearInterval(endTimer);
    stopStream();
    unlockInput();
    document.removeEventListener('visibilitychange', onVisibility);
    document.body.classList.remove('is-recording');
    toggleUI(uiWasHidden);
    if (!soundWasOn && audio.enabled) toggleSound();
    document.title = BASE_TITLE;
    recBtn.disabled = !canRecord;
  }

  /* ==========================================================
     ENREGISTREMENT
     ========================================================== */
  async function startRecording() {
    if (!canRecord) { toast("L'enregistrement vidéo fonctionne sur ordinateur (Chrome, Edge ou Firefox)."); return; }
    if (recording) return;

    // Son activé pour la vidéo (remis comme avant à la fin)
    soundWasOn = audio.enabled;
    try { if (!soundWasOn) await toggleSound(); } catch (e) { /* le clip reste muet */ }

    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 60 },
        audio: true,
        preferCurrentTab: true,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude',
      });
    } catch (e) {
      if (!soundWasOn && audio.enabled) toggleSound();
      toast('Enregistrement annulé. Pour enregistrer, choisissez « Cet onglet » puis « Partager ».');
      return;
    }

    const tracks = [...stream.getVideoTracks()];
    const tabAudio = stream.getAudioTracks();
    if (tabAudio.length) tracks.push(tabAudio[0]);
    else { const inner = internalAudioTrack(); if (inner) tracks.push(inner); }

    const mime = pickMime();
    try {
      recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : { videoBitsPerSecond: 8e6 });
    } catch (e) {
      stopStream();
      if (!soundWasOn && audio.enabled) toggleSound();
      toast("Votre navigateur ne permet pas d'enregistrer cette vidéo. Essayez avec Chrome ou Edge.");
      return;
    }
    const ext = (recorder.mimeType || mime).includes('mp4') ? 'mp4' : 'webm';
    const fileName = `${FILE_BASE}.${ext}`;
    chunks = [];
    discardRec = false;
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      if (!discardRec && chunks.length) {
        const blob = new Blob(chunks, { type: (recorder.mimeType || 'video/' + ext).split(';')[0] });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        endRecordingUI();
        toast('Vidéo enregistrée : ' + fileName);
      } else {
        endRecordingUI();
      }
      chunks = [];
      recorder = null;
    };
    // Si l'utilisateur clique sur « Arrêter le partage »
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    });

    // Enregistrement propre : interface masquée, titre de l'onglet = indicateur
    recording = true;
    uiWasHidden = document.body.classList.contains('ui-hidden');
    document.body.classList.add('is-recording');
    toggleUI(true);
    lockInput();
    document.addEventListener('visibilitychange', onVisibility);
    document.title = '● REC — ' + BASE_TITLE;
    recBtn.disabled = true;

    recorder.start(1000);
    setTimeout(() => {
      if (!recording) return;
      replay();
      // À la fin du clip : on garde la dernière image puis la vidéo se télécharge
      endTimer = setInterval(() => {
        if (tl.progress() >= 1) {
          clearInterval(endTimer);
          setTimeout(() => { if (recorder && recorder.state !== 'inactive') recorder.stop(); }, 700);
        }
      }, 200);
    }, 600);
  }

  function cancelRecording() {
    if (!recording || !recorder) return;
    discardRec = true;
    if (recorder.state !== 'inactive') recorder.stop(); else endRecordingUI();
    toast('Enregistrement annulé.');
  }

  /* ---------- Événements ---------- */
  recBtn.addEventListener('click', startRecording);
  if (!canRecord) {
    recBtn.disabled = true;
    recBtn.hidden = true;
  }
}
