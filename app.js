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

  // Palette duplicated from style.css: canvas cannot read CSS custom
  // properties cheaply per frame, and these two must stay in step.
  var C_BOARD = '#e8e2d6';
  var C_LINE = '#ddd5c5';
  var C_INK = '#23201c';
  var C_HEAD = '#3c372f';
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
     else degrades to 0. The length guard runs first so a 10 kB blob is never
     coerced. */
  var BEST_KEY = 'snake-flee.best';
  var BEST_MAX = 1e6;

  function decodeBest(raw) {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > 12) return 0;
    var n = Number(raw);
    if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > BEST_MAX) return 0;
    return n;
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

    var inset = cell * 0.12;
    for (var i = g.snake.length - 1; i >= 0; i--) {
      ctx.fillStyle = i === 0 ? C_HEAD : C_INK;
      ctx.fillRect(g.snake[i].x * cell + inset, g.snake[i].y * cell + inset,
        cell - inset * 2, cell - inset * 2);
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
    var cs = global.getComputedStyle(wrap);
    var padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    var padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    var gaps = (parseFloat(cs.rowGap) || 0) * 2;
    var chrome = document.querySelector('.hud').offsetHeight +
                 document.querySelector('.foot').offsetHeight;
    var availW = wrap.clientWidth - padX;
    var availH = wrap.clientHeight - padY - chrome - gaps;
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
  var KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    w: 'up', a: 'left', s: 'down', d: 'right',
    W: 'up', A: 'left', S: 'down', D: 'right'
  };

  function boot() {
    var game = createGame({});
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
    var shownState = '';

    bestEl.textContent = String(best);

    function restart() {
      reset(game);
      paused = false;
      acc = 0;
    }

    function togglePause() {
      if (!game.over) paused = !paused;
    }

    function onGameOver() {
      if (game.score > best) {
        best = game.score;
        saveBest(best);
      }
    }

    function syncChrome() {
      var state = game.over ? 'over' : (paused ? 'paused' : 'run');
      if (state === shownState) return;
      shownState = state;
      pauseBtn.textContent = paused ? 'resume' : 'pause';
      if (state === 'run') {
        overlay.hidden = true;
        return;
      }
      overlay.hidden = false;
      if (state === 'over') {
        oTitle.textContent = 'game over';
        oLine.textContent = 'score ' + game.score + '  ·  best ' + best;
        oHint.textContent = 'press r or tap the board to play again';
      } else {
        oTitle.textContent = 'paused';
        oLine.textContent = 'score ' + game.score + '  ·  best ' + best;
        oHint.textContent = 'press p or space to resume';
      }
    }

    function onKey(e) {
      var name = KEYMAP[e.key];
      if (name) {
        e.preventDefault();
        turn(game, DIRS[name]);
        return;
      }
      if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
        e.preventDefault();
        togglePause();
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
    var SWIPE_MIN = 24;   // px of travel before a drag counts as a swipe
    var TAP_MAX = 12;     // px of travel still counted as a tap
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
        if (adx > ady) turn(game, dx > 0 ? DIRS.right : DIRS.left);
        else turn(game, dy > 0 ? DIRS.down : DIRS.up);
      } else if (Math.max(adx, ady) <= TAP_MAX && game.over) {
        restart();
      }
      e.preventDefault();
    }
    stage.addEventListener('touchend', endTouch, { passive: false });
    stage.addEventListener('touchcancel', function () { touchId = null; });

    // Coming back from a background tab: drop whatever time passed instead of
    // replaying it as a burst of steps.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) { prev = 0; acc = 0; }
    });

    function frame(now) {
      var l = layout();
      // A backgrounded tab hands back one enormous dt; never replay it.
      var dt = prev ? Math.min(now - prev, 250) : 0;
      prev = now;
      if (!paused && !game.over) {
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
      scoreEl.textContent = String(game.score);
      bestEl.textContent = String(best);
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
    torusDelta: torusDelta, torusDist2: torusDist2, fleeStep: fleeStep,
    occupiedSet: occupiedSet,
    BEST_KEY: BEST_KEY, decodeBest: decodeBest, loadBest: loadBest, saveBest: saveBest,
    createGame: createGame, reset: reset, turn: turn, tick: tick, spawnFood: spawnFood
  };

  if (ctx) boot();
})(this);
