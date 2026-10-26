import { upgrade } from './vendor/worker-dom/main.mjs';

const TIMEOUT = 1200;
const BLOCKED_ELEMENTS = new Set(['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'BASE', 'META']);
let runtime;
function workerRuntime() {
  return runtime ||= fetch(new URL('./vendor/worker-dom/worker.js', import.meta.url))
    .then(response => {
      if (!response.ok) throw new Error('Не удалось загрузить среду выполнения JavaScript.');
      return response.text();
    }).catch(error => { runtime = null; throw error; });
}

// This entire function is serialized into the worker, never called on the UI thread.
function workerBootstrap(sources, handlers, channel) {
  const send = self.postMessage.bind(self);
  const listen = self.addEventListener.bind(self);
  const evaluate = (0, eval);
  const compile = Function;
  const stringify = String;
  const now = performance.now.bind(performance);
  let sent = 0;
  let windowStart = now();
  // Bound messages at the source too: an already queued flood cannot be recalled
  // by terminate(). This covers direct postMessage and WorkerDOM's transport.
  const limitedSend = (...args) => {
    if (now() - windowStart > 100) { sent = 0; windowStart = now(); }
    if (++sent > 100) {
      send({channel, kind:'limit'});
      throw new Error('Предпросмотр остановлен: слишком много сообщений.');
    }
    send(...args);
  };
  Object.defineProperty(self, 'postMessage', {value:limitedSend, writable:false, configurable:false});
  Object.defineProperty(document, 'postMessage', {value:limitedSend, writable:false, configurable:false});
  let messages = 0;
  const report = (level, values) => {
    if (messages++ >= 100) return;
    send({ channel, kind: 'log', level, text: values.slice(0, 10).map(value => {
      try { return stringify(value).slice(0, 2000); } catch { return '[недоступное значение]'; }
    }).join(' ') });
  };
  ['log', 'info', 'warn', 'error'].forEach(level => {
    console[level] = (...values) => report(level, values);
  });
  listen('message', event => {
    if (event.data?.channel === channel && event.data.kind === 'ping') {
      send({ channel, kind: 'pong', sequence: event.data.sequence });
    }
  });
  listen('error', event => report('error', [event.message]));
  listen('unhandledrejection', event => report('error', [event.reason?.message || event.reason]));
  for (const handler of handlers) {
    const element = document.querySelector(handler.selector);
    if (element) {
      const fn = compile('event', handler.code);
      element.addEventListener(handler.event, function(event) { return fn.call(this, event); });
    }
  }
  // Queue user code as a separate task so the parent can install its watchdog first.
  setTimeout(() => {
    for (const source of sources) {
      try { evaluate(source); } catch (error) { report('error', [error.message]); }
    }
    document.dispatchEvent(new Event('DOMContentLoaded', {bubbles:false, cancelable:false}));
    self.dispatchEvent(new MessageEvent('load'));
  }, 0);
}

export class PreviewRunner {
  constructor({ log, onFrame }) {
    this.log = log;
    this.onFrame = onFrame;
    this.session = null;
  }

  stop() {
    const session = this.session;
    this.session = null;
    if (!session) return;
    clearInterval(session.watchdog);
    session.controller?.terminate();
    if (session.worker) session.worker.onmessage = null;
    // Event listeners installed by WorkerDOM are owned by this disposable frame.
    session.frame.remove();
  }

  async render(html, css, js, execute = false) {
    this.stop();
    const previous = document.getElementById('preview');
    const frame = document.createElement('iframe');
    frame.id = 'preview';
    // Rendering only: user JS is NEVER allowed to execute in this document.
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.referrerPolicy = 'no-referrer';
    const session = { frame, lastPong: performance.now(), pending: null, messages: 0, incoming: 0 };
    this.session = session;
    if (previous) previous.replaceWith(frame);
    else document.getElementById('viewport').appendChild(frame);

    const fail = message => {
      if (this.session !== session) return;
      this.stop();
      // Keep a blank preview slot for the next run and layout updates.
      const placeholder = frame.cloneNode(false);
      placeholder.removeAttribute('srcdoc');
      document.getElementById('viewport').appendChild(placeholder);
      this.onFrame(placeholder);
      this.log('error', message);
    };

    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const sources = [];
      const handlers = [];
      for (const script of doc.querySelectorAll('script')) {
        const type = (script.getAttribute('type') || '').trim().toLowerCase();
        if (!type || ['text/javascript', 'application/javascript', 'module'].includes(type)) {
          if (execute && (script.hasAttribute('src') || type === 'module')) {
            throw new Error('Внешние скрипты и модули в HTML не поддерживаются. Поместите код во вкладку JS.');
          }
          sources.push(script.textContent);
        }
        script.remove();
      }
      let handlerId = 0;
      for (const element of doc.querySelectorAll('*')) {
        if (BLOCKED_ELEMENTS.has(element.tagName)) { element.remove(); continue; }
        for (const attr of [...element.attributes]) {
          if (/^on/i.test(attr.name)) {
            const id = element.getAttribute('data-preview-event') || String(++handlerId);
            element.setAttribute('data-preview-event', id);
            handlers.push({selector: '[data-preview-event=' + id + ']', event: attr.name.slice(2), code: attr.value});
            element.removeAttribute(attr.name);
          }
          if (attr.name === 'srcdoc' || /^\s*javascript:/i.test(attr.value)) element.removeAttribute(attr.name);
        }
      }
      // A script-free, same-origin frame lets the trusted renderer apply DOM updates.
      // Sandbox also blocks execution if user markup tries to inject an active script.
      const policy = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' data: https:; img-src data: blob: https:; media-src data: blob: https:; font-src data: https:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
      const loaded = new Promise(resolve => frame.addEventListener('load', resolve, {once:true}));
      // Do not concatenate user markup into the policy or trusted head.
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + policy + '"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>';
      await loaded;
      if (this.session !== session) return;
      const target = frame.contentDocument;
      target.head.append(...[...doc.head.childNodes].map(node => target.importNode(node, true)));
      const style = target.createElement('style');
      style.textContent = css;
      target.head.appendChild(style);
      target.body.append(...[...doc.body.childNodes].map(node => target.importNode(node, true)));
      this.onFrame(frame);
      if (!execute) return;

      const channel = Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-');
      const boot = '(' + workerBootstrap.toString() + ')(' + JSON.stringify([...sources, js]) + ',' + JSON.stringify(handlers) + ',' + JSON.stringify(channel) + ');';
      const domScript = await workerRuntime();
      if (this.session !== session) return;
      const safeAttribute = (node, name, value) => {
        if (/^on/i.test(name) || ['srcdoc','nonce','http-equiv'].includes(name.toLowerCase())) return;
        if (/^\s*javascript:/i.test(value || '')) return;
        if (value === null) node.removeAttribute(name);
        else node.setAttribute(name, value);
      };
      const sanitizer = {
        sanitize: node => !BLOCKED_ELEMENTS.has(node.nodeName),
        setAttribute: safeAttribute,
        setProperty: (node, name, value) => {
          if (['value','checked','selected','disabled','textContent','className','id'].includes(name)) node[name] = value;
        }
      };
      session.controller = await upgrade(target.body, Promise.resolve([domScript, boot]), {
        authorURL: 'preview-user-code.js',
        sanitizer,
        // DOM, events and geometry only; never execute arbitrary objects or write editor storage.
        executorsAllowed: [0, 1, 2, 3, 4, 5],
        mutationPump: flush => requestAnimationFrame(() => {
          if (this.session === session) flush();
        })
      });
      if (this.session !== session) { session.controller?.terminate(); return; }
      // Adapter for the pinned WorkerDOM 0.36.0: its public wrapper only exposes terminate().
      const worker = session.controller.workerContext_.worker;
      session.worker = worker;
      const applyMutation = worker.onmessage;
      let budget = 0;
      let nodes = 0;
      let stringBytes = 0;
      worker.onmessage = event => {
        if (this.session !== session) return;
        if (++session.incoming > 250) { fail('Предпросмотр остановлен: слишком много сообщений.'); return; }
        const data = event.data;
        if (data?.channel === channel) {
          if (data.kind === 'limit') { fail('Предпросмотр остановлен: слишком много сообщений.'); return; }
          if (data.kind === 'pong' && data.sequence === session.pending) {
            session.pending = null;
            session.lastPong = performance.now();
          } else if (data.kind === 'log' && ['log','info','warn','error'].includes(data.level)) {
            if (++session.messages > 110) { fail('Предпросмотр остановлен: слишком много сообщений.'); return; }
            this.log(data.level, String(data.text).slice(0,20000));
          }
          return;
        }
        if (![2,3].includes(data?.[12])) return;
        const mutationSize = data[36]?.byteLength || 0;
        nodes += (data[37]?.byteLength || 0) / 10;
        stringBytes += (data[41] || []).reduce((n, s) => n + s.length, 0);
        budget += mutationSize;
        // Refuse oversized batches BEFORE asking the UI thread to render them.
        if (mutationSize > 16000 || budget > 1000000 || nodes > 10000 || stringBytes > 2000000) {
          fail('Предпросмотр остановлен: слишком много изменений DOM. Проверьте циклы.');
          return;
        }
        try { applyMutation(event); } catch (error) { fail(error.message); }
      };
      worker.onerror = event => { event.preventDefault(); fail(event.message || 'Ошибка выполнения JavaScript.'); };
      session.lastPong = performance.now();
      let sequence = 0;
      session.watchdog = setInterval(() => {
        if (this.session !== session) return;
        session.incoming = 0;
        if (performance.now() - session.lastPong > TIMEOUT) {
          fail('Выполнение остановлено: превышен лимит времени. Проверьте циклы. Код сохранён — исправьте его и нажмите «Запуск».');
          return;
        }
        if (session.pending === null) {
          session.pending = ++sequence;
          worker.postMessage({channel,kind:'ping',sequence});
        }
      }, 100);
    } catch (error) { fail(error.message); }
  }
}

window.PreviewRunner = PreviewRunner;
