// Start the site on port 8000, then run: node tests/preview.test.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  let passed = 0;
  const pass = name => { passed++; console.log('PASS', name); };
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('https://cdnjs.cloudflare.com/**', route => route.abort());
    await page.goto('http://127.0.0.1:8000/');
    async function run(js, html = '<h1 id="result">ready</h1>') {
      await page.evaluate(({js,html}) => {
        for (const [id,value] of [['htmlHost',html],['jsHost',js],['cssHost','h1{color:rgb(255,0,0)}']]) {
          const host = document.getElementById(id);
          if(host.querySelector('.CodeMirror')) host.querySelector('.CodeMirror').CodeMirror.setValue(value);
          else { const input=host.querySelector('textarea'); input.value=value; input.dispatchEvent(new Event('input')); }
        }
        document.getElementById('clearConsole').click();
        document.getElementById('runBtn').click();
      }, {js,html});
    }
    async function consoleHas(text) {
      await page.locator('#consoleOut').filter({hasText:text}).waitFor({timeout:6000});
    }
    async function responsive() {
      const start = performance.now();
      await page.click('#themeToggle', {timeout:700});
      await page.click('[data-tab="js"]', {timeout:700});
      assert.ok(performance.now()-start < 700, 'editor must respond while worker is busy, before its timeout');
    }
    const badCode = 'console.log("should-not-autostart"); while(true){}';
    await page.evaluate(code => {
      localStorage.setItem('play_js', code);
      localStorage.setItem('play_html', '<script>while(true){}<\/script><h1>recovered</h1>');
    }, badCode);
    for (let reload = 0; reload < 2; reload++) {
      await page.reload();
      await page.frameLocator('#preview').getByRole('heading', {name:'recovered'}).waitFor();
      assert.equal(await page.locator('#jsHost textarea').inputValue(), badCode);
      assert.ok(!(await page.locator('#consoleOut').innerText()).includes('should-not-autostart'));
      await responsive();
    }
    pass('saved infinite JS and HTML scripts never run on load or repeated reload; source is preserved');

    // The "started" message is posted from the worker immediately before it blocks.
    // Interact BEFORE waiting for the watchdog, so iframe-style blocking cannot pass.
    for (const js of [
      'while(true) {}', 'for(;;);', 'do {} while(true);', 'for(let i=0;i>=0;i++) {}',
      'try { while(true) {} } catch(e) {}',
      'eval("while(true){}");', 'new Function("for(;;){}")( );',
      'class Test { freeze(){while(true){}} } new Test().freeze();',
      'const obj={get value(){while(true){}}}; obj.value;',
      'setTimeout(()=>{while(true){}},10);',
      'Promise.resolve().then(()=>{while(true){}});',
      'function repeat(){Promise.resolve().then(repeat)} repeat();',
      '/(a+)+$/.test("a".repeat(40)+"!");'
    ]) {
      await run('console.log("started");' + js);
      await consoleHas('started');
      await responsive();
      await consoleHas('лимит времени');
      pass('UI responsive during runaway worker, then terminated: ' + js);
    }
    await run('function recurse(){recurse()} recurse();');
    await consoleHas(/call stack|recursion/i);
    await responsive();
    pass('recursion error stays in worker');

    await run('', '<script>console.log("started"); while(true){}<\/script>');
    await consoleHas('started');
    await responsive();
    await consoleHas('лимит времени');
    pass('inline HTML scripts execute only in worker');

    await run('console.log("started");while(true){console.log(1)}');
    await consoleHas('started');
    await responsive();
    await consoleHas('лимит времени');
    assert.ok(await page.locator('#consoleOut > div').count() <= 111);
    pass('console flood cannot freeze editor');

    await run('for(let i=0;i<12000;i++) document.body.appendChild(document.createElement("p"));');
    await consoleHas('слишком много изменений DOM');
    await responsive();
    pass('oversized DOM batch is rejected before rendering');

    await run('for (let i = ; i < 10; i++) {}');
    await consoleHas(/Unexpected token/);
    pass('syntax error reported asynchronously without touching editor');

    await run(`let n=0; outer: for(let i=0;i<3;i++) for(let j=0;j<3;j++) {n++;continue outer;} const arrow=x=>({value:x+1}); document.querySelector('#result').textContent=String(n+arrow(4).value); console.log('<img src=x onerror=alert(1)>');`);
    let preview=page.frameLocator('#preview');
    await preview.locator('#result').filter({hasText:'8'}).waitFor();
    assert.equal(await preview.locator('#result').evaluate(el=>getComputedStyle(el).color),'rgb(255, 0, 0)');
    assert.equal(await page.locator('#consoleOut img').count(),0);
    pass('normal loops, DOM updates, CSS and text-only console');

    await run(`document.querySelector('#increment').addEventListener('click', () => {document.querySelector('#result').textContent='clicked';}); console.log('ready');`, '<button id="increment">Click</button><h1 id="result">ready</h1>');
    await consoleHas('ready');
    await preview.locator('#increment').click();
    await preview.locator('#result').filter({hasText:'clicked'}).waitFor();
    pass('DOM events cross worker bridge');

    await run('console.log("handler-ready")', '<button id="hang" onclick="console.log(\'started\');while(true){}">Hang</button>');
    await consoleHas('handler-ready');
    await preview.locator('#hang').click();
    await consoleHas('started');
    await responsive();
    await consoleHas('лимит времени');
    pass('inline event handler runs in worker, not rendering frame');

    await run('document.addEventListener("click",()=>console.log("preview-document-click"));console.log("ready");');
    await consoleHas('ready');
    await page.click('#themeToggle');
    assert.ok(!(await page.locator('#consoleOut').innerText()).includes('preview-document-click'));
    await preview.locator('#result').click();
    await consoleHas('preview-document-click');
    pass('document event listeners are confined to preview, never editor');

    await run('try {parent.document.body.innerHTML="broken"} catch(e) {console.log("isolated")} localStorage.clear();');
    await consoleHas('isolated');
    assert.ok(await page.evaluate(()=>localStorage.getItem('play_js')));
    pass('worker cannot access editor DOM or clear editor storage');

    await run('console.log("started");while(true){}');
    await consoleHas('started');
    const stopTime = performance.now();
    await page.click('#stopBtn', {timeout:700});
    assert.ok(performance.now()-stopTime < 700, 'Stop must terminate busy worker immediately');
    await consoleHas('Предпросмотр остановлен');
    await run('document.querySelector("#result").textContent="restarted";');
    await preview.locator('#result').filter({hasText:'restarted'}).waitFor();
    pass('Stop interrupts busy worker immediately; new run succeeds');

    await page.locator('#fileInput').setInputFiles({name:'bad-project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({html:'<h1>imported</h1>',css:'',js:'console.log("import-must-not-run"); while(true){}'}))});
    await consoleHas('Проект импортирован');
    await preview.getByRole('heading', {name:'imported'}).waitFor();
    assert.ok(!(await page.locator('#consoleOut').innerText()).includes('import-must-not-run'));
    await page.reload();
    await preview.getByRole('heading', {name:'imported'}).waitFor();
    await responsive();
    pass('import and reload restore dangerous source without executing it');
    await page.locator('#assetsInput').setInputFiles({name:'safe.txt',mimeType:'text/plain',buffer:Buffer.from('asset')});
    await page.locator('#assetsList .chip').waitFor({state:'attached'});
    await responsive();
    assert.ok(!(await page.locator('#consoleOut').innerText()).includes('import-must-not-run'));
    await page.evaluate(()=>document.querySelector('#assetsList .rm').click());
    assert.ok(!(await page.locator('#consoleOut').innerText()).includes('import-must-not-run'));
    pass('adding or removing assets never executes saved JavaScript');

    await run('console.log("started"); while(true) postMessage({spam:true});');
    await consoleHas('started');
    await consoleHas('слишком много сообщений');
    await responsive();
    pass('raw worker message flood is stopped externally');
    assert.deepEqual(pageErrors, []);
    console.log(`${passed} checks passed; no editor page errors.`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
