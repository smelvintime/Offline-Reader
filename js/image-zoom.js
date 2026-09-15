// Offline Reader — element-scoped zoom for manga and manhwa pages.
//
// The application viewport never zooms. This controller owns pinch, pan and
// double-tap magnification for .comic-page elements inside the image reader,
// keeping the surrounding header, footer and application shell fixed.
(function () {
  'use strict';

  const MIN_SCALE = 1;
  const MAX_SCALE = 4;
  const DOUBLE_TAP_MS = 300;
  const TAP_SLOP = 18;
  const DOUBLE_TAP_SCALE = 2.5;

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
  function distance(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }

  function create(root, options) {
    if (!root) return null;
    const opts = options || {};
    const pointers = new Map();
    let active = null;
    let scale = 1;
    let x = 0;
    let y = 0;
    let start = null;
    let moved = false;
    let pinching = false;
    let lastTap = null;
    let tapTimer = 0;

    function wrapperFor(img) { return img && img.closest ? img.closest('.page-wrapper') : null; }

    function bounds(nextScale, wrap) {
      const w = wrap ? wrap.clientWidth : 0;
      const h = wrap ? wrap.clientHeight : 0;
      return { minX: w - w * nextScale, minY: h - h * nextScale };
    }

    function apply(nextScale, nextX, nextY) {
      if (!active) return;
      const wrap = wrapperFor(active);
      if (!wrap) { reset(); return; }
      scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      if (scale <= MIN_SCALE + 0.001) {
        scale = 1;
        x = 0;
        y = 0;
        active.style.removeProperty('transform');
        active.style.removeProperty('transform-origin');
        wrap.classList.remove('image-zoomed');
        root.classList.remove('image-zoom-active');
      } else {
        const b = bounds(scale, wrap);
        x = clamp(nextX, b.minX, 0);
        y = clamp(nextY, b.minY, 0);
        active.style.transformOrigin = '0 0';
        active.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0) scale(' + scale + ')';
        wrap.classList.add('image-zoomed');
        root.classList.add('image-zoom-active');
      }
      root.dispatchEvent(new CustomEvent('imagezoomchange', {
        detail: { scale: scale, image: active }
      }));
    }

    function reset() {
      clearTimeout(tapTimer);
      tapTimer = 0;
      pointers.clear();
      if (active) {
        active.style.removeProperty('transform');
        active.style.removeProperty('transform-origin');
        const wrap = wrapperFor(active);
        if (wrap) wrap.classList.remove('image-zoomed');
      }
      root.classList.remove('image-zoom-active');
      active = null;
      scale = 1;
      x = 0;
      y = 0;
      start = null;
      moved = false;
      pinching = false;
      lastTap = null;
    }

    function focusImage(img) {
      if (active === img) return;
      reset();
      active = img;
    }

    function zoomAt(clientX, clientY, nextScale) {
      if (!active) return;
      const wrap = wrapperFor(active);
      if (!wrap) return;
      const rect = wrap.getBoundingClientRect();
      const fx = clientX - rect.left;
      const fy = clientY - rect.top;
      const contentX = (fx - x) / scale;
      const contentY = (fy - y) / scale;
      apply(nextScale, fx - contentX * nextScale, fy - contentY * nextScale);
    }

    function point(e) { return { x: e.clientX, y: e.clientY }; }

    function onPointerDown(e) {
      const img = e.target.closest && e.target.closest('.comic-page');
      if (!img || !root.contains(img)) return;
      focusImage(img);
      pointers.set(e.pointerId, point(e));
      try { img.setPointerCapture(e.pointerId); } catch (err) {}

      if (pointers.size === 1) {
        start = { point: point(e), x: x, y: y, time: Date.now() };
        moved = false;
        pinching = false;
      } else if (pointers.size === 2) {
        const pair = Array.from(pointers.values());
        start = {
          distance: Math.max(1, distance(pair[0], pair[1])),
          scale: scale,
          x: x,
          y: y,
          midpoint: { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 }
        };
        clearTimeout(tapTimer);
        tapTimer = 0;
        moved = true;
        pinching = true;
      }
    }

    function onPointerMove(e) {
      if (!pointers.has(e.pointerId) || !active) return;
      pointers.set(e.pointerId, point(e));

      if (pointers.size >= 2 && pinching) {
        const pair = Array.from(pointers.values()).slice(0, 2);
        const mid = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
        const nextScale = clamp(start.scale * distance(pair[0], pair[1]) / start.distance, MIN_SCALE, MAX_SCALE);
        const wrap = wrapperFor(active);
        const rect = wrap.getBoundingClientRect();
        const oldFx = start.midpoint.x - rect.left;
        const oldFy = start.midpoint.y - rect.top;
        const contentX = (oldFx - start.x) / start.scale;
        const contentY = (oldFy - start.y) / start.scale;
        const fx = mid.x - rect.left;
        const fy = mid.y - rect.top;
        apply(nextScale, fx - contentX * nextScale, fy - contentY * nextScale);
        e.preventDefault();
        return;
      }

      if (pointers.size === 1 && scale > 1 && start && start.point) {
        const p = point(e);
        if (Math.hypot(p.x - start.point.x, p.y - start.point.y) > TAP_SLOP) moved = true;
        apply(scale, start.x + p.x - start.point.x, start.y + p.y - start.point.y);
        e.preventDefault();
      }
    }

    function finishPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      const endedAt = point(e);
      pointers.delete(e.pointerId);

      if (pinching) {
        if (pointers.size === 0) pinching = false;
        else {
          const remaining = Array.from(pointers.values())[0];
          start = { point: remaining, x: x, y: y, time: Date.now() };
          pinching = false;
        }
        return;
      }
      if (moved || !start || !start.point) return;

      const now = Date.now();
      if (lastTap && now - lastTap.time <= DOUBLE_TAP_MS
          && Math.hypot(endedAt.x - lastTap.x, endedAt.y - lastTap.y) <= TAP_SLOP * 2) {
        clearTimeout(tapTimer);
        tapTimer = 0;
        lastTap = null;
        zoomAt(endedAt.x, endedAt.y, scale > 1 ? 1 : DOUBLE_TAP_SCALE);
        return;
      }

      lastTap = { time: now, x: endedAt.x, y: endedAt.y };
      clearTimeout(tapTimer);
      tapTimer = setTimeout(function () {
        tapTimer = 0;
        lastTap = null;
        if (typeof opts.onTap === 'function') opts.onTap();
      }, DOUBLE_TAP_MS);
    }

    function onClick(e) {
      if (e.target.closest && e.target.closest('.comic-page')) {
        // Pointer handling above owns image taps so the reader's ordinary click
        // handler cannot toggle its chrome halfway through a double tap.
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove, { passive: false });
    root.addEventListener('pointerup', finishPointer);
    root.addEventListener('pointercancel', finishPointer);
    root.addEventListener('click', onClick, true);

    return {
      reset: reset,
      scale: function () { return scale; },
      zoomAt: function (img, clientX, clientY, nextScale) {
        focusImage(img);
        zoomAt(clientX, clientY, nextScale);
      },
      destroy: function () {
        reset();
        root.removeEventListener('pointerdown', onPointerDown);
        root.removeEventListener('pointermove', onPointerMove);
        root.removeEventListener('pointerup', finishPointer);
        root.removeEventListener('pointercancel', finishPointer);
        root.removeEventListener('click', onClick, true);
      }
    };
  }

  window.ImageZoom = { create: create };
})();
