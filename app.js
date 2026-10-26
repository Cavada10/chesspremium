/* ==========================================================================
   chesspremium — app.js
   --------------------------------------------------------------------------
   Librerie (da CDN, gratuite):
     • jQuery + chessboard.js  → interfaccia della scacchiera
     • chess.js 0.10.x          → regole, mosse legali, PGN, matto/patta
     • PeerJS                   → connessioni P2P (amici, sfide, stanze)
     • Stockfish.js (Worker)    → bot e revisione della partita

   Indice del file
     1. Utilità e costanti
     2. Profilo locale (username + ID amico)
     3. Interfaccia base (toast, modali, tab, tema)
     4. Motore Stockfish (Web Worker)
     5. Stato della partita e regole
     6. Rendering (scacchiera, mosse, barre giocatore, valutazione)
     7. Input sulla scacchiera (drag & drop + click)
     8. Bot
     9. Revisione partita
    10. Rete P2P: amici, sfide, stanze
    11. Azioni dell'interfaccia e avvio
   ========================================================================== */
(function () {
  'use strict';

  /* ======================================================================
     1. UTILITÀ E COSTANTI
     ====================================================================== */
  const $ = window.jQuery;
  const byId = (id) => document.getElementById(id);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Piccolo wrapper di localStorage con prefisso e JSON (non esplode se non disponibile). */
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('cp.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('cp.' + key, JSON.stringify(value)); } catch (e) { /* ignora */ }
    }
  };

  /** Nomi e ID provenienti dalla rete vengono sempre "ripuliti". */
  const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 20);
  const cleanId = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);

  function genId(len) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // niente I, O, 0, 1 (ambigui)
    let out = '';
    const bytes = new Uint8Array(len);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
    else for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256);
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
  }

  // Immagini dei pezzi (tema "wikipedia" ufficiale di chessboard.js) + host di riserva.
  const PIECE_HOSTS = [
    'https://chessboardjs.com/img/chesspieces/wikipedia/',
    'https://koblenski.github.io/javascript/chessboardjs-0.3.0/img/chesspieces/wikipedia/'
  ];
  const pieceUrl = (code) => PIECE_HOSTS[0] + code + '.png';
  // Se un'immagine non si carica dal primo host, prova il secondo.
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && typeof t.src === 'string' && t.src.indexOf(PIECE_HOSTS[0]) === 0) {
      t.src = PIECE_HOSTS[1] + t.src.slice(PIECE_HOSTS[0].length);
    }
  }, true);

  const PEER_USER = 'chesspremium-u-';   // prefisso ID PeerJS degli utenti
  const PEER_ROOM = 'chesspremium-r-';   // prefisso ID PeerJS delle stanze
  const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };

  const BOT_LEVELS = {
    1: { name: 'Principiante', skill: 0, depth: 1, time: 150 },
    2: { name: 'Facile', skill: 4, depth: 3, time: 400 },
    3: { name: 'Intermedio', skill: 9, depth: 6, time: 800 },
    4: { name: 'Esperto', skill: 15, depth: 9, time: 1400 },
    5: { name: 'Maestro', skill: 20, depth: 12, time: 2200 }
  };

  // Classificazione delle mosse nella revisione
  const CLASSES = [
    { key: 'best', label: 'Migliore', sym: '★' },
    { key: 'excellent', label: 'Ottima', sym: '!' },
    { key: 'good', label: 'Buona', sym: '✓' },
    { key: 'inaccuracy', label: 'Imprecisione', sym: '?!' },
    { key: 'mistake', label: 'Errore', sym: '?' },
    { key: 'blunder', label: 'Svista', sym: '??' }
  ];
  const CLS = {};
  CLASSES.forEach((c) => { CLS[c.key] = c; });

  /* ======================================================================
     2. PROFILO LOCALE
     ====================================================================== */
  const profile = (function () {
    let p = store.get('profile', null);
    if (!p || !p.id || !p.name) {
      p = { id: genId(6), name: 'Giocatore' + (100 + Math.floor(Math.random() * 900)) };
      store.set('profile', p);
    }
    return p;
  })();

  let friends = store.get('friends', []);
  if (!Array.isArray(friends)) friends = [];
  friends = friends.filter((f) => f && typeof f.id === 'string');
  const saveFriends = () => store.set('friends', friends);

  /* ======================================================================
     3. INTERFACCIA BASE: toast, modali, tab, tema, appunti
     ====================================================================== */
  function toast(message, kind) {
    const box = byId('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  const openModal = (id) => { byId(id).hidden = false; };
  const closeModal = (id) => { byId(id).hidden = true; };

  /** Finestra di conferma generica. Restituisce una Promise<boolean>. */
  let confirmState = null;
  function askConfirm(opts) {
    if (confirmState) closeConfirm(false);
    byId('confirm-title').textContent = opts.title || 'Conferma';
    byId('confirm-text').textContent = opts.text || '';
    const okBtn = byId('confirm-ok');
    okBtn.hidden = !opts.ok;
    if (opts.ok) okBtn.textContent = opts.ok;
    byId('confirm-cancel').textContent = opts.cancel || 'Annulla';
    openModal('modal-confirm');
    return new Promise((resolve) => {
      confirmState = {
        resolve: resolve,
        timer: opts.timeout ? setTimeout(() => closeConfirm(false), opts.timeout) : null
      };
    });
  }
  function closeConfirm(value) {
    const st = confirmState;
    if (!st) return;
    confirmState = null;
    clearTimeout(st.timer);
    closeModal('modal-confirm');
    st.resolve(value);
  }

  function switchTab(name) {
    qsa('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    qsa('.nav-link').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
    qsa('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'tab-' + name));
    if (name === 'friends') refreshPresence();
  }

  function setUiMode(mode) {
    qsa('#mode-switch button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === mode));
    qsa('.mode-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'opt-' + mode));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    store.set('theme', theme);
  }

  async function copyText(text, okMessage) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast(okMessage || 'Copiato negli appunti');
    } catch (e) {
      toast('Copia non riuscita: seleziona e copia a mano', 'warn');
    }
  }

  /* ======================================================================
     4. MOTORE STOCKFISH (Web Worker)
     --------------------------------------------------------------------------
     Ordine di caricamento:
       1) "stockfish.js" accanto a index.html (copia locale, se la aggiungi)
       2) Stockfish.js 10 da cdnjs, caricato in un worker "blob" (evita i
          blocchi cross-origin dei Worker)
     Se nessuno funziona il gioco resta usabile: il bot gioca mosse casuali
     e la revisione mostra un messaggio.
     ====================================================================== */
  const SF_SOURCES = [
    { mode: 'direct', url: 'stockfish.js' },
    { mode: 'blob', url: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.js' },
    { mode: 'blob', url: 'https://cdnjs.cloudflare.com/ajax/libs/stockfish.js/10.0.2/stockfish.min.js' }
  ];

  class Engine {
    constructor() {
      this.worker = null;
      this.initPromise = null;
      this.queue = [];
      this.running = false;
      this.current = null;
    }

    /** Carica il worker (una sola volta). Se fallisce, la Promise resta respinta. */
    init() {
      if (this.initPromise) return this.initPromise;
      this.initPromise = (async () => {
        for (const src of SF_SOURCES) {
          try {
            const w = await this._tryLoad(src);
            w.onmessage = (ev) => this._onLine(String(ev && ev.data !== undefined ? ev.data : ev));
            w.onerror = () => {
              const cur = this.current;
              this.current = null;
              this.worker = null;
              this.initPromise = null; // al prossimo uso si ricarica
              if (cur) cur.reject(new Error('Il motore si è interrotto'));
            };
            this.worker = w;
            return;
          } catch (e) { /* prova la sorgente successiva */ }
        }
        throw new Error('Stockfish non disponibile');
      })();
      return this.initPromise;
    }

    _tryLoad(src) {
      return new Promise((resolve, reject) => {
        let w;
        try {
          if (src.mode === 'blob') {
            const blob = new Blob(['importScripts(' + JSON.stringify(src.url) + ');'], { type: 'application/javascript' });
            w = new Worker(URL.createObjectURL(blob));
          } else {
            w = new Worker(src.url);
          }
        } catch (e) { reject(e); return; }

        let step = 'uci';
        const fail = (err) => {
          clearTimeout(timer);
          try { w.terminate(); } catch (e) { /* ignora */ }
          reject(err);
        };
        const timer = setTimeout(() => fail(new Error('timeout')), 20000);
        w.onerror = () => fail(new Error('worker error'));
        w.onmessage = (ev) => {
          const line = String(ev && ev.data !== undefined ? ev.data : ev);
          if (step === 'uci' && line.indexOf('uciok') >= 0) {
            step = 'ready';
            w.postMessage('isready');
          } else if (step === 'ready' && line.indexOf('readyok') >= 0) {
            clearTimeout(timer);
            resolve(w);
          }
        };
        w.postMessage('uci');
      });
    }

    /**
     * Mette in coda una ricerca. opts: { depth, movetime, skill }.
     * Risolve con { bestmove, cp, mate, pv, depth } dal punto di vista di chi muove.
     */
    search(fen, opts) {
      return new Promise((resolve, reject) => {
        this.queue.push({ fen: fen, opts: opts || {}, resolve: resolve, reject: reject });
        this._pump();
      });
    }

    async _pump() {
      if (this.running) return;
      this.running = true;
      while (this.queue.length) {
        const job = this.queue.shift();
        try {
          await this.init();
          job.resolve(await this._run(job));
        } catch (e) {
          job.reject(e);
        }
      }
      this.running = false;
    }

    _run(job) {
      return new Promise((resolve, reject) => {
        const w = this.worker;
        if (!w) { reject(new Error('Motore non pronto')); return; }
        const o = job.opts;
        this.current = { resolve: resolve, reject: reject, info: { cp: null, mate: null, pv: '', depth: 0 } };
        w.postMessage('setoption name Skill Level value ' + (o.skill == null ? 20 : o.skill));
        w.postMessage('position fen ' + job.fen);
        let go = 'go';
        if (o.depth) go += ' depth ' + o.depth;
        if (o.movetime) go += ' movetime ' + o.movetime;
        if (go === 'go') go += ' depth 10';
        w.postMessage(go);
      });
    }

    _onLine(line) {
      const cur = this.current;
      if (!cur) return;
      if (line.indexOf('info') === 0 && line.indexOf(' score ') > 0 && line.indexOf(' pv ') > 0 &&
          !/(lower|upper)bound/.test(line)) {
        const score = line.match(/ score (cp|mate) (-?\d+)/);
        const depth = line.match(/ depth (\d+)/);
        const pv = line.match(/ pv (.+)$/);
        if (score) {
          if (depth) cur.info.depth = +depth[1];
          if (score[1] === 'cp') { cur.info.cp = +score[2]; cur.info.mate = null; }
          else { cur.info.mate = +score[2]; cur.info.cp = null; }
          if (pv) cur.info.pv = pv[1].trim();
        }
      } else if (line.indexOf('bestmove') === 0) {
        const bm = line.split(/\s+/)[1];
        this.current = null;
        cur.resolve({
          bestmove: bm && bm !== '(none)' ? bm : null,
          cp: cur.info.cp, mate: cur.info.mate, pv: cur.info.pv, depth: cur.info.depth
        });
      }
    }

    /** Annulla la coda e ferma la ricerca in corso (la sua Promise si risolve comunque). */
    cancelAll() {
      const pending = this.queue.splice(0);
      pending.forEach((j) => j.reject(new Error('cancelled')));
      if (this.current && this.worker) this.worker.postMessage('stop');
    }
  }
  const engine = new Engine();

  /* ======================================================================
     5. STATO DELLA PARTITA E REGOLE
     ====================================================================== */
  const newReview = () => ({ status: 'idle', progress: 0, evals: [], cls: [], summary: null, error: null });

  const S = {
    mode: 'bot',              // 'bot' | 'local' | 'online'
    game: null,               // istanza chess.js (partita "viva")
    fens: [],                 // fens[i] = posizione dopo i semimosse
    moves: [],                // mosse verbose di chess.js
    view: 0,                  // semimossa mostrata sulla scacchiera
    orientation: 'white',
    myColor: 'w',             // colore umano (bot/online); in locale non usato
    botColor: 'b',
    botLevel: 3,
    botBusy: false,
    botToken: 0,
    over: false,
    result: null,             // { winner, reason, text, interrupted }
    online: null,             // { conn, color, oppName, oppId, drawPending }
    selected: null,           // casa selezionata (click-to-move)
    targets: [],              // [{ to, capture }]
    review: newReview(),
    reviewToken: 0,
    promoCb: null
  };

  let board = null; // istanza chessboard.js

  /** Ricostruisce la lista di FEN e di mosse a partire da S.game. */
  function rebuild() {
    const hist = S.game.history({ verbose: true });
    const c = new window.Chess();
    const fens = [c.fen()];
    for (let i = 0; i < hist.length; i++) {
      c.move({ from: hist[i].from, to: hist[i].to, promotion: hist[i].promotion });
      fens.push(c.fen());
    }
    S.moves = hist;
    S.fens = fens;
  }

  /** Azzera tutto per iniziare una nuova partita. keepConn = connessione da NON chiudere. */
  function resetState(mode, extra, keepConn) {
    S.botToken++;
    S.botBusy = false;
    S.reviewToken++;
    engine.cancelAll();
    closeOnlineSession(keepConn);
    S.game = new window.Chess();
    S.mode = mode;
    S.over = false;
    S.result = null;
    S.selected = null;
    S.targets = [];
    S.review = newReview();
    Object.assign(S, extra || {});
    rebuild();
    S.view = 0;
    if (S.mode !== 'online') S.online = null;
  }

  const playerName = (color) => {
    if (S.mode === 'bot') return color === S.myColor ? profile.name : 'Stockfish · ' + BOT_LEVELS[S.botLevel].name;
    if (S.mode === 'online' && S.online) return color === S.online.color ? profile.name : S.online.oppName;
    return color === 'w' ? 'Bianco' : 'Nero';
  };

  const inOnlineGame = () => S.mode === 'online' && !!S.online && !S.over;

  function myTurn() {
    const t = S.game.turn();
    if (S.mode === 'local') return true;
    if (S.mode === 'bot') return t === S.myColor;
    return !!S.online && t === S.online.color;
  }
  const atLivePosition = () => S.view === S.fens.length - 1;
  const canMoveNow = () => !S.over && atLivePosition() && !S.botBusy && myTurn();

  function setResult(res) {
    if (S.over) return;
    const side = (c) => (c === 'w' ? 'Bianco' : 'Nero') + (S.mode === 'local' ? '' : ' (' + playerName(c) + ')');
    let text;
    if (res.interrupted) text = 'Partita interrotta: ' + res.reason + '.';
    else if (res.winner) text = 'Vince il ' + side(res.winner) + ' per ' + res.reason + '.';
    else text = 'Patta per ' + res.reason + '.';
    S.over = true;
    S.result = { winner: res.winner || null, reason: res.reason, text: text, interrupted: !!res.interrupted };
    S.selected = null;
    S.targets = [];
  }

  /** Controlla se la partita è finita secondo le regole degli scacchi. */
  function checkGameEnd() {
    if (S.over) return;
    const g = S.game;
    if (g.in_checkmate()) setResult({ winner: g.turn() === 'w' ? 'b' : 'w', reason: 'scacco matto' });
    else if (g.in_stalemate()) setResult({ winner: null, reason: 'stallo' });
    else if (g.insufficient_material()) setResult({ winner: null, reason: 'materiale insufficiente' });
    else if (g.in_threefold_repetition()) setResult({ winner: null, reason: 'tripla ripetizione' });
    else if (g.in_draw()) setResult({ winner: null, reason: 'regola delle 50 mosse' });
  }

  function concludeGame() {
    renderAll();
    onGameOver();
  }

  function onGameOver() {
    const r = S.result;
    if (!r) return;
    let title = 'Partita terminata';
    const mine = S.mode === 'bot' ? S.myColor : (S.mode === 'online' && S.online ? S.online.color : null);
    if (r.interrupted) title = 'Partita interrotta';
    else if (!r.winner) title = 'Patta';
    else if (mine) title = r.winner === mine ? 'Hai vinto! 🎉' : 'Hai perso';
    byId('over-title').textContent = title;
    byId('over-text').textContent = r.text;
    setTimeout(() => { if (S.over) openModal('modal-over'); }, 450);
  }

  /**
   * Esegue una mossa sulla partita viva.
   * opts: { fromDrag, send, remote }
   * Restituisce la mossa (oggetto chess.js) oppure null se illegale.
   */
  function commitMove(from, to, promo, opts) {
    opts = opts || {};
    if (S.over) return null;
    const m = S.game.move({ from: from, to: to, promotion: promo || 'q' });
    if (!m) return null;
    resetReview();
    rebuild();
    S.view = S.fens.length - 1;
    S.selected = null;
    S.targets = [];
    if (opts.send && S.mode === 'online' && S.online) {
      safeSend(S.online.conn, { t: 'move', from: from, to: to, promotion: m.promotion || null });
      S.online.drawPending = false;
    }
    checkGameEnd();
    renderAll({ skipBoard: !!opts.fromDrag, animate: true });
    if (S.over) onGameOver();
    else maybeBot();
    return m;
  }

  /**
   * Tenta una mossa dell'utente.
   * Ritorna true (eseguita), 'promo' (in attesa della scelta del pezzo) o false (illegale).
   */
  function attemptMove(from, to, promo, fromDrag) {
    if (!canMoveNow()) return false;
    const cands = S.game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
    if (!cands.length) return false;
    if (cands[0].promotion && !promo) {
      askPromotion(S.game.turn(), (piece) => {
        if (canMoveNow()) commitMove(from, to, piece, { send: true });
      });
      return 'promo';
    }
    return !!commitMove(from, to, promo, { fromDrag: fromDrag, send: true });
  }

  function askPromotion(color, cb) {
    const box = byId('promo-choices');
    box.innerHTML = ['q', 'r', 'b', 'n'].map((t) =>
      '<button type="button" data-p="' + t + '" aria-label="' + t + '"><img alt="" src="' + pieceUrl(color + t.toUpperCase()) + '"></button>'
    ).join('');
    S.promoCb = cb;
    openModal('modal-promo');
  }

  function undoMove() {
    if (!canUndo()) return;
    const n = S.mode === 'bot' ? 2 : 1;
    for (let i = 0; i < n; i++) S.game.undo();
    resetReview();
    rebuild();
    S.view = S.fens.length - 1;
    S.selected = null;
    S.targets = [];
    renderAll({ animate: true });
  }
  function canUndo() {
    if (S.over || S.botBusy) return false;
    if (S.mode === 'local') return S.moves.length >= 1;
    if (S.mode === 'bot') return S.moves.length >= 2 && S.game.turn() === S.myColor;
    return false;
  }

  /* ======================================================================
     6. RENDERING
     ====================================================================== */
  function renderAll(opts) {
    opts = opts || {};
    if (board && !opts.skipBoard) syncBoard(opts.animate);
    refreshHighlights();
    drawOverlay();
    renderMoves();
    renderPlayers();
    renderStatus();
    renderEval();
    renderControls();
    renderReviewPanel();
  }

  function syncBoard(animate) {
    if (board.orientation() !== S.orientation) board.orientation(S.orientation);
    board.position(S.fens[S.view], !!animate);
  }

  function kingSquare(chess, color) {
    const b = chess.board();
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = b[r][f];
        if (p && p.type === 'k' && p.color === color) return 'abcdefgh'[f] + (8 - r);
      }
    }
    return null;
  }

  function refreshHighlights() {
    if (!board) return;
    $('#board .square-55d63').removeClass('hl-last hl-sel hl-check hint hint-cap');
    const m = S.moves[S.view - 1];
    if (m) {
      $('#board .square-' + m.from).addClass('hl-last');
      $('#board .square-' + m.to).addClass('hl-last');
    }
    const c = atLivePosition() ? S.game : new window.Chess(S.fens[S.view]);
    if (c.in_check()) {
      const ks = kingSquare(c, c.turn());
      if (ks) $('#board .square-' + ks).addClass('hl-check');
    }
    if (S.selected) {
      $('#board .square-' + S.selected).addClass('hl-sel');
      S.targets.forEach((t) => $('#board .square-' + t.to).addClass(t.capture ? 'hint-cap' : 'hint'));
    }
  }

  /* ---- frecce SVG sulla scacchiera ---- */
  function sqCenter(sq) {
    const f = 'abcdefgh'.indexOf(sq[0]);
    const r = parseInt(sq[1], 10) - 1;
    return S.orientation === 'white'
      ? [f * 100 + 50, (7 - r) * 100 + 50]
      : [(7 - f) * 100 + 50, r * 100 + 50];
  }
  function arrowSvg(from, to) {
    const a = sqCenter(from), b = sqCenter(to);
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const head = 38, hw = 26;
    const bx = b[0] - ux * head, by = b[1] - uy * head;
    const sx = a[0] + ux * 18, sy = a[1] + uy * 18;
    const px = -uy, py = ux;
    return '<line x1="' + sx + '" y1="' + sy + '" x2="' + bx + '" y2="' + by + '" style="stroke:var(--arrow)" stroke-width="18" stroke-linecap="round"/>' +
      '<polygon style="fill:var(--arrow)" points="' + b[0] + ',' + b[1] + ' ' + (bx + px * hw) + ',' + (by + py * hw) + ' ' + (bx - px * hw) + ',' + (by - py * hw) + '"/>';
  }
  function drawOverlay() {
    let html = '';
    if (S.review.status === 'done' && S.view > 0) {
      const c = S.review.cls[S.view - 1];
      if (c && c.key !== 'best' && c.best) html = arrowSvg(c.best.slice(0, 2), c.best.slice(2, 4));
    }
    byId('overlay').innerHTML = html;
  }

  /* ---- elenco mosse ---- */
  function moveButton(ply, m) {
    const c = S.review.status === 'done' ? S.review.cls[ply - 1] : null;
    const badge = c ? '<i class="badge k-' + c.key + '" title="' + CLS[c.key].label + '">' + CLS[c.key].sym + '</i>' : '';
    return '<button type="button" class="mv' + (ply === S.view ? ' is-current' : '') + '" data-ply="' + ply + '">' + esc(m.san) + badge + '</button>';
  }
  function renderMoves() {
    const list = byId('move-list');
    let html = '';
    for (let i = 0; i < S.moves.length; i += 2) {
      html += '<div class="move-row"><span class="mn">' + (i / 2 + 1) + '.</span>' +
        moveButton(i + 1, S.moves[i]) +
        (S.moves[i + 1] ? moveButton(i + 2, S.moves[i + 1]) : '<span class="mv-empty"></span>') + '</div>';
    }
    list.innerHTML = html;
    const cur = list.querySelector('.is-current');
    if (!cur) list.scrollTop = 0;
    else if (S.view === S.moves.length) list.scrollTop = list.scrollHeight;
    else list.scrollTop = Math.max(0, cur.offsetTop - list.clientHeight / 2);
  }

  /* ---- barre dei giocatori (nomi, pezzi catturati, materiale) ---- */
  function materialInfo(fen) {
    const cnt = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
    const placement = fen.split(' ')[0];
    for (const ch of placement) {
      if (/[pnbrqPNBRQ]/.test(ch)) cnt[ch === ch.toLowerCase() ? 'b' : 'w'][ch.toLowerCase()]++;
    }
    const total = (c) => Object.keys(PIECE_VALUE).reduce((s, k) => s + cnt[c][k] * PIECE_VALUE[k], 0);
    return { cnt: cnt, diff: total('w') - total('b') };
  }
  function fillPlayerBar(bar, color) {
    const name = playerName(color);
    const info = materialInfo(S.fens[S.view]);
    const enemy = color === 'w' ? 'b' : 'w';
    // Pezzi avversari catturati da questo giocatore
    let caps = '';
    ['q', 'r', 'b', 'n', 'p'].forEach((t) => {
      const n = Math.max(0, START_COUNT[t] - info.cnt[enemy][t]);
      for (let i = 0; i < n; i++) caps += '<img alt="" src="' + pieceUrl(enemy + t.toUpperCase()) + '">';
    });
    const lead = color === 'w' ? info.diff : -info.diff;
    bar.querySelector('[data-role="avatar"]').textContent = (Array.from(name)[0] || '?').toUpperCase();
    const nameEl = bar.querySelector('[data-role="name"]');
    nameEl.textContent = name;
    if (!S.over && S.game.turn() === color && atLivePosition()) {
      const dot = document.createElement('i');
      dot.className = 'turn-dot';
      nameEl.appendChild(dot);
    }
    bar.querySelector('[data-role="captured"]').innerHTML = caps;
    bar.querySelector('[data-role="material"]').textContent = lead > 0 ? '+' + lead : '';
  }
  function renderPlayers() {
    const bottom = S.orientation === 'white' ? 'w' : 'b';
    fillPlayerBar(byId('bar-bottom'), bottom);
    fillPlayerBar(byId('bar-top'), bottom === 'w' ? 'b' : 'w');
  }

  function renderStatus() {
    const el = byId('status');
    el.classList.toggle('is-over', S.over);
    let txt;
    if (S.over) {
      txt = S.result.text;
    } else if (!atLivePosition()) {
      txt = 'Stai rivedendo la mossa ' + S.view + ' di ' + S.moves.length + ' — premi ⏭ per tornare alla partita.';
    } else if (S.botBusy) {
      txt = '🤖 Il bot sta pensando…';
    } else {
      const t = S.game.turn();
      const side = t === 'w' ? 'Bianco' : 'Nero';
      const check = S.game.in_check() ? ' — Scacco!' : '';
      if (S.mode === 'online' && S.online) {
        txt = t === S.online.color ? 'È il tuo turno (' + side + ')' + check : 'In attesa della mossa di ' + S.online.oppName + check;
      } else if (S.mode === 'bot') {
        txt = t === S.myColor ? 'È il tuo turno (' + side + ')' + check : 'Tocca al bot' + check;
      } else {
        txt = 'Tocca al ' + side + check;
      }
    }
    el.textContent = txt;
  }

  /* ---- barra di valutazione ---- */
  function winProb(cp) {
    const c = Math.max(-1000, Math.min(1000, cp || 0));
    return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
  }
  /** Probabilità di vittoria del Bianco (0-100) per una valutazione "dal lato del Bianco". */
  function wpOf(ev) {
    if (!ev) return 50;
    if (ev.term === 'mate') return ev.winner === 'w' ? 100 : 0;
    if (ev.term === 'draw') return 50;
    if (ev.mate != null) return ev.mate > 0 ? 100 : 0;
    return winProb(ev.cp);
  }
  function evShort(ev) {
    if (ev.term === 'mate') return ev.winner === 'w' ? '1-0' : '0-1';
    if (ev.term === 'draw') return '½';
    if (ev.mate != null) return 'M' + Math.abs(ev.mate);
    return (Math.abs(ev.cp) / 100).toFixed(1);
  }
  function evSigned(ev) {
    if (!ev) return '–';
    if (ev.term === 'mate') return ev.winner === 'w' ? '1-0' : '0-1';
    if (ev.term === 'draw') return '0.0';
    if (ev.mate != null) return (ev.mate > 0 ? '+' : '-') + 'M' + Math.abs(ev.mate);
    const v = (ev.cp / 100).toFixed(1);
    return (ev.cp > 0 ? '+' : '') + v;
  }
  function renderEval() {
    const bar = byId('eval-bar'), fill = byId('eval-fill'), label = byId('eval-label');
    bar.classList.toggle('flipped', S.orientation === 'black');
    const ev = S.review.status !== 'idle' ? S.review.evals[S.view] : null;
    const wp = ev ? wpOf(ev) : 50;
    fill.style.height = wp + '%';
    if (!ev) { label.textContent = ''; label.className = 'eval-label'; return; }
    const whiteLeads = wp >= 50;
    const whiteAtBottom = S.orientation === 'white';
    const atBottom = whiteLeads ? whiteAtBottom : !whiteAtBottom;
    label.textContent = evShort(ev);
    label.className = 'eval-label ' + (atBottom ? 'at-bottom' : 'at-top') + ' ' + (whiteLeads ? 'on-light' : 'on-dark');
  }

  /* ---- pulsanti attivi/disattivi ---- */
  function renderControls() {
    const last = S.fens.length - 1;
    byId('nav-first').disabled = S.view === 0;
    byId('nav-prev').disabled = S.view === 0;
    byId('nav-next').disabled = S.view === last;
    byId('nav-last').disabled = S.view === last;
    byId('btn-undo').disabled = !canUndo();
    byId('btn-resign').disabled = S.over || (S.mode !== 'online' && S.moves.length === 0);
    const drawBtn = byId('btn-draw');
    drawBtn.disabled = S.over || S.mode === 'bot' || (S.mode === 'local' && S.moves.length === 0) ||
      (S.mode === 'online' && (!S.online || S.online.drawPending));
    drawBtn.title = S.mode === 'bot' ? 'Il bot non accetta patte' : 'Proponi la patta';
    byId('btn-copy-pgn').disabled = S.moves.length === 0;
  }

  /* ======================================================================
     7. INPUT SULLA SCACCHIERA
     ====================================================================== */
  function selectSquare(sq) {
    S.selected = sq;
    S.targets = S.game.moves({ square: sq, verbose: true }).map((m) => ({
      to: m.to, capture: !!m.captured || (m.flags || '').indexOf('e') >= 0
    }));
    refreshHighlights();
  }
  function clearSelection() {
    if (!S.selected) return;
    S.selected = null;
    S.targets = [];
    refreshHighlights();
  }

  function onDragStart(source, piece) {
    if (!canMoveNow() || piece[0] !== S.game.turn()) {
      clearSelection();
      return false;
    }
    selectSquare(source);
    return true;
  }
  function onDrop(source, target) {
    if (target === 'offboard' || source === target) return 'snapback';
    const r = attemptMove(source, target, null, true);
    return r === true ? undefined : 'snapback';
  }
  function onSnapEnd() {
    // Riallinea la scacchiera (arrocco, en passant, promozione)
    if (board) board.position(S.fens[S.view], false);
    refreshHighlights();
  }
  function onSquareClick(sq) {
    if (!sq || !canMoveNow()) { clearSelection(); return; }
    if (S.selected && S.targets.some((t) => t.to === sq)) {
      attemptMove(S.selected, sq, null, false);
      return;
    }
    clearSelection();
  }

  function goTo(ply) {
    const p = Math.max(0, Math.min(S.fens.length - 1, ply));
    if (p === S.view) return;
    S.view = p;
    S.selected = null;
    S.targets = [];
    renderAll({ animate: true });
  }

  /* ======================================================================
     8. BOT
     ====================================================================== */
  let engineWarned = false;

  function maybeBot() {
    if (S.mode === 'bot' && !S.over && S.game.turn() === S.botColor) scheduleBot();
  }

  async function scheduleBot() {
    if (S.botBusy || S.over) return;
    S.botBusy = true;
    const token = ++S.botToken;
    renderStatus();
    renderControls();
    const lvl = BOT_LEVELS[S.botLevel];
    const t0 = performance.now();
    let uci = null;
    try {
      const r = await engine.search(S.game.fen(), { depth: lvl.depth, movetime: lvl.time, skill: lvl.skill });
      uci = r.bestmove;
    } catch (e) {
      if (token !== S.botToken) return; // partita annullata nel frattempo
      if (!engineWarned) {
        engineWarned = true;
        toast('Stockfish non è disponibile: il bot gioca mosse casuali.', 'warn');
      }
    }
    if (token !== S.botToken) return;
    const wait = Math.max(0, 350 - (performance.now() - t0)); // piccola pausa "umana"
    if (wait) await sleep(wait);
    if (token !== S.botToken) return;
    S.botBusy = false;

    const legal = S.game.moves({ verbose: true });
    let mv = uci ? legal.find((m) => m.from + m.to + (m.promotion || '') === uci) : null;
    if (!mv) mv = legal[Math.floor(Math.random() * legal.length)];
    if (mv) commitMove(mv.from, mv.to, mv.promotion, {});
    else renderAll();
  }

  /* ======================================================================
     9. REVISIONE PARTITA
     ====================================================================== */
  function resetReview() {
    if (S.review.status === 'idle' && !S.review.error) return;
    const wasRunning = S.review.status === 'running';
    S.reviewToken++;
    S.review = newReview();
    if (wasRunning) engine.cancelAll();
  }

  /** Valutazione "esatta" per posizioni terminali (matto/patta), senza interrogare il motore. */
  function terminalEval(fen) {
    const c = new window.Chess(fen);
    if (c.in_checkmate()) return { term: 'mate', winner: c.turn() === 'w' ? 'b' : 'w', cp: null, mate: null, best: null };
    if (c.in_draw() || c.in_stalemate() || c.insufficient_material()) return { term: 'draw', cp: 0, mate: null, best: null };
    return null;
  }

  /** Converte il risultato UCI (dal lato di chi muove) in valutazione dal lato del Bianco. */
  function toWhiteEval(r, fen) {
    const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
    if (r.mate != null) return { cp: null, mate: sign * r.mate, best: r.bestmove, pv: r.pv };
    return { cp: sign * (r.cp || 0), mate: null, best: r.bestmove, pv: r.pv };
  }

  function uciToSan(fen, uci) {
    try {
      const c = new window.Chess(fen);
      const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined });
      return mv ? mv.san : uci;
    } catch (e) { return uci; }
  }

  async function runReview() {
    if (S.moves.length === 0) { toast('Gioca almeno una mossa prima di analizzare.', 'warn'); return; }
    if (S.botBusy) { toast('Attendi la mossa del bot.', 'warn'); return; }
    if (S.review.status === 'running') return;

    const token = ++S.reviewToken;
    const fens = S.fens.slice();
    const moves = S.moves.slice();
    const R = newReview();
    R.status = 'running';
    R.evals = new Array(fens.length).fill(null);
    S.review = R;
    S.view = 0;
    renderAll({ animate: false });

    const depth = parseInt(byId('review-depth').value, 10) || 11;
    const cap = depth <= 8 ? 900 : (depth <= 11 ? 1600 : 3800);

    try {
      for (let i = 0; i < fens.length; i++) {
        if (token !== S.reviewToken) return;
        const term = terminalEval(fens[i]);
        if (term) {
          R.evals[i] = term;
        } else {
          const r = await engine.search(fens[i], { depth: depth, movetime: cap, skill: 20 });
          if (token !== S.reviewToken) return;
          R.evals[i] = toWhiteEval(r, fens[i]);
        }
        R.progress = (i + 1) / fens.length;
        renderReviewPanel();
      }
    } catch (e) {
      if (token !== S.reviewToken) return;
      R.status = 'idle';
      R.error = 'Stockfish non è disponibile (connessione o browser non supportato). ' +
        'Puoi scaricare stockfish.js e metterlo accanto a index.html.';
      toast('Impossibile avviare Stockfish per la revisione.', 'error');
      renderReviewPanel();
      return;
    }

    computeReview(R, fens, moves);
    R.status = 'done';
    renderAll({ animate: false });
    toast('Analisi completata');
  }

  /** Classifica ogni mossa e calcola la precisione dei due giocatori. */
  function computeReview(R, fens, moves) {
    const acc = { w: [], b: [] };
    const counts = { w: {}, b: {} };
    CLASSES.forEach((c) => { counts.w[c.key] = 0; counts.b[c.key] = 0; });
    R.cls = [];

    for (let i = 1; i < fens.length; i++) {
      const m = moves[i - 1];
      const color = m.color;
      const before = wpOf(R.evals[i - 1]);
      const after = wpOf(R.evals[i]);
      const loss = Math.max(0, color === 'w' ? before - after : after - before); // punti di "win%"
      const uci = m.from + m.to + (m.promotion || '');
      const bestUci = R.evals[i - 1].best;
      const onlyMove = new window.Chess(fens[i - 1]).moves().length === 1;

      let key;
      if (onlyMove || uci === bestUci || loss < 0.5) key = 'best';
      else if (loss < 2) key = 'excellent';
      else if (loss < 5) key = 'good';
      else if (loss < 10) key = 'inaccuracy';
      else if (loss < 20) key = 'mistake';
      else key = 'blunder';

      const a = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
      R.cls.push({
        key: key, loss: loss, acc: a, san: m.san, color: color,
        best: bestUci, bestSan: bestUci ? uciToSan(fens[i - 1], bestUci) : null
      });
      acc[color].push(a);
      counts[color][key]++;
    }
    const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
    R.summary = { w: { acc: avg(acc.w), counts: counts.w }, b: { acc: avg(acc.b), counts: counts.b } };
  }

  function renderReviewPanel() {
    const R = S.review;
    const btn = byId('btn-review');
    btn.disabled = R.status === 'running' || S.botBusy;
    btn.textContent = R.status === 'running' ? '⏳ Analisi in corso…' : (R.status === 'done' ? '🔄 Rianalizza' : '📊 Analizza la partita');
    byId('review-progress').hidden = R.status !== 'running';
    byId('review-progress-bar').style.width = Math.round(R.progress * 100) + '%';
    byId('review-hint').textContent = R.error ||
      'Analizza la partita corrente: precisione, errori, sviste e mosse migliori. Gratis e illimitata.';
    byId('review-results').hidden = R.status !== 'done';
    if (R.status !== 'done') return;

    const fmt = (v) => (v == null ? '–' : v.toFixed(1) + '%');
    byId('acc-w').textContent = fmt(R.summary.w.acc);
    byId('acc-b').textContent = fmt(R.summary.b.acc);

    // Tabella delle classificazioni
    let rows = '<tr><th>Mosse</th><th>Bianco</th><th>Nero</th></tr>';
    CLASSES.forEach((c) => {
      rows += '<tr><td><span class="lbl"><i class="badge k-' + c.key + '">' + c.sym + '</i>' + c.label + '</span></td>' +
        '<td>' + R.summary.w.counts[c.key] + '</td><td>' + R.summary.b.counts[c.key] + '</td></tr>';
    });
    byId('class-table').innerHTML = rows;

    renderGraph();
    renderComment();
  }

  function renderGraph() {
    const svg = byId('eval-graph');
    const n = S.fens.length, W = 300, H = 90;
    const xs = (i) => (n > 1 ? (i * W) / (n - 1) : 0);
    let d = 'M0,' + H;
    S.review.evals.forEach((ev, i) => { d += ' L' + xs(i).toFixed(1) + ',' + (H - (wpOf(ev) / 100) * H).toFixed(1); });
    d += ' L' + W + ',' + H + ' Z';
    const cx = xs(S.view).toFixed(1);
    svg.innerHTML =
      '<rect width="' + W + '" height="' + H + '" fill="#2b2e33"/>' +
      '<path d="' + d + '" fill="#f2f2ee"/>' +
      '<line x1="0" y1="' + H / 2 + '" x2="' + W + '" y2="' + H / 2 + '" stroke="#8a919a" stroke-width="1" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>' +
      '<line x1="' + cx + '" y1="0" x2="' + cx + '" y2="' + H + '" stroke="#6fbf5f" stroke-width="2" vector-effect="non-scaling-stroke"/>';
  }

  function renderComment() {
    const box = byId('move-comment');
    const R = S.review;
    const c = S.view > 0 ? R.cls[S.view - 1] : null;
    if (!c) { box.hidden = true; return; }
    const num = Math.ceil(S.view / 2) + (c.color === 'w' ? '.' : '…');
    let body = 'Valutazione dopo la mossa: <b>' + evSigned(R.evals[S.view]) + '</b>.';
    if (c.key === 'best') body += ' È la mossa migliore (o equivalente).';
    else if (c.bestSan) body += ' Era meglio <b>' + esc(c.bestSan) + '</b> (valutazione <b>' + evSigned(R.evals[S.view - 1]) + '</b>).';
    box.innerHTML =
      '<div class="comment-head"><i class="badge k-' + c.key + '">' + CLS[c.key].sym + '</i>' +
      esc(num + ' ' + c.san) + ' — ' + CLS[c.key].label + '</div>' +
      '<div class="comment-body">' + body + '</div>';
    box.hidden = false;
  }

  /* ======================================================================
     10. RETE P2P: AMICI, SFIDE, STANZE (PeerJS)
     ====================================================================== */
  const net = {
    peer: null,
    ready: false,
    pending: new Map(),          // peerId -> [callback di errore "peer-unavailable"]
    presenceWaiters: new Map(),  // conn -> callback(pong)
    status: {},                  // friendId -> 'online' | 'ingame' | 'offline' | 'checking'
    room: null,                  // { peer, code, conn, open }
    joining: null,
    outgoing: null,
    incoming: null,
    challengePending: false,
    polling: false,
    pollTimer: null
  };

  function setNetState(state, text) {
    byId('net-status').dataset.state = state;
    byId('net-status-text').textContent = text;
  }

  const safeSend = (conn, msg) => {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { console.warn('send fallita', e); }
  };
  const closeLater = (conn) => setTimeout(() => { try { conn.close(); } catch (e) { /* ignora */ } }, 300);

  function initPeer() {
    if (typeof window.Peer === 'undefined') { setNetState('error', 'P2P non disponibile'); return; }
    let peer;
    try { peer = new window.Peer(PEER_USER + profile.id); }
    catch (e) { setNetState('error', 'P2P non disponibile'); return; }
    net.peer = peer;

    peer.on('open', () => {
      net.ready = true;
      setNetState('ok', 'Online');
      refreshPresence();
      startPolling();
      handleRoomHash();
    });
    peer.on('connection', (conn) => attachConn(conn));
    peer.on('disconnected', () => {
      net.ready = false;
      setNetState('connecting', 'Riconnessione…');
      setTimeout(() => {
        if (net.peer && net.peer.disconnected && !net.peer.destroyed) {
          try { net.peer.reconnect(); } catch (e) { /* ignora */ }
        }
      }, 2000);
    });
    peer.on('close', () => { net.ready = false; setNetState('error', 'Offline'); });
    peer.on('error', (err) => onPeerError(err, peer));
  }

  function onPeerError(err, source) {
    const type = err && err.type;
    if (type === 'peer-unavailable') {
      const m = /peer\s+(\S+)/.exec((err && err.message) || '');
      const id = m && m[1];
      const list = id && net.pending.get(id);
      if (list) { net.pending.delete(id); list.forEach((fn) => fn()); }
      return;
    }
    if (source === net.peer) {
      if (type === 'unavailable-id') {
        setNetState('error', 'ID già in uso');
        toast("Il tuo codice amico è già aperto in un'altra scheda: chiudila e ricarica la pagina.", 'error');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].indexOf(type) >= 0) {
        setNetState('error', 'Offline');
      } else {
        console.warn('PeerJS:', err);
      }
    }
  }

  /** Apre una connessione dati verso un peer; rifiuta se non esiste o scade il tempo. */
  function connectTo(peerId, timeout) {
    return new Promise((resolve, reject) => {
      if (!net.peer || !net.peer.open) { reject(new Error('offline')); return; }
      let done = false;
      let conn;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const list = (net.pending.get(peerId) || []).filter((f) => f !== onUnavailable);
        if (list.length) net.pending.set(peerId, list); else net.pending.delete(peerId);
        if (err) { try { conn && conn.close(); } catch (e) { /* ignora */ } reject(err); }
        else resolve(conn);
      };
      const onUnavailable = () => finish(new Error('unavailable'));
      const timer = setTimeout(() => finish(new Error('timeout')), timeout || 6000);
      net.pending.set(peerId, (net.pending.get(peerId) || []).concat(onUnavailable));
      try { conn = net.peer.connect(peerId, { reliable: true }); }
      catch (e) { finish(e); return; }
      conn.on('open', () => finish(null));
      conn.on('error', (e) => finish(e || new Error('error')));
      conn.on('close', () => finish(new Error('closed')));
    });
  }

  function attachConn(conn) {
    conn.on('data', (data) => routeMessage(conn, data));
    conn.on('close', () => onConnClosed(conn));
    // Gli errori non fatali non devono interrompere la partita: se la connessione cade arriva "close".
    conn.on('error', (err) => console.warn('Errore connessione P2P:', err));
  }

  function routeMessage(conn, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    switch (msg.t) {
      case 'ping':
        safeSend(conn, { t: 'pong', name: profile.name, id: profile.id, status: inOnlineGame() ? 'ingame' : 'online' });
        break;
      case 'pong': {
        const w = net.presenceWaiters.get(conn);
        if (w) { net.presenceWaiters.delete(conn); w(msg); }
        break;
      }
      case 'challenge': onChallenge(conn, msg); break;
      case 'accept': onAccept(conn); break;
      case 'decline': onDecline(conn); break;
      case 'cancel': onChallengeCancelled(conn); break;
      case 'join': onJoin(conn, msg); break;
      case 'start': onStart(conn, msg); break;
      default:
        if (S.online && S.online.conn === conn) onGameMessage(msg);
    }
  }

  function onConnClosed(conn) {
    const w = net.presenceWaiters.get(conn);
    if (w) { net.presenceWaiters.delete(conn); w(null); }
    if (net.incoming && net.incoming.conn === conn) {
      net.incoming.cancelled = true;
      closeConfirm(false);
      toast('La sfida è stata annullata.', 'warn');
    }
    const o = net.outgoing;
    if (o && o.conn === conn && !o.settled) {
      o.settled = true;
      net.outgoing = null;
      closeConfirm(false);
      toast('La sfida non è andata a buon fine.', 'warn');
    }
    if (net.joining && net.joining.conn === conn) {
      clearTimeout(net.joining.timer);
      net.joining = null;
      toast('La stanza si è chiusa.', 'warn');
    }
    if (S.online && S.online.conn === conn && !S.over) {
      setResult({ winner: null, reason: "l'avversario si è disconnesso", interrupted: true });
      concludeGame();
    }
  }

  /* ---------- Stato di presenza degli amici ---------- */
  async function pingFriend(f) {
    let conn;
    try { conn = await connectTo(PEER_USER + f.id, 5000); }
    catch (e) { return null; }
    attachConn(conn);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        net.presenceWaiters.delete(conn);
        try { conn.close(); } catch (e) { /* ignora */ }
        resolve(null);
      }, 3500);
      net.presenceWaiters.set(conn, (pong) => {
        clearTimeout(timer);
        try { conn.close(); } catch (e) { /* ignora */ }
        resolve(pong);
      });
      safeSend(conn, { t: 'ping' });
    });
  }

  async function refreshPresence() {
    if (net.polling) return;
    if (!friends.length) { renderFriends(); return; }
    if (!net.ready) {
      friends.forEach((f) => { net.status[f.id] = 'offline'; });
      renderFriends();
      return;
    }
    net.polling = true;
    friends.forEach((f) => { net.status[f.id] = 'checking'; });
    renderFriends();
    try {
      await Promise.all(friends.map(async (f) => {
        const pong = await pingFriend(f);
        if (pong && cleanId(pong.id) === f.id) {
          net.status[f.id] = pong.status === 'ingame' ? 'ingame' : 'online';
          const nm = cleanName(pong.name);
          if (nm && nm !== f.name) { f.name = nm; saveFriends(); }
        } else {
          net.status[f.id] = 'offline';
        }
      }));
    } finally {
      net.polling = false;
      renderFriends();
    }
  }

  function startPolling() {
    clearInterval(net.pollTimer);
    net.pollTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && net.ready && friends.length) refreshPresence();
    }, 30000);
  }

  function renderFriends() {
    const ul = byId('friend-list');
    byId('friends-empty').hidden = friends.length > 0;
    byId('friends-count').textContent = friends.length ? '(' + friends.length + ')' : '';
    ul.innerHTML = friends.map((f) => {
      const st = net.status[f.id] || 'offline';
      const label = { online: 'Online', ingame: 'In partita', offline: 'Offline', checking: 'Controllo…' }[st];
      const initial = (Array.from(f.name || '?')[0] || '?').toUpperCase();
      return '<li data-id="' + esc(f.id) + '">' +
        '<span class="avatar">' + esc(initial) + '</span>' +
        '<div class="friend-meta"><strong>' + esc(f.name) + ' <span class="muted">#' + esc(f.id) + '</span></strong>' +
        '<small><i class="dot" data-s="' + st + '"></i>' + label + '</small></div>' +
        '<div class="friend-actions">' +
        '<button type="button" class="btn btn-sm btn-primary" data-action="challenge"' + (st === 'online' ? '' : ' disabled') + '>⚔ Sfida</button>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="remove" title="Rimuovi amico" aria-label="Rimuovi amico">✕</button>' +
        '</div></li>';
    }).join('');
    const online = friends.filter((f) => net.status[f.id] === 'online').length;
    const pill = byId('friends-online-count');
    pill.hidden = online === 0;
    pill.textContent = online;
  }

  function addFriend(raw) {
    const m = String(raw || '').trim().match(/^(?:(.*)#)?([A-Za-z0-9]{4,10})$/);
    if (!m) { toast('Codice non valido. Esempio: Mario#K7P2QX', 'warn'); return false; }
    const id = cleanId(m[2]);
    if (id === profile.id) { toast('Questo è il tuo codice!', 'warn'); return false; }
    if (friends.some((f) => f.id === id)) { toast('Questo amico è già nella lista.', 'warn'); return false; }
    friends.push({ id: id, name: cleanName(m[1]) || 'Amico ' + id });
    saveFriends();
    net.status[id] = 'checking';
    renderFriends();
    refreshPresence();
    toast('Amico aggiunto');
    return true;
  }

  async function removeFriend(id) {
    const f = friends.find((x) => x.id === id);
    if (!f) return;
    const ok = await askConfirm({ title: 'Rimuovi amico', text: 'Vuoi rimuovere ' + f.name + ' dalla lista?', ok: 'Rimuovi', cancel: 'Annulla' });
    if (!ok) return;
    friends = friends.filter((x) => x.id !== id);
    delete net.status[id];
    saveFriends();
    renderFriends();
  }

  /* ---------- Sfida a un amico ---------- */
  async function challengeFriend(f) {
    if (!net.ready) { toast('Connessione P2P non ancora pronta.', 'warn'); return; }
    if (net.challengePending || net.outgoing || net.incoming || net.joining) { toast('Hai già una sfida in corso.', 'warn'); return; }
    if (inOnlineGame()) { toast('Termina prima la partita online in corso.', 'warn'); return; }
    net.challengePending = true;
    let conn;
    try { conn = await connectTo(PEER_USER + f.id, 6000); }
    catch (e) {
      net.challengePending = false;
      net.status[f.id] = 'offline';
      renderFriends();
      toast(f.name + ' non è raggiungibile.', 'warn');
      return;
    }
    attachConn(conn);
    const color = Math.random() < 0.5 ? 'w' : 'b'; // colore di chi sfida
    const o = { conn: conn, color: color, friend: f, settled: false };
    net.outgoing = o;
    net.challengePending = false;
    safeSend(conn, { t: 'challenge', name: profile.name, id: profile.id, color: color });
    askConfirm({
      title: 'Sfida inviata', text: 'In attesa che ' + f.name + ' risponda…',
      ok: null, cancel: 'Annulla sfida', timeout: 45000
    }).then(() => {
      if (o.settled) return;
      o.settled = true;
      if (net.outgoing === o) net.outgoing = null;
      safeSend(conn, { t: 'cancel' });
      closeLater(conn);
    });
  }

  async function onChallenge(conn, msg) {
    const color = msg.color === 'w' || msg.color === 'b' ? msg.color : null;
    if (!color) return;
    if (net.incoming || net.outgoing || net.joining || inOnlineGame()) {
      safeSend(conn, { t: 'decline', reason: 'busy' });
      closeLater(conn);
      return;
    }
    const name = cleanName(msg.name) || 'Sconosciuto';
    const id = cleanId(msg.id);
    const myColor = color === 'w' ? 'b' : 'w';
    const known = friends.some((f) => f.id === id);
    const inGame = S.mode !== 'online' && !S.over && S.moves.length > 0;
    const inc = { conn: conn, cancelled: false };
    net.incoming = inc;
    const ok = await askConfirm({
      title: 'Sfida ricevuta',
      text: name + (known ? '' : ' (non è nella tua lista amici)') + ' ti sfida a una partita. Giocherai con i ' +
        (myColor === 'w' ? 'Bianchi' : 'Neri') + '.' + (inGame ? ' La partita in corso verrà interrotta.' : ''),
      ok: 'Accetta', cancel: 'Rifiuta', timeout: 45000
    });
    if (net.incoming === inc) net.incoming = null;
    if (inc.cancelled) return;
    if (ok) {
      safeSend(conn, { t: 'accept' });
      startOnlineGame(conn, myColor, name, id);
    } else {
      safeSend(conn, { t: 'decline' });
      closeLater(conn);
    }
  }

  function onAccept(conn) {
    const o = net.outgoing;
    if (!o || o.conn !== conn || o.settled) return;
    o.settled = true;
    net.outgoing = null;
    closeConfirm(true);
    startOnlineGame(conn, o.color, o.friend.name, o.friend.id);
  }
  function onDecline(conn) {
    const o = net.outgoing;
    if (o && o.conn === conn && !o.settled) {
      o.settled = true;
      net.outgoing = null;
      closeConfirm(false);
      toast(o.friend.name + ' ha rifiutato la sfida.', 'warn');
      closeLater(conn);
      return;
    }
    if (net.joining && net.joining.conn === conn) {
      clearTimeout(net.joining.timer);
      net.joining = null;
      toast('La stanza è già occupata.', 'warn');
    }
  }
  function onChallengeCancelled(conn) {
    if (net.incoming && net.incoming.conn === conn) {
      net.incoming.cancelled = true;
      closeConfirm(false);
      toast('La sfida è stata annullata.', 'warn');
    }
  }

  /* ---------- Stanze con codice / link ---------- */
  function updateRoomUI() {
    const room = net.room;
    const box = byId('room-box');
    byId('btn-create-room').disabled = !!room;
    if (!room) { box.hidden = true; return; }
    box.hidden = false;
    byId('room-code').textContent = room.open ? room.code : '······';
    byId('room-hint').textContent = room.conn
      ? 'Amico connesso: buona partita!'
      : (room.open ? 'In attesa che il tuo amico entri…' : 'Creo la stanza…');
    byId('btn-cancel-room').hidden = !!room.conn;
  }

  function destroyRoom() {
    const room = net.room;
    net.room = null;
    if (room) { try { room.peer.destroy(); } catch (e) { /* ignora */ } }
    updateRoomUI();
  }

  function createRoom(attempt) {
    attempt = attempt || 0;
    if (!net.ready) { toast('Connessione P2P non ancora pronta.', 'warn'); return; }
    if (inOnlineGame()) { toast('Hai già una partita online in corso.', 'warn'); return; }
    if (net.room) destroyRoom();
    const code = genId(6);
    let peer;
    try { peer = new window.Peer(PEER_ROOM + code); }
    catch (e) { toast('Impossibile creare la stanza.', 'error'); return; }
    const room = { peer: peer, code: code, conn: null, open: false };
    net.room = room;
    peer.on('open', () => { if (net.room === room) { room.open = true; updateRoomUI(); } });
    peer.on('connection', (c) => attachConn(c));
    peer.on('error', (err) => {
      if (net.room !== room || room.conn) return;
      if (err.type === 'unavailable-id' && attempt < 3) { destroyRoom(); createRoom(attempt + 1); }
      else { toast('Errore nella stanza: ' + (err.type || 'sconosciuto'), 'error'); destroyRoom(); }
    });
    updateRoomUI();
  }

  const roomLink = (code) => location.href.split('#')[0] + '#room=' + code;

  /** Lato ospite: un amico è entrato nella mia stanza. */
  function onJoin(conn, msg) {
    const room = net.room;
    const mine = room && (!conn.provider || conn.provider === room.peer);
    if (!room || !mine || room.conn || !room.open) {
      safeSend(conn, { t: 'decline', reason: 'busy' });
      closeLater(conn);
      return;
    }
    room.conn = conn;
    const hostColor = Math.random() < 0.5 ? 'w' : 'b';
    safeSend(conn, { t: 'start', color: hostColor === 'w' ? 'b' : 'w', name: profile.name, id: profile.id });
    startOnlineGame(conn, hostColor, cleanName(msg.name) || 'Ospite', cleanId(msg.id));
  }

  /** Lato "entra": la stanza ha confermato e mi ha assegnato il colore. */
  function onStart(conn, msg) {
    const j = net.joining;
    if (!j || j.conn !== conn) return;
    clearTimeout(j.timer);
    net.joining = null;
    startOnlineGame(conn, msg.color === 'b' ? 'b' : 'w', cleanName(msg.name) || 'Avversario', cleanId(msg.id));
  }

  async function joinRoom(raw) {
    const code = cleanId(raw);
    if (code.length < 4) { toast('Codice stanza non valido.', 'warn'); return; }
    if (!net.ready) { toast('Connessione P2P non ancora pronta.', 'warn'); return; }
    if (net.joining || net.outgoing || net.incoming) { toast('Hai già una richiesta in corso.', 'warn'); return; }
    if (inOnlineGame()) { toast('Hai già una partita online in corso.', 'warn'); return; }
    if (net.room && net.room.code === code) { toast('Questo è il codice della tua stanza!', 'warn'); return; }
    let conn;
    try { conn = await connectTo(PEER_ROOM + code, 8000); }
    catch (e) { toast('Stanza non trovata o già chiusa.', 'error'); return; }
    attachConn(conn);
    const j = { conn: conn };
    j.timer = setTimeout(() => {
      if (net.joining === j) {
        net.joining = null;
        try { conn.close(); } catch (e) { /* ignora */ }
        toast('La stanza non ha risposto.', 'error');
      }
    }, 10000);
    net.joining = j;
    safeSend(conn, { t: 'join', name: profile.name, id: profile.id });
    toast('Entro nella stanza…');
  }

  function handleRoomHash() {
    const m = /[#&]room=([A-Za-z0-9]{4,10})/.exec(location.hash);
    if (!m) return;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignora */ }
    switchTab('play');
    setUiMode('online');
    byId('join-code').value = m[1].toUpperCase();
    joinRoom(m[1]);
  }

  /* ---------- Partita online ---------- */
  function startOnlineGame(conn, color, oppName, oppId) {
    resetState('online', {
      orientation: color === 'w' ? 'white' : 'black',
      myColor: color
    }, conn);
    S.online = { conn: conn, color: color, oppName: cleanName(oppName) || 'Avversario', oppId: oppId, drawPending: false };
    setUiMode('online');
    updateRoomUI();
    renderAll();
    toast('Partita contro ' + S.online.oppName + ': giochi con i ' + (color === 'w' ? 'Bianchi' : 'Neri') + '.');
  }

  /** Chiude la sessione online corrente (avvisando l'avversario se la partita era in corso). */
  function closeOnlineSession(keepConn) {
    const o = S.online;
    if (o && o.conn !== keepConn) {
      if (!S.over) safeSend(o.conn, { t: 'resign' });
      closeLater(o.conn);
      S.online = null;
    }
    if (net.room && (!keepConn || net.room.conn !== keepConn)) destroyRoom();
  }

  function validSquare(s) { return typeof s === 'string' && /^[a-h][1-8]$/.test(s); }

  async function onGameMessage(msg) {
    const o = S.online;
    if (!o) return;
    switch (msg.t) {
      case 'move': {
        if (S.over || S.game.turn() === o.color) return; // non è il turno dell'avversario
        if (!validSquare(msg.from) || !validSquare(msg.to)) return;
        const promo = typeof msg.promotion === 'string' && /^[qrbn]$/.test(msg.promotion) ? msg.promotion : undefined;
        const m = commitMove(msg.from, msg.to, promo, { remote: true });
        if (!m) toast("Mossa non valida ricevuta dall'avversario.", 'error');
        break;
      }
      case 'resign':
        if (!S.over) { setResult({ winner: o.color, reason: 'abbandono' }); concludeGame(); }
        break;
      case 'draw-offer': {
        if (S.over) return;
        const ok = await askConfirm({
          title: 'Offerta di patta', text: o.oppName + ' propone la patta.',
          ok: 'Accetta', cancel: 'Rifiuta', timeout: 30000
        });
        if (S.online !== o || S.over) return;
        if (ok) {
          safeSend(o.conn, { t: 'draw-accept' });
          setResult({ winner: null, reason: 'accordo' });
          concludeGame();
        } else {
          safeSend(o.conn, { t: 'draw-decline' });
        }
        break;
      }
      case 'draw-accept':
        if (o.drawPending && !S.over) { setResult({ winner: null, reason: 'accordo' }); concludeGame(); }
        break;
      case 'draw-decline':
        o.drawPending = false;
        toast("L'avversario ha rifiutato la patta.", 'warn');
        renderControls();
        break;
      default:
    }
  }

  /* ======================================================================
     11. AZIONI DELL'INTERFACCIA E AVVIO
     ====================================================================== */
  async function confirmLeaveOnline() {
    if (!inOnlineGame()) return true;
    return askConfirm({
      title: 'Partita online in corso',
      text: 'Se continui abbandonerai la partita online. Vuoi procedere?',
      ok: 'Abbandona', cancel: 'Resta'
    });
  }

  async function newGame(mode) {
    if (!(await confirmLeaveOnline())) return;
    let extra;
    if (mode === 'bot') {
      let c = byId('bot-color').value;
      if (c === 'r') c = Math.random() < 0.5 ? 'w' : 'b';
      extra = {
        botLevel: parseInt(byId('bot-level').value, 10) || 3,
        myColor: c, botColor: c === 'w' ? 'b' : 'w', orientation: c === 'w' ? 'white' : 'black'
      };
    } else {
      extra = { orientation: 'white', myColor: 'w', botColor: null };
    }
    resetState(mode, extra);
    renderAll();
    maybeBot();
  }

  async function resign() {
    if (S.over) return;
    const ok = await askConfirm({ title: 'Abbandona', text: 'Vuoi davvero abbandonare la partita?', ok: 'Abbandona', cancel: 'Continua a giocare' });
    if (!ok || S.over) return;
    if (S.mode === 'online' && S.online) {
      safeSend(S.online.conn, { t: 'resign' });
      setResult({ winner: S.online.color === 'w' ? 'b' : 'w', reason: 'abbandono' });
    } else if (S.mode === 'bot') {
      setResult({ winner: S.botColor, reason: 'abbandono' });
    } else {
      setResult({ winner: S.game.turn() === 'w' ? 'b' : 'w', reason: 'abbandono' });
    }
    S.botToken++; // ferma un eventuale bot in attesa
    S.botBusy = false;
    engine.cancelAll();
    concludeGame();
  }

  async function offerDraw() {
    if (S.over) return;
    if (S.mode === 'online' && S.online) {
      if (S.online.drawPending) return;
      S.online.drawPending = true;
      safeSend(S.online.conn, { t: 'draw-offer' });
      toast('Offerta di patta inviata.');
      renderControls();
    } else if (S.mode === 'local') {
      const ok = await askConfirm({ title: 'Patta', text: 'I due giocatori concordano la patta?', ok: 'Concordiamo', cancel: 'No' });
      if (ok && !S.over) { setResult({ winner: null, reason: 'accordo' }); concludeGame(); }
    }
  }

  function buildPgn() {
    const g = S.game;
    const tag = !S.result || S.result.interrupted ? '*' : (S.result.winner === 'w' ? '1-0' : (S.result.winner === 'b' ? '0-1' : '1/2-1/2'));
    g.header('Event', 'chesspremium', 'Site', 'chesspremium', 'Date', new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
      'White', playerName('w'), 'Black', playerName('b'), 'Result', tag);
    return g.pgn();
  }

  function flipBoard() {
    S.orientation = S.orientation === 'white' ? 'black' : 'white';
    renderAll();
  }

  function bindEvents() {
    // Navigazione (tab del pannello e link della barra superiore)
    qsa('.tab, .nav-link').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    qsa('#mode-switch button').forEach((b) => b.addEventListener('click', () => setUiMode(b.dataset.mode)));

    byId('btn-theme').addEventListener('click', () => {
      applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
    });

    // Avvio partite
    byId('btn-start-bot').addEventListener('click', () => newGame('bot'));
    byId('btn-start-local').addEventListener('click', () => newGame('local'));

    // Controlli partita
    byId('btn-flip').addEventListener('click', flipBoard);
    byId('btn-undo').addEventListener('click', undoMove);
    byId('btn-resign').addEventListener('click', resign);
    byId('btn-draw').addEventListener('click', offerDraw);
    byId('btn-copy-pgn').addEventListener('click', () => copyText(buildPgn(), 'PGN copiato negli appunti'));

    // Navigazione tra le mosse
    byId('nav-first').addEventListener('click', () => goTo(0));
    byId('nav-prev').addEventListener('click', () => goTo(S.view - 1));
    byId('nav-next').addEventListener('click', () => goTo(S.view + 1));
    byId('nav-last').addEventListener('click', () => goTo(S.fens.length - 1));
    byId('move-list').addEventListener('click', (e) => {
      const b = e.target.closest('.mv');
      if (b) goTo(parseInt(b.dataset.ply, 10));
    });
    document.addEventListener('keydown', (e) => {
      const tag = (e.target && e.target.tagName) || '';
      if (/INPUT|SELECT|TEXTAREA/.test(tag) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(S.view - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goTo(S.view + 1); }
      else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); goTo(S.fens.length - 1); }
      else if (e.key === 'Escape') {
        if (!byId('modal-confirm').hidden) closeConfirm(false);
        closeModal('modal-promo');
        closeModal('modal-over');
        clearSelection();
      }
    });

    // Click-to-move sulle caselle
    $('#board').on('click', '.square-55d63', function () {
      const m = /square-([a-h][1-8])/.exec(this.className);
      onSquareClick(m && m[1]);
    });

    // Revisione
    byId('btn-review').addEventListener('click', runReview);
    byId('eval-graph').addEventListener('click', (e) => {
      if (S.review.status !== 'done') return;
      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      goTo(Math.round(ratio * (S.fens.length - 1)));
    });

    // Modali
    byId('promo-choices').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-p]');
      if (!b) return;
      const cb = S.promoCb;
      S.promoCb = null;
      closeModal('modal-promo');
      if (cb) cb(b.dataset.p);
    });
    byId('promo-cancel').addEventListener('click', () => { S.promoCb = null; closeModal('modal-promo'); });
    byId('confirm-ok').addEventListener('click', () => closeConfirm(true));
    byId('confirm-cancel').addEventListener('click', () => closeConfirm(false));
    byId('over-close').addEventListener('click', () => closeModal('modal-over'));
    byId('over-review').addEventListener('click', () => {
      closeModal('modal-over');
      switchTab('review');
      runReview();
    });
    byId('over-new').addEventListener('click', () => {
      closeModal('modal-over');
      if (S.mode === 'online') { switchTab('play'); setUiMode('online'); }
      else newGame(S.mode);
    });

    // Profilo e amici
    byId('profile-name').addEventListener('change', (e) => {
      const nm = cleanName(e.target.value);
      if (nm) { profile.name = nm; store.set('profile', profile); }
      renderProfile();
      renderPlayers();
    });
    const copyId = () => copyText(profile.name + '#' + profile.id, 'Codice amico copiato: ' + profile.name + '#' + profile.id);
    byId('btn-copy-id').addEventListener('click', copyId);
    byId('user-chip').addEventListener('click', copyId);
    byId('form-add-friend').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = byId('friend-input');
      if (addFriend(input.value)) input.value = '';
    });
    byId('btn-refresh-friends').addEventListener('click', refreshPresence);
    byId('friend-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      const li = e.target.closest('li[data-id]');
      if (!btn || !li) return;
      const f = friends.find((x) => x.id === li.dataset.id);
      if (!f) return;
      if (btn.dataset.action === 'challenge') challengeFriend(f);
      else removeFriend(f.id);
    });

    // Stanze
    byId('btn-create-room').addEventListener('click', () => createRoom(0));
    byId('btn-cancel-room').addEventListener('click', destroyRoom);
    byId('btn-copy-code').addEventListener('click', () => { if (net.room) copyText(net.room.code, 'Codice stanza copiato'); });
    byId('btn-copy-link').addEventListener('click', () => { if (net.room) copyText(roomLink(net.room.code), 'Link copiato'); });
    byId('form-join').addEventListener('submit', (e) => {
      e.preventDefault();
      joinRoom(byId('join-code').value);
    });

    // Ridimensionamento / visibilità
    window.addEventListener('resize', () => { if (board) { board.resize(); refreshHighlights(); } });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && net.ready) refreshPresence();
    });
    window.addEventListener('beforeunload', () => {
      if (S.online && !S.over) safeSend(S.online.conn, { t: 'resign' });
    });
  }

  function renderProfile() {
    byId('profile-name').value = profile.name;
    byId('profile-code').textContent = profile.name + '#' + profile.id;
    byId('user-chip-text').textContent = profile.name + '#' + profile.id;
    byId('user-avatar').textContent = (Array.from(profile.name)[0] || '?').toUpperCase();
  }

  function init() {
    if (!$ || typeof window.Chess === 'undefined' || typeof window.Chessboard === 'undefined') {
      byId('status').textContent = 'Impossibile caricare le librerie (jQuery, chessboard.js, chess.js). Controlla la connessione e ricarica.';
      return;
    }

    board = window.Chessboard('board', {
      position: 'start',
      draggable: true,
      pieceTheme: (piece) => pieceUrl(piece),
      onDragStart: onDragStart,
      onDrop: onDrop,
      onSnapEnd: onSnapEnd,
      moveSpeed: 160,
      snapbackSpeed: 200,
      snapSpeed: 60
    });

    bindEvents();
    renderProfile();
    renderFriends();

    // Partita iniziale: contro il bot, tu col Bianco (pronta da giocare subito)
    resetState('bot', { botLevel: 3, myColor: 'w', botColor: 'b', orientation: 'white' });
    renderAll();

    initPeer();
    // Precarica il motore in background per rendere più rapida la prima mossa del bot
    setTimeout(() => { engine.init().catch(() => { /* gestito al primo uso */ }); }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  // Esposto solo per debug da console del browser
  window.chesspremium = { state: S, engine: engine, net: net };
})();
