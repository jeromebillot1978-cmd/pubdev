/**
 * Jercat Dev — Clip publicitaire animé + VOIX OFF
 * Séquençage + particules GPU + compteurs + synthèse vocale
 */

(() => {
  'use strict';

  // ============================================================
  // CONFIG VOIX
  // ============================================================
  const USE_HUMAN_VOICE = false; // true = utilise le fichier MP3 (voir plus bas)
  const VOICE_LANG = 'fr-FR';
  const VOICE_RATE = 0.95;
  const VOICE_PITCH = 1.0;
  const VOICE_VOLUME = 1.0;

  // Scripts voix alignés sur la timeline des scènes
  const VOICE_SCRIPTS = [
    // Scène 1 (0–7s)
    "Vous avez besoin d'un site web qui convertit vraiment ?",
    // Scène 2 (7–16s)
    "Je conçois des sites vitrines, boutiques en ligne, applications web et interfaces sur mesure.",
    // Scène 3 (16–24s)
    "Performance maximale. Soixante images par seconde. Cent pour cent responsive.",
    // Scène 4 (24–32s)
    "Jercat Dev. Code. Design. Impact.",
    // Scène 5 (32–40s)
    "Prêt à démarrer votre projet ? Rendez-vous sur dev point jercat point fr."
  ];

  // Fichiers MP3 si USE_HUMAN_VOICE = true
  const VOICE_FILES = [
    'audio/scene1.mp3',
    'audio/scene2.mp3',
    'audio/scene3.mp3',
    'audio/scene4.mp3',
    'audio/scene5.mp3'
  ];

  // ============================================================
  // CONFIG SCÈNES
  // ============================================================
  const SCENES = [
    { id: 1, duration: 7000  },
    { id: 2, duration: 9000  },
    { id: 3, duration: 8000  },
    { id: 4, duration: 8000  },
    { id: 5, duration: 8000  }
  ];

  const TOTAL_DURATION = SCENES.reduce((sum, s) => sum + s.duration, 0);

  // ============================================================
  // DOM
  // ============================================================
  const progressFill  = document.getElementById('progressFill');
  const clip          = document.getElementById('clip');
  const controls      = document.getElementById('controls');
  const replayBtn     = document.getElementById('replayBtn');
  const soundToggle   = document.getElementById('soundToggle');
  const scenes        = Array.from(document.querySelectorAll('.scene'));

  // ============================================================
  // ÉTAT
  // ============================================================
  let startTime = null;
  let rafId = null;
  let currentSceneIndex = -1;
  let countersStarted = false;
  let voiceEnabled = false;   // désactivé par défaut (politique navigateur)
  let voiceReady = false;

  // ============================================================
  // VOIX OFF
  // ============================================================
  const voice = {
    synth: window.speechSynthesis,
    voices: [],
    currentUtterance: null,
    audio: null, // pour le mode MP3

    init() {
      if (USE_HUMAN_VOICE) {
        this.audio = new Audio();
        voiceReady = true;
        return;
      }
      if (!this.synth) {
        console.warn('⚠️ Web Speech API non supportée');
        return;
      }
      this.loadVoices();
      if (this.synth.onvoiceschanged !== undefined) {
        this.synth.onvoiceschanged = () => this.loadVoices();
      }
    },

    loadVoices() {
      this.voices = this.synth.getVoices() || [];
      const fr = this.voices.find(v => v.lang === VOICE_LANG)
              || this.voices.find(v => v.lang.startsWith('fr'));
      if (fr) {
        this.selectedVoice = fr;
        voiceReady = true;
        console.log('🗣️ Voix sélectionnée :', fr.name);
      }
    },

    speak(text) {
      if (!voiceEnabled) return;
      if (USE_HUMAN_VOICE) return; // géré par playFile()
      if (!this.synth) return;

      // Annuler toute locution en cours
      this.synth.cancel();

      const u = new SpeechSynthesisUtterance(text);
      u.lang = VOICE_LANG;
      u.rate = VOICE_RATE;
      u.pitch = VOICE_PITCH;
      u.volume = VOICE_VOLUME;
      if (this.selectedVoice) u.voice = this.selectedVoice;

      this.currentUtterance = u;
      this.synth.speak(u);
    },

    playFile(index) {
      if (!voiceEnabled || !this.audio) return;
      this.stopFile();
      this.audio.src = VOICE_FILES[index];
      this.audio.volume = VOICE_VOLUME;
      this.audio.play().catch(err => console.warn('Audio:', err));
    },

    stopFile() {
      if (this.audio) {
        this.audio.pause();
        this.audio.currentTime = 0;
      }
    },

    stop() {
      if (this.synth) this.synth.cancel();
      this.stopFile();
    }
  };

  voice.init();

  // ============================================================
  // BOUTON SON
  // ============================================================
  soundToggle.addEventListener('click', () => {
    voiceEnabled = !voiceEnabled;
    soundToggle.classList.toggle('on', voiceEnabled);
    soundToggle.setAttribute(
      'aria-label',
      voiceEnabled ? 'Désactiver le son' : 'Activer le son'
    );

    if (!voiceEnabled) {
      voice.stop();
    } else {
      // Rejouer la scène courante avec la voix
      if (currentSceneIndex >= 0) {
        speakScene(currentSceneIndex);
      }
    }
  });

  function speakScene(index) {
    if (!voiceEnabled) return;
    if (USE_HUMAN_VOICE) {
      voice.playFile(index);
    } else {
      voice.speak(VOICE_SCRIPTS[index]);
    }
  }

  // ============================================================
  // LANCEMENT
  // ============================================================
  function start() {
    cancelAnimationFrame(rafId);
    voice.stop();
    resetScenes();
    startTime = performance.now();
    currentSceneIndex = -1;
    countersStarted = false;
    controls.classList.remove('show');
    tick();
  }

  function resetScenes() {
    scenes.forEach(s => s.classList.remove('active'));
    document.querySelectorAll('.stat-number').forEach(el => {
      el.textContent = '0';
    });
  }

  // ============================================================
  // BOUCLE PRINCIPALE
  // ============================================================
  function tick() {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(elapsed / TOTAL_DURATION, 1);
    progressFill.style.width = (progress * 100) + '%';

    let acc = 0;
    let activeIndex = -1;
    for (let i = 0; i < SCENES.length; i++) {
      acc += SCENES[i].duration;
      if (elapsed < acc) {
        activeIndex = i;
        break;
      }
    }

    if (activeIndex !== currentSceneIndex && activeIndex !== -1) {
      currentSceneIndex = activeIndex;
      activateScene(activeIndex);
    }

    if (progress >= 1) {
      endClip();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  // ============================================================
  // ACTIVATION DE SCÈNE
  // ============================================================
  function activateScene(index) {
    scenes.forEach((s, i) => {
      s.classList.toggle('active', i === index);
    });

    // Déclencher la voix de la scène
    speakScene(index);

    // Compteurs scène 3
    if (SCENES[index].id === 3 && !countersStarted) {
      countersStarted = true;
      animateCounters();
    }
  }

  // ============================================================
  // COMPTEURS
  // ============================================================
  function animateCounters() {
    document.querySelectorAll('.stat-number').forEach((el, i) => {
      const target = parseInt(el.dataset.target, 10);
      const duration = 1600;
      const startDelay = i * 150;
      const startT = performance.now() + startDelay;

      function step(now) {
        const t = Math.max(0, now - startT);
        const p = Math.min(t / duration, 1);
        const eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
        el.textContent = Math.round(eased * target);
        if (p < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  // ============================================================
  // FIN DU CLIP
  // ============================================================
  function endClip() {
    progressFill.style.width = '100%';
    controls.classList.add('show');
  }

  // ============================================================
  // REPLAY
  // ============================================================
  replayBtn.addEventListener('click', () => {
    clip.style.transition = 'opacity 0.4s';
    clip.style.opacity = '0';
    setTimeout(() => {
      start();
      clip.style.opacity = '1';
    }, 400);
  });

  // ============================================================
  // PARTICULES GPU
  // ============================================================
  const canvas = document.getElementById('particles');
  const ctx = canvas.getContext('2d');
  let particles = [];
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function createParticles() {
    const count = window.innerWidth < 768 ? 45 : 90;
    particles = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * window.innerWidth,
        y: Math.random() * window.innerHeight,
        r: Math.random() * 2 + 0.5,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        hue: Math.random() > 0.5 ? 190 : 265,
        alpha: Math.random() * 0.5 + 0.2
      });
    }
  }

  let lastFrame = 0;
  function drawParticles(now) {
    requestAnimationFrame(drawParticles);
    if (now - lastFrame < 14) return;
    lastFrame = now;

    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.x < 0) p.x = w;
      if (p.x > w) p.x = 0;
      if (p.y < 0) p.y = h;
      if (p.y > h) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 90%, 65%, ${p.alpha})`;
      ctx.fill();
    }

    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist2 = dx * dx + dy * dy;
        if (dist2 < 12000) {
          const alpha = (1 - dist2 / 12000) * 0.15;
          ctx.strokeStyle = `rgba(34, 211, 238, ${alpha})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
  }

  // ============================================================
  // INIT
  // ============================================================
  function init() {
    resizeCanvas();
    createParticles();
    requestAnimationFrame(drawParticles);
    start();
  }

  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      resizeCanvas();
      createParticles();
    }, 200);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
      voice.stop();
    } else {
      const elapsed = performance.now() - startTime;
      if (elapsed < TOTAL_DURATION) {
        tick();
        // Relancer la voix de la scène courante
        if (voiceEnabled && currentSceneIndex >= 0) {
          speakScene(currentSceneIndex);
        }
      }
    }
  });

  // Couper la voix quand on quitte la page
  window.addEventListener('beforeunload', () => voice.stop());

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
