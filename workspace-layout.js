(function () {
  'use strict';
  document.addEventListener('DOMContentLoaded', function () {
    const workbench = document.getElementById('workbench');
    const editor = document.getElementById('editorPanel');
    const splitter = document.getElementById('panelSplitter');
    const toggle = document.getElementById('layoutToggle');
    const keys = { layout: 'workspace_layout', share: 'workspace_editor_share', height: 'workspace_editor_height' };
    function read(key) { try { return localStorage.getItem(key); } catch { return null; } }
    function write(key, value) { try { localStorage.setItem(key, value); } catch {} }
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const savedNumber = (key, fallback, min, max) => {
      const raw = read(key);
      const value = raw === null ? NaN : Number(raw);
      return Number.isFinite(value) ? clamp(value, min, max) : fallback;
    };
    const savedLayout = read(keys.layout);
    let layout = ['horizontal', 'vertical'].includes(savedLayout) ? savedLayout :
      (window.matchMedia('(min-width: 768px)').matches ? 'horizontal' : 'vertical');
    let share = savedNumber(keys.share, 50, 20, 80);
    let height = savedNumber(keys.height, Math.max(220, Math.round(innerHeight * 0.55)), 220, 1600);
    let drag = null;

    function bounds() {
      const width = workbench.clientWidth - splitter.offsetWidth;
      const min = width > 0 ? Math.max(20, Math.min(220 / width * 100, 35)) : 20;
      return { width, min, max: 100 - min };
    }
    function apply() {
      workbench.dataset.layout = layout;
      const horizontal = layout === 'horizontal';
      toggle.setAttribute('aria-pressed', String(!horizontal));
      toggle.title = horizontal ? 'Расположить окна сверху вниз' : 'Расположить окна слева направо';
      const range = horizontal ? bounds() : { min: 220, max: 1600 };
      const value = horizontal ? clamp(share, range.min, range.max) : height;
      const trackShare = horizontal ? value : share;
      workbench.style.setProperty('--editor-track', trackShare + 'fr');
      workbench.style.setProperty('--preview-track', (100 - trackShare) + 'fr');
      workbench.style.setProperty('--editor-height', height + 'px');
      splitter.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
      splitter.setAttribute('aria-label', horizontal ? 'Изменить ширину редактора' : 'Изменить высоту редактора');
      splitter.setAttribute('aria-valuemin', Math.round(range.min));
      splitter.setAttribute('aria-valuemax', Math.round(range.max));
      splitter.setAttribute('aria-valuenow', Math.round(value));
      splitter.setAttribute('aria-valuetext', horizontal ? Math.round(value) + '% ширины' : Math.round(height) + ' пикселей высоты');
      window.dispatchEvent(new Event('workbenchresize'));
    }
    function saveSize() {
      write(keys.share, share);
      write(keys.height, height);
    }
    function resizeTo(value) {
      if (layout === 'horizontal') {
        const range = bounds();
        share = clamp(value, range.min, range.max);
      } else height = clamp(value, 220, 1600);
      apply();
    }
    function finish(event) {
      if (!drag || (event?.pointerId !== undefined && event.pointerId !== drag.id)) return;
      const id = drag.id;
      drag = null;
      workbench.classList.remove('resizing');
      splitter.classList.remove('dragging');
      document.documentElement.classList.remove('resizing-horizontal', 'resizing-vertical');
      if (splitter.hasPointerCapture(id)) splitter.releasePointerCapture(id);
      saveSize();
    }
    toggle.addEventListener('click', function () {
      finish();
      layout = layout === 'horizontal' ? 'vertical' : 'horizontal';
      write(keys.layout, layout);
      apply();
    });
    splitter.addEventListener('pointerdown', function (event) {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      splitter.focus({ preventScroll: true });
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, width: editor.getBoundingClientRect().width, height: editor.getBoundingClientRect().height };
      splitter.setPointerCapture(event.pointerId);
      workbench.classList.add('resizing');
      splitter.classList.add('dragging');
      document.documentElement.classList.add('resizing-' + layout);
    });
    splitter.addEventListener('pointermove', function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      if (layout === 'horizontal') {
        const width = bounds().width;
        if (width > 0) resizeTo((drag.width + event.clientX - drag.x) / width * 100);
      } else resizeTo(drag.height + event.clientY - drag.y);
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => splitter.addEventListener(type, finish));
    window.addEventListener('blur', () => finish());
    splitter.addEventListener('keydown', function (event) {
      const horizontal = layout === 'horizontal';
      const minus = horizontal ? 'ArrowLeft' : 'ArrowUp';
      const plus = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (![minus, plus, 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const range = horizontal ? bounds() : { min: 220, max: 1600 };
      const current = horizontal ? clamp(share, range.min, range.max) : height;
      const step = horizontal ? 24 / Math.max(1, range.width) * 100 : 24;
      resizeTo(event.key === 'Home' ? range.min : event.key === 'End' ? range.max : current + (event.key === plus ? step : -step));
      saveSize();
    });
    splitter.addEventListener('dblclick', function () {
      resizeTo(layout === 'horizontal' ? 50 : Math.max(220, Math.round(innerHeight * 0.55)));
      saveSize();
    });
    window.addEventListener('resize', apply);
    apply();
  });
})();
