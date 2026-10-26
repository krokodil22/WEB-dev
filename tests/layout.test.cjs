// Start the site on port 8000, then run: node tests/layout.test.cjs
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  let passed = 0;
  const pass = name => { passed++; console.log('PASS',name); };
  try {
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://cdnjs.cloudflare.com/**',route=>route.abort());
    await page.goto('http://127.0.0.1:8000/');
    const editor = page.locator('#editorPanel');
    const preview = page.locator('#previewPanel');
    const divider = page.getByRole('separator');
    const layout = page.getByRole('button',{name:'Вертикальное расположение окон'});
    async function setLayout(value) {
      if ((await layout.getAttribute('aria-pressed') === 'true') !== (value === 'vertical')) await layout.click();
    }
    async function box(locator) { return locator.boundingBox(); }
    async function drag(dx,dy) {
      await divider.scrollIntoViewIfNeeded();
      const rect = await box(divider);
      const x = rect.x+rect.width/2;
      const y = rect.y+Math.min(rect.height/2,150);
      await page.mouse.move(x,y);
      await page.mouse.down();
      await page.mouse.move(x+dx,y+dy,{steps:10});
      await page.mouse.up();
      await page.waitForFunction(()=>!document.getElementById('workbench').classList.contains('resizing'));
    }
    assert.equal(await page.getByRole('button',{name:/Стоп/}).count(),0);
    assert.equal(await layout.getAttribute('aria-pressed'),'false');
    let e = await box(editor), p = await box(preview);
    assert.ok(Math.abs(e.y-p.y)<2 && p.x>e.x+e.width);
    assert.equal((await layout.innerText()).trim(),'');
    assert.equal(await layout.locator('svg').count(),1);
    // Native button activation must work with both Space and Enter.
    await layout.focus();
    await page.keyboard.press('Space');
    assert.equal(await layout.getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('#workbench').getAttribute('data-layout'),'vertical');
    await page.keyboard.press('Enter');
    assert.equal(await layout.getAttribute('aria-pressed'),'false');
    assert.equal(await page.locator('#workbench').getAttribute('data-layout'),'horizontal');
    pass('icon-only toggle works with keyboard and desktop defaults to side-by-side panes');

    await page.evaluate(()=>{
      const html=document.querySelector('#htmlHost textarea');html.value='<h1 id="layout-result">preview survives</h1>';html.dispatchEvent(new Event('input'));
      const js=document.querySelector('#jsHost textarea');js.value='console.log("layout-ready")';js.dispatchEvent(new Event('input'));
      document.getElementById('runBtn').click();
    });
    await page.locator('#consoleOut').filter({hasText:'layout-ready'}).waitFor();
    await page.evaluate(()=>{window.layoutFrame=document.getElementById('preview');});
    const before = await box(editor);
    await drag(150,0);
    e = await box(editor);p = await box(preview);
    assert.ok(e.width>before.width+120,'dragging boundary must widen actual editor');
    assert.ok(p.width<before.width-100,'preview must shrink');
    assert.ok(Math.abs((await box(divider)).x-e.x-e.width)<2);
    assert.equal(await page.evaluate(()=>document.getElementById('preview')===window.layoutFrame),true);
    await page.frameLocator('#preview').getByText('preview survives').waitFor();
    await page.waitForFunction(()=>document.getElementById('viewport').style.transform.includes('scale('));
    const scaled = await page.locator('#viewport').boundingBox();
    assert.ok(scaled.width<=p.width+2,'emulator must scale to resized pane');
    const savedWidth = e.width;
    pass('drag changes both widths and rescales emulator without restarting it');

    await page.reload();
    assert.ok(Math.abs((await box(editor)).width-savedWidth)<2);
    assert.equal(await page.locator('#jsHost textarea').inputValue(),'console.log("layout-ready")');
    pass('width and source code persist after reload');

    await setLayout('vertical');
    e=await box(editor);p=await box(preview);
    assert.ok(p.y>e.y+e.height && Math.abs(p.x-e.x)<2 && Math.abs(e.width-p.width)<2);
    assert.equal(await divider.getAttribute('aria-orientation'),'horizontal');
    const beforeHeight=e.height;
    await drag(0,120);
    assert.ok((await box(editor)).height>beforeHeight+100);
    const savedHeight=(await box(editor)).height;
    await page.reload();
    assert.equal(await layout.getAttribute('aria-pressed'),'true');
    assert.ok(Math.abs((await box(editor)).height-savedHeight)<2);
    pass('stacked layout, vertical drag and height persist after reload');

    await setLayout('horizontal');
    assert.ok(Math.abs((await box(editor)).width-savedWidth)<2);
    await divider.focus();
    const beforeKey=(await box(editor)).width;
    await page.keyboard.press('ArrowLeft');
    assert.ok((await box(editor)).width<beforeKey-20);
    await page.keyboard.press('Home');
    assert.ok((await box(editor)).width>=210,'minimum width keeps editor usable');
    await page.keyboard.press('End');
    assert.ok((await box(preview)).width>=210,'maximum width keeps preview usable');
    await divider.dblclick();
    e=await box(editor);p=await box(preview);
    assert.ok(Math.abs(e.width-p.width)<2,'double click restores equal widths');
    await setLayout('vertical');
    assert.ok(Math.abs((await box(editor)).height-savedHeight)<2,'each orientation retains own dimension');
    pass('independent dimensions, keyboard sizing, bounds and double-click reset');

    await page.evaluate(()=>localStorage.removeItem('workspace_layout'));
    await page.setViewportSize({width:390,height:844});
    await page.reload();
    assert.equal(await layout.getAttribute('aria-pressed'),'true');
    e=await box(editor);p=await box(preview);
    assert.ok(p.y>e.y+e.height);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await setLayout('horizontal');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    pass('small screen defaults to stacked panes and both layouts avoid page overflow');

    await page.setViewportSize({width:1440,height:1000});
    await setLayout('horizontal');
    await divider.scrollIntoViewIfNeeded();
    const rect=await box(divider);
    await page.mouse.move(rect.x+rect.width/2,rect.y+100);
    await page.mouse.down();
    await page.mouse.move(rect.x+200,rect.y+100,{steps:5});
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    assert.equal(await page.evaluate(()=>document.getElementById('workbench').classList.contains('resizing')),false);
    assert.equal(await page.locator('#preview').evaluate(el=>getComputedStyle(el).pointerEvents),'auto');
    pass('interrupted drag restores iframe input');
    await page.screenshot({path:'/tmp/web-dev-layout-horizontal.png',fullPage:true});
    await setLayout('vertical');
    await page.screenshot({path:'/tmp/web-dev-layout-vertical.png',fullPage:true});
    assert.deepEqual(errors,[]);
    console.log(`${passed} layout checks passed; no page errors.`);
  } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
