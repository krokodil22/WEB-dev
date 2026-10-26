// Start the site on port 8000, then run: node tests/watchdog.test.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  try {
    const page = await browser.newPage();
    await page.route('https://cdnjs.cloudflare.com/**',route=>route.abort());
    // Advance the editor's timers independently of the native worker event loop.
    // fastForward fires a missed interval once, like returning from suspended work.
    await page.clock.install();
    await page.goto('http://127.0.0.1:8000/');
    async function run(js) {
      await page.evaluate(js=>{
        const html=document.querySelector('#htmlHost textarea');
        html.value='<h1 id="counter">0</h1>';html.dispatchEvent(new Event('input'));
        const input=document.querySelector('#jsHost textarea');
        input.value=js;input.dispatchEvent(new Event('input'));
        document.getElementById('clearConsole').click();
        document.getElementById('runBtn').click();
      },js);
    }
    async function assertRunning() {
      assert.equal(page.workers().length,1,'healthy worker must remain alive');
      assert.equal(await page.locator('#consoleOut').innerText(),'[log] ready');
      const counter=page.frameLocator('#preview').locator('#counter');
      const before=await counter.innerText();
      await counter.filter({hasText:new RegExp('^(?!'+before+'$)\\d+$')}).waitFor();
    }
    await run('let n=0;setInterval(()=>{document.querySelector("#counter").textContent=String(++n)},100);console.log("ready");');
    await page.locator('#consoleOut').filter({hasText:'ready'}).waitFor();
    const frame=await page.locator('#preview').elementHandle();
    const worker=page.workers()[0];
    await page.clock.fastForward(5*60*1000);
    await assertRunning();
    assert.equal(await frame.evaluate(el=>el===document.getElementById('preview')),true);
    console.log('PASS healthy site survives a long gap in editor timer scheduling');

    await page.evaluate(()=>{
      window.testVisibility='hidden';
      Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>window.testVisibility});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    // Keep the page hidden across multiple checks, without simulating a timer gap.
    await page.clock.runFor(1800);
    assert.equal(page.workers()[0],worker);
    await page.evaluate(()=>{
      window.testVisibility='visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(1800);
    await assertRunning();
    console.log('PASS hidden and resumed healthy page keeps running without console warnings');

    // Freeze the worker, then resume the editor after a scheduling pause.
    // Monitoring must start a new probe and still terminate the actual hung worker.
    await run('console.log("started");while(true){}');
    await page.locator('#consoleOut').filter({hasText:'started'}).waitFor();
    const busy=page.workers()[0];
    const closed=busy.waitForEvent('close',{timeout:6000});
    await page.clock.fastForward(60000);
    await page.clock.runFor(1800);
    await closed;
    assert.equal(await page.locator('#consoleOut').innerText(),'[log] started');
    await page.frameLocator('#preview').locator('#counter').waitFor();
    await page.click('#themeToggle');
    console.log('PASS actual infinite loop terminates silently and preserves rendered preview');
    await run('document.querySelector("#counter").textContent="recovered";');
    await page.frameLocator('#preview').getByText('recovered',{exact:true}).waitFor();
    assert.equal(await page.locator('#consoleOut').innerText(),'');
    console.log('PASS corrected code runs after silent termination');
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
