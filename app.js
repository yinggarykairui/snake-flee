/* snake, flee — the food runs away from you.
   Vanilla JS, no dependencies, no build step. Loads from file:// or any server.

   Layout of this file:
     1. constants
     2. pure logic (torus maths, flee, ramp, storage decode) — exported on
        window.SnakeFlee so tests.html can assert against it with no DOM
     3. game state machine
     4. renderer + input (only wired up when the page has a #canvas)
*/
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- constants
  var COLS = 20;
  var ROWS = 20;

  // Speed ramp. Units: milliseconds per step, shortened per point of score.
  //   stepMs(score) = max(FLOOR_MS, BASE_MS - RAMP_MS_PER_POINT * score)
  // i.e. a straight line: 165 ms at score 0, losing 4 ms per point, clamped at
  // the 80 ms floor which is reached at score 22 ((165-80)/4 = 21.25 -> 22).
  var BASE_MS = 165;
  var RAMP_MS_PER_POINT = 4;
  var FLOOR_MS = 80;

  // Food panics when the head is within 5 cells (straight-line distance on the
  // torus). Small enough that the food sits still most of the time, so an
  // escape reads as a reaction to the snake rather than a random walk.
  var FEAR_RADIUS = 5;

  // The food is half the snake's speed: it takes at most one step per two
  // snake steps. At equal speed a scared food matches every move the head
  // makes, the gap never closes and the game is unwinnable — this is the
  // number that makes the chase a chase rather than a stalemate.
  var FOOD_STEP_EVERY = 2;

  /* Canvas palette. Canvas cannot read CSS custom properties cheaply per
     frame, so the four values that also exist in style.css are duplicated
     here and must stay in step, hex for hex:
       C_BOARD  = --board   C_LINE = --line
       C_INK    = --ink     C_ACCENT = --accent
     C_HEAD has no CSS twin — nothing outside the canvas is drawn in it.
     Contrast measured on the rendered canvas, not on these strings:
       head on board 3.42:1, head on body 3.68:1 (the head is the *lighter*
       mark and the larger one — see draw()); ink on board 12.6:1;
       accent food on board 4.89:1; grid line on board 1.37:1 (decoration). */
  var C_BOARD = '#e8e2d6';
  var C_LINE = '#cbc2ae';
  var C_INK = '#23201c';
  var C_HEAD = '#807769';
  var C_ACCENT = '#a83c1b';

  var DIRS = {
    up: { x: 0, y: -1 },
    down: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
    right: { x: 1, y: 0 }
  };

  // ------------------------------------------------------------- pure logic
  function wrap(v, n) {
    return ((v % n) + n) % n;
  }

  function key(x, y) {
    return x + ',' + y;
  }

  function stepIntervalMs(score) {
    var ms = BASE_MS - RAMP_MS_PER_POINT * score;
    return ms < FLOOR_MS ? FLOOR_MS : ms;
  }

  /* localStorage holds one string and anything can be in it — a stale value,
     hand-edited junk, or a huge blob from another app on the same origin.
     Decode defensively: only a plain non-negative integer counts, everything
     else degrades to 0. "Plain" is the digit test, not Number(): Number()
     also accepts '0x10', '1e5', '0b11', '0o17', ' 9 ', '+5' and '5.0', and a
     fabricated '1e5' best can never be beaten. The length guard runs first so
     a 10 kB blob is never even matched against.
     There is no !isFinite branch here because there is nothing for it to
     catch: a string of at most 12 digits is at most 999999999999, which is
     finite, an integer, and non-negative — so Infinity, fractions and
     negatives are all already excluded by the two guards above. The range
     guard still does work ('9999999' -> 0). */
  var BEST_KEY = 'snake-flee.best';
  var BEST_MAX = 1e6;
  var DIGITS = /^[0-9]+$/;

  function decodeBest(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 12) return 0;
    if (!DIGITS.test(raw)) return 0;
    var n = Number(raw);
    return n > BEST_MAX ? 0 : n;
  }

  function loadBest() {
    try {
      return decodeBest(global.localStorage.getItem(BEST_KEY));
    } catch (e) {
      return 0; // private mode / disabled storage throws on access
    }
  }

  function saveBest(n) {
    try {
      global.localStorage.setItem(BEST_KEY, String(n));
    } catch (e) { /* nothing to do; the run still plays */ }
  }

  function isOpposite(a, b) {
    return !!a && !!b && a.x === -b.x && a.y === -b.y;
  }

  function occupiedSet(snake) {
    var s = Object.create(null);
    for (var i = 0; i < snake.length; i++) s[key(snake[i].x, snake[i].y)] = true;
    return s;
  }

  // Shortest signed separation on a wrapped axis: on a 20-wide board, column 1
  // is 2 away from column 19, not 18. Everything about the chase depends on
  // this — naive |dx| makes the food flee *towards* the snake near an edge.
  function torusDelta(a, b, n) {
    var d = wrap(a - b, n);
    return d > n / 2 ? d - n : d;
  }

  // Squared straight-line distance on the torus. Squared (not sqrt) so the
  // comparisons stay in exact integer arithmetic.
  function torusDist2(ax, ay, bx, by, cols, rows) {
    var dx = torusDelta(ax, bx, cols);
    var dy = torusDelta(ay, by, rows);
    return dx * dx + dy * dy;
  }

  /* One flee step for the food.
       - outside the fear radius it sits still;
       - inside, it considers its four wrapped neighbours, drops any cell that
         the snake occupies, and takes the one that increases torus distance
         the most. Because (a+1)^2 - a^2 grows with a, "most" is automatically
         the axis it is already further away on.
       - only strictly-increasing moves are taken, so distance to the head is
         non-decreasing on every step and a boxed-in food holds its ground
         instead of twitching.
       - tiebreak (equal gain, e.g. a perfect diagonal): fixed order
         right, left, down, up — horizontal wins, and the whole chase stays
         deterministic and reproducible in tests.
     `occupied` is a map of "x,y" -> true. Returns a new {x, y}. */
  var FLEE_ORDER = [DIRS.right, DIRS.left, DIRS.down, DIRS.up];

  function fleeStep(food, head, occupied, cols, rows, fearRadius) {
    var r = fearRadius === undefined ? FEAR_RADIUS : fearRadius;
    var here = torusDist2(food.x, food.y, head.x, head.y, cols, rows);
    if (here > r * r) return { x: food.x, y: food.y };

    var best = { x: food.x, y: food.y };
    var bestD = here;
    for (var i = 0; i < FLEE_ORDER.length; i++) {
      var nx = wrap(food.x + FLEE_ORDER[i].x, cols);
      var ny = wrap(food.y + FLEE_ORDER[i].y, rows);
      if (occupied && occupied[key(nx, ny)]) continue;
      var d = torusDist2(nx, ny, head.x, head.y, cols, rows);
      if (d > bestD) {
        bestD = d;
        best = { x: nx, y: ny };
      }
    }
    return best;
  }

  // ------------------------------------------------------------ game object
  function createGame(opts) {
    opts = opts || {};
    var g = {
      cols: opts.cols || COLS,
      rows: opts.rows || ROWS,
      rng: opts.rng || Math.random,
      snake: null,
      dir: null,        // direction the next step will use
      dirMoved: null,   // direction the last executed step used
      food: null,
      score: 0,
      grow: 0,
      clock: 0,
      over: false
    };
    reset(g);
    return g;
  }

  function reset(g) {
    var cy = Math.floor(g.rows / 2);
    var cx = Math.floor(g.cols / 2);
    g.snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
    g.dir = DIRS.right;
    g.dirMoved = DIRS.right;
    g.score = 0;
    g.grow = 0;
    g.clock = 0;
    g.over = false;
    g.food = spawnFood(g);
    return g;
  }

  // A 180 is refused against the direction actually *moved* last, not against
  // a direction merely queued this tick — otherwise two fast taps (up, left
  // while moving right) would queue a reversal into the neck and kill the run.
  function turn(g, dir) {
    if (!dir || g.over) return false;
    if (isOpposite(dir, g.dirMoved)) return false;
    g.dir = dir;
    return true;
  }

  function spawnFood(g) {
    var taken = occupiedSet(g.snake);
    var free = [];
    for (var y = 0; y < g.rows; y++) {
      for (var x = 0; x < g.cols; x++) {
        if (!taken[key(x, y)]) free.push({ x: x, y: y });
      }
    }
    if (!free.length) return g.food || { x: 0, y: 0 };
    return free[Math.floor(g.rng() * free.length) % free.length];
  }

  // One snake step. Returns 'eat' | 'move' | 'dead'.
  function tick(g) {
    if (g.over) return 'dead';
    var d = g.dir;
    var head = g.snake[0];
    var next = { x: wrap(head.x + d.x, g.cols), y: wrap(head.y + d.y, g.rows) };

    // The tail cell frees up on this same step unless the snake is growing.
    var last = g.snake.length - 1;
    for (var i = 0; i < g.snake.length; i++) {
      if (i === last && g.grow === 0) break;
      if (g.snake[i].x === next.x && g.snake[i].y === next.y) {
        g.over = true;
        return 'dead';
      }
    }

    g.snake.unshift(next);
    g.dirMoved = d;

    var ate = next.x === g.food.x && next.y === g.food.y;
    if (ate) {
      g.score += 1;
      g.grow += 1;   // exactly one segment per point
    }
    if (g.grow > 0) g.grow -= 1;
    else g.snake.pop();

    if (ate) {
      g.clock = 0;
      g.food = spawnFood(g);
      return 'eat';
    }

    // Food reacts after the snake has moved, so it flees the head's new cell.
    g.clock += 1;
    if (g.clock % FOOD_STEP_EVERY === 0) {
      g.food = fleeStep(g.food, g.snake[0], occupiedSet(g.snake), g.cols, g.rows, FEAR_RADIUS);
    }
    return 'move';
  }

  // -------------------------------------------------------------- rendering
  var canvas = global.document && document.getElementById('canvas');
  var ctx = canvas && canvas.getContext('2d');

  // Cached board background (paper + grid). Rebuilt only when the pixel
  // geometry actually changes — CSS size *or* backing scale.
  var layer = null;
  var layerKey = '';

  function boardLayer(cssSize, dpr) {
    var k = cssSize + '@' + dpr;
    if (layer && layerKey === k) return layer;
    var c = document.createElement('canvas');
    c.width = Math.round(cssSize * dpr);
    c.height = Math.round(cssSize * dpr);
    var x = c.getContext('2d');
    x.scale(dpr, dpr);
    x.fillStyle = C_BOARD;
    x.fillRect(0, 0, cssSize, cssSize);
    var cell = cssSize / COLS;
    x.strokeStyle = C_LINE;
    x.lineWidth = 1;
    for (var i = 1; i < COLS; i++) {
      var p = Math.round(i * cell) + 0.5;
      x.beginPath();
      x.moveTo(p, 0); x.lineTo(p, cssSize);
      x.moveTo(0, p); x.lineTo(cssSize, p);
      x.stroke();
    }
    layer = c;
    layerKey = k;
    return c;
  }

  function draw(g, cssSize, dpr) {
    var cell = cssSize / COLS;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(boardLayer(cssSize, dpr), 0, 0, cssSize, cssSize);

    /* Two cues for which end is the head, not one: it is the lighter mark
       (the body is near-black ink) and it fills more of its cell. Drawn last
       so it sits over the neck when the two overlap. */
    var inset = cell * 0.12;
    var headInset = cell * 0.03;
    for (var i = g.snake.length - 1; i >= 0; i--) {
      var pad = i === 0 ? headInset : inset;
      ctx.fillStyle = i === 0 ? C_HEAD : C_INK;
      ctx.fillRect(g.snake[i].x * cell + pad, g.snake[i].y * cell + pad,
        cell - pad * 2, cell - pad * 2);
    }

    ctx.fillStyle = C_ACCENT;
    ctx.beginPath();
    ctx.arc((g.food.x + 0.5) * cell, (g.food.y + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Board is a square fitted to the free space; the backing store follows
  // devicePixelRatio so marks stay crisp when the window moves screens.
  var lastSize = 0;
  var lastDpr = 0;

  // Measured from the column and the two fixed rows, never from the board
  // itself: the board's height comes from the canvas, so measuring it would
  // be a feedback loop. Runs every frame, which also covers window resizes
  // and a devicePixelRatio change at an unchanged CSS size.
  function layout() {
    var wrap = document.querySelector('.wrap');
    var hud = document.querySelector('.hud');
    var foot = document.querySelector('.foot');
    var cs = global.getComputedStyle(wrap);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    // The height comes from the viewport, never from the column: the column
    // is min-height now, so it grows with the board, and measuring it would
    // be the feedback loop this function exists to avoid.
    var viewH = document.documentElement.clientHeight;
    var row = cs.flexDirection === 'row';   // the landscape rule, read back
    var availW, availH;
    if (row) {
      var colGaps = (parseFloat(cs.columnGap) || 0) * 2;
      availW = wrap.clientWidth - padX - hud.offsetWidth - foot.offsetWidth - colGaps;
      availH = viewH - padY;
    } else {
      var rowGaps = (parseFloat(cs.rowGap) || 0) * 2;
      availW = wrap.clientWidth - padX;
      availH = viewH - padY - hud.offsetHeight - foot.offsetHeight - rowGaps;
    }
    var size = Math.max(160, Math.floor(Math.min(availW, availH)));
    var dpr = global.devicePixelRatio || 1;
    if (size !== lastSize || dpr !== lastDpr) {
      lastSize = size;
      lastDpr = dpr;
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
    }
    return { size: size, dpr: dpr };
  }

  // ------------------------------------------------------------ input + loop
  /* Null-prototype table, so '__proto__', 'constructor' and 'toString' are
     ordinary misses rather than inherited truthy values that would get
     preventDefault()ed. keyDir() is the only reader; it is exported so the
     mapping can be asserted without a DOM. */
  var KEYMAP = Object.create(null);
  KEYMAP.ArrowUp = 'up'; KEYMAP.ArrowDown = 'down';
  KEYMAP.ArrowLeft = 'left'; KEYMAP.ArrowRight = 'right';
  KEYMAP.w = 'up'; KEYMAP.a = 'left'; KEYMAP.s = 'down'; KEYMAP.d = 'right';
  KEYMAP.W = 'up'; KEYMAP.A = 'left'; KEYMAP.S = 'down'; KEYMAP.D = 'right';

  function keyDir(k) {
    return typeof k === 'string' && KEYMAP[k] ? KEYMAP[k] : null;
  }

  /* A keydown carrying ctrl/meta/alt belongs to the browser or the OS, never
     to the snake: Ctrl+R must reload, Ctrl+S must save, Ctrl+P must print.
     Shift is not a modifier we claim — Shift+Arrow still steers. */
  function isBareKey(e) {
    return !e.ctrlKey && !e.metaKey && !e.altKey;
  }

  // Coarse pointer: the on-page copy has to describe the controls the reader
  // actually has, so this decides which wording ships, not a user-agent sniff.
  var COARSE = !!(global.matchMedia && global.matchMedia('(pointer: coarse)').matches);

  function boot() {
    var game = createGame({});
    var started = false;   // the first run waits for the player (see start())
    var paused = false;
    var acc = 0;
    var prev = 0;
    var best = loadBest();
    var scoreEl = document.getElementById('score');
    var bestEl = document.getElementById('best');
    var overlay = document.getElementById('overlay');
    var oTitle = document.getElementById('overlayTitle');
    var oLine = document.getElementById('overlayLine');
    var oHint = document.getElementById('overlayHint');
    var pauseBtn = document.getElementById('pauseBtn');
    var bestSlot = document.getElementById('bestSlot');
    var shownState = '';
    var shownScore = -1;
    var shownBest = -1;
    var shownRecord = null;
    var beatThisRun = false;

    // The HUD is touched only when a number actually changes, not every frame.
    function syncHud() {
      if (game.score !== shownScore) {
        shownScore = game.score;
        scoreEl.textContent = String(game.score);
      }
      if (best !== shownBest) {
        shownBest = best;
        bestEl.textContent = String(best);
      }
      if (beatThisRun !== shownRecord) {
        shownRecord = beatThisRun;
        bestSlot.className = beatThisRun ? 'score is-record' : 'score';
      }
    }

    /* The first run is held until the player asks for it: a cold load used to
       move the head about five cells while you were still reading the page,
       and it is also the one piece of motion that runs before any input,
       which is exactly what prefers-reduced-motion is about. The board is
       drawn and visible behind the prompt the whole time. Only the first run
       is gated — pressing r or tapping to play again is already an input. */
    function start() {
      if (started) return;
      started = true;
      prev = 0;
      acc = 0;
    }

    function restart() {
      reset(game);
      started = true;
      paused = false;
      acc = 0;
      beatThisRun = false;
    }

    function togglePause() {
      if (!game.over) paused = !paused;
    }

    /* `best` is a display copy and nothing more. Two tabs share one
       localStorage key, so the copy this tab read at boot can be stale by the
       time this tab writes: tab A dying at 99 after tab C loaded used to be
       erased by tab C dying at 40. Re-read at the moment of writing and keep
       the larger value; also follow the `storage` event so the HUD in the
       other tab catches up without a reload. */
    function commitBest(score) {
      var stored = loadBest();
      var next = score > stored ? score : stored;
      if (next !== stored) saveBest(next);
      if (next > best) best = next;
      return next;
    }

    function onGameOver() {
      commitBest(game.score);
    }

    global.addEventListener('storage', function (e) {
      if (e.key !== null && e.key !== BEST_KEY) return; // null = storage cleared
      var v = loadBest();
      if (v > best) best = v;
    });

    function syncChrome() {
      var state = game.over ? 'over' : (!started ? 'start' : (paused ? 'paused' : 'run'));
      if (state === shownState) return;
      shownState = state;
      pauseBtn.textContent = paused ? 'resume' : 'pause';
      /* togglePause() early-returns once the run is over, so leaving the
         button enabled offered a full hover-and-focus affordance for nothing.
         Restart re-enables it: the flag is derived from the state, not
         latched. Nothing to pause before the first run either. */
      pauseBtn.disabled = game.over || !started;
      if (state === 'run') {
        overlay.hidden = true;
        overlay.className = 'overlay';
        return;
      }
      overlay.hidden = false;
      overlay.className = state === 'start' ? 'overlay is-start' : 'overlay';
      if (state === 'over') {
        oTitle.textContent = 'game over';
        oLine.textContent = 'score ' + game.score + '  ·  best ' + best;
        oHint.textContent = COARSE ? 'tap the board to play again'
                                   : 'press r or tap the board to play again';
      } else if (state === 'start') {
        oTitle.textContent = 'ready';
        oLine.textContent = 'the food runs away from you';
        oHint.textContent = COARSE ? 'swipe the board to start'
                                   : 'press an arrow key to start';
      } else {
        oTitle.textContent = 'paused';
        oLine.textContent = 'score ' + game.score + '  ·  best ' + best;
        oHint.textContent = 'press p or space to resume';
      }
    }

    function onKey(e) {
      if (!isBareKey(e)) return;
      var name = keyDir(e.key);
      if (name) {
        e.preventDefault();
        start();
        turn(game, DIRS[name]);
        return;
      }
      if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
        e.preventDefault();
        if (started) togglePause();
        else start();
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        restart();
      }
    }
    global.addEventListener('keydown', onKey);

    pauseBtn.addEventListener('click', togglePause);
    document.getElementById('restartBtn').addEventListener('click', restart);

    /* Touch steering is bound to the stage only — never to the document — so
       pressing the HUD, the hint or a button can never move the snake.
       A short press is a tap (restart after game over); anything past the
       swipe threshold steers along its dominant axis. */
    /* One threshold, not two. TAP_MAX used to be 12 against a SWIPE_MIN of
       24, and a game-over tap that drifted 13-23 px — which a thumb on glass
       does routinely — was neither a tap nor a swipe and produced nothing at
       all. Anything short of a swipe is a tap. */
    var SWIPE_MIN = 24;   // px of travel before a drag counts as a swipe
    var stage = document.getElementById('stage');
    var touchId = null;
    var startX = 0, startY = 0;

    stage.addEventListener('touchstart', function (e) {
      if (touchId !== null) return;
      var t = e.changedTouches[0];
      touchId = t.identifier;
      startX = t.clientX;
      startY = t.clientY;
      e.preventDefault();
    }, { passive: false });

    stage.addEventListener('touchmove', function (e) {
      e.preventDefault(); // keep the page from scrolling under the swipe
    }, { passive: false });

    function endTouch(e) {
      var t = null;
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchId) t = e.changedTouches[i];
      }
      if (!t) return;
      touchId = null;
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      if (Math.max(adx, ady) >= SWIPE_MIN) {
        start();
        if (adx > ady) turn(game, dx > 0 ? DIRS.right : DIRS.left);
        else turn(game, dy > 0 ? DIRS.down : DIRS.up);
      } else if (game.over) {
        restart();
      } else {
        start();
      }
      e.preventDefault();
    }
    stage.addEventListener('touchend', endTouch, { passive: false });
    stage.addEventListener('touchcancel', function () { touchId = null; });

    /* Leaving the tab pauses the run. A hidden tab still gets throttled
       animation frames, so the snake used to keep stepping where nobody could
       see it and a run could end off-screen. It stays paused on return —
       coming back into a moving snake is the same defect one frame later.
       The anti-burst reset stays: whatever time passed is dropped rather than
       replayed as a burst of steps. */
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (started && !game.over) paused = true;
      } else {
        prev = 0;
        acc = 0;
      }
    });

    function frame(now) {
      var l = layout();
      // A backgrounded tab hands back one enormous dt; never replay it.
      var dt = prev ? Math.min(now - prev, 250) : 0;
      prev = now;
      if (started && !paused && !game.over) {
        acc += dt;
        var interval = stepIntervalMs(game.score);
        var budget = 4; // hard cap on catch-up steps per frame
        while (acc >= interval && budget-- > 0) {
          acc -= interval;
          if (tick(game) === 'dead') { onGameOver(); break; }
          interval = stepIntervalMs(game.score);
        }
        if (acc >= interval) acc = 0;
      } else {
        acc = 0;
      }
      /* The best on the HUD used to move only in onGameOver, so a record run
         read `score 25 / best 3` until it ended. Past the old best the two
         numbers are the same number, and the moment is marked on the label —
         once, quietly, no banner. */
      if (game.score > best) {
        best = commitBest(game.score); // banked as it happens, not at death
        beatThisRun = true;
      }
      syncHud();
      syncChrome();
      draw(game, l.size, l.dpr);
      global.requestAnimationFrame(frame);
    }
    // Live state on the export, so the running game can be inspected from the
    // browser console (and by the headless smoke check) without a debugger.
    global.SnakeFlee.game = game;
    global.requestAnimationFrame(frame);
  }

  global.SnakeFlee = {
    COLS: COLS, ROWS: ROWS, DIRS: DIRS,
    BASE_MS: BASE_MS, RAMP_MS_PER_POINT: RAMP_MS_PER_POINT, FLOOR_MS: FLOOR_MS,
    FEAR_RADIUS: FEAR_RADIUS, FOOD_STEP_EVERY: FOOD_STEP_EVERY,
    wrap: wrap, key: key, stepIntervalMs: stepIntervalMs, isOpposite: isOpposite,
    keyDir: keyDir, isBareKey: isBareKey,
    torusDelta: torusDelta, torusDist2: torusDist2, fleeStep: fleeStep,
    occupiedSet: occupiedSet,
    BEST_KEY: BEST_KEY, decodeBest: decodeBest, loadBest: loadBest, saveBest: saveBest,
    createGame: createGame, reset: reset, turn: turn, tick: tick, spawnFood: spawnFood
  };

  if (ctx) boot();
})(this);
