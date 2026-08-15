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

  function isOpposite(a, b) {
    return !!a && !!b && a.x === -b.x && a.y === -b.y;
  }

  function occupiedSet(snake) {
    var s = Object.create(null);
    for (var i = 0; i < snake.length; i++) s[key(snake[i].x, snake[i].y)] = true;
    return s;
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
      g.food = spawnFood(g);
      return 'eat';
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

  function layout() {
    var host = document.getElementById('board');
    var rect = host.getBoundingClientRect();
    var size = Math.max(160, Math.floor(Math.min(rect.width, rect.height)));
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
    var scoreEl = document.getElementById('score');

    function onKey(e) {
      var name = KEYMAP[e.key];
      if (name) {
        e.preventDefault();
        turn(game, DIRS[name]);
        return;
      }
      if (e.key === 'p' || e.key === 'P' || e.key === ' ') {
        e.preventDefault();
        if (!game.over) paused = !paused;
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        reset(game);
        paused = false;
      }
    }
    global.addEventListener('keydown', onKey);

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
          tick(game);
          interval = stepIntervalMs(game.score);
        }
        if (acc >= interval) acc = 0;
      } else {
        acc = 0;
      }
      scoreEl.textContent = String(game.score);
      draw(game, l.size, l.dpr);
      global.requestAnimationFrame(frame);
    }
    global.requestAnimationFrame(frame);
  }

  global.SnakeFlee = {
    COLS: COLS, ROWS: ROWS, DIRS: DIRS,
    BASE_MS: BASE_MS, RAMP_MS_PER_POINT: RAMP_MS_PER_POINT, FLOOR_MS: FLOOR_MS,
    wrap: wrap, key: key, stepIntervalMs: stepIntervalMs, isOpposite: isOpposite,
    createGame: createGame, reset: reset, turn: turn, tick: tick, spawnFood: spawnFood
  };

  if (ctx) boot();
})(this);
