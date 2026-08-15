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
    var g = c.getContext('2d');
    g.scale(dpr, dpr);
    g.fillStyle = C_BOARD;
    g.fillRect(0, 0, cssSize, cssSize);
    var cell = cssSize / COLS;
    g.strokeStyle = C_LINE;
    g.lineWidth = 1;
    for (var i = 1; i < COLS; i++) {
      var p = Math.round(i * cell) + 0.5;
      g.beginPath();
      g.moveTo(p, 0); g.lineTo(p, cssSize);
      g.moveTo(0, p); g.lineTo(cssSize, p);
      g.stroke();
    }
    layer = c;
    layerKey = k;
    return c;
  }

  function cellRect(g, x, y, cell, inset) {
    g.fillRect(x * cell + inset, y * cell + inset, cell - inset * 2, cell - inset * 2);
  }

  function draw(state, cssSize, dpr) {
    var cell = cssSize / COLS;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(boardLayer(cssSize, dpr), 0, 0, cssSize, cssSize);

    for (var i = state.snake.length - 1; i >= 0; i--) {
      ctx.fillStyle = i === 0 ? C_HEAD : C_INK;
      cellRect(ctx, state.snake[i].x, state.snake[i].y, cell, cell * 0.12);
    }

    ctx.fillStyle = C_ACCENT;
    ctx.beginPath();
    ctx.arc((state.food.x + 0.5) * cell, (state.food.y + 0.5) * cell, cell * 0.3, 0, Math.PI * 2);
    ctx.fill();
  }

  // Resize on demand: the board is a square that fits the free space, and the
  // backing store follows devicePixelRatio so marks stay crisp.
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

  // ------------------------------------------------------------------ start
  var demo = {
    snake: [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }],
    food: { x: 14, y: 6 }
  };

  function frame() {
    var l = layout();
    draw(demo, l.size, l.dpr);
    global.requestAnimationFrame(frame);
  }

  global.SnakeFlee = { COLS: COLS, ROWS: ROWS, DIRS: DIRS, wrap: wrap, key: key };

  if (ctx) global.requestAnimationFrame(frame);
})(this);
