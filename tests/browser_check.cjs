/* Actual HTTP/browser regression; no GitHub credentials or production writes. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const ROOT=path.resolve(__dirname,'..');
const OUT=process.env.SKYLINE_EVIDENCE || path.join(ROOT,'test-results');
const CHANNEL=process.env.SKYLINE_BROWSER_CHANNEL;
fs.mkdirSync(OUT,{recursive:true});
const sample=JSON.parse(fs.readFileSync(path.join(ROOT,'preview/contributions-demo.json'),'utf8'));
let servedData=null;
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/docs/contributions.json'){
    if(servedData===null){res.writeHead(404);res.end('not generated');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(servedData));return;
  }
  const filename=path.join(ROOT,pathname==='/'?'docs/index.html':decodeURIComponent(pathname));
  const resolved=path.resolve(filename);
  if(!resolved.startsWith(ROOT+path.sep)){res.writeHead(403);res.end();return;}
  const actual=filename.endsWith(path.sep)?path.join(filename,'index.html'):filename;
  fs.readFile(actual,(err,data)=>{if(err){res.writeHead(404);res.end();return;}
    res.setHeader('Content-Type',actual.endsWith('.js')?'application/javascript':actual.endsWith('.css')?'text/css':actual.endsWith('.json')?'application/json':'text/html');res.end(data);
  });
});
const checks=[];
function check(name,fn){return Promise.resolve().then(fn).then(()=>{checks.push(name);console.log('PASS '+name);});}
async function frame(page,t){await page.evaluate(t=>{const g=window.__skyline;if(g.raf)cancelAnimationFrame(g.raf);g.raf=0;g.t=g.viewTarget=t;g.setButtons();g.render(performance.now());if(g.raf)cancelAnimationFrame(g.raf);g.raf=0;},t);}
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({...(CHANNEL?{channel:CHANNEL}:{}),headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1100,height:900}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(origin+'/docs/?demo=1');
    await page.waitForFunction(()=>window.__skyline?.cells.length>0);
    await check('explicit demo uses SAMPLE DATA',async()=>{
      assert.equal(await page.locator('#sample-tag').isVisible(),true);
      assert.equal(await page.locator('#total').textContent(),'1,720');
    });
    for(const [name,t] of [['2d',0],['mid-morph',0.5],['3d',1]]){
      await frame(page,t);
      await page.screenshot({path:path.join(OUT,'desktop-'+name+'.png'),fullPage:true});
    }
    await check('3D painter order uses the actual yaw',async()=>{
      const result=await page.evaluate(()=>{const g=window.__skyline;return g.hitPolys.map(h=>{const c=g.cells[h.index];return (c.week+.5)*Math.sin(Math.PI/4)+(c.dow+.5)*Math.cos(Math.PI/4);});});
      assert.ok(result.every((n,i)=>i===0||n>=result[i-1]-1e-9),'bars must draw back to front');
    });
    await check('mobile and desktop labels fit',async()=>{
      for(const width of [1100,390,320]){
        await page.setViewportSize({width,height:900});await frame(page,1);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        await page.screenshot({path:path.join(OUT,width===1100?'desktop-fit.png':'mobile-'+width+'.png'),fullPage:true});
      }
    });
    await page.setViewportSize({width:1100,height:900});await frame(page,1);
    await check('hover tooltip stays within scene bounds',async()=>{
      await page.locator('canvas').focus();await page.keyboard.press('End');
      await page.waitForFunction(()=>document.querySelector('#tooltip').classList.contains('show'));
      const fit=await page.evaluate(()=>{const tip=document.querySelector('#tooltip').getBoundingClientRect(),card=document.querySelector('.inner').getBoundingClientRect();return tip.left>=card.left&&tip.right<=card.right&&tip.top>=card.top;});
      assert.equal(fit,true);
      await page.screenshot({path:path.join(OUT,'desktop-tooltip.png'),fullPage:true});
    });
    await check('keyboard announces selected day and Escape clears',async()=>{
      assert.ok((await page.locator('#live').textContent()).includes('Nov 8, 2017'));
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#tooltip').classList.contains('show'));
    });
    await check('keyboard navigation moves a pinned tooltip to the announced date',async()=>{
      await page.locator('canvas').focus();await page.keyboard.press('Home');await page.keyboard.press('Enter');await page.keyboard.press('ArrowRight');
      await page.waitForFunction(()=>document.querySelector('#tooltip').textContent.includes('Nov 13, 2016'),{},{timeout:1500});
      assert.ok((await page.locator('#live').textContent()).includes('Nov 13, 2016'));
      await page.keyboard.press('Escape');
    });
    await check('orbit drag and double-click reset',async()=>{
      const box=await page.locator('canvas').boundingBox();
      await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
      await page.mouse.move(box.x+box.width/2+90,box.y+box.height/2+25,{steps:5});await page.mouse.up();
      await page.waitForFunction(()=>Math.abs(window.__skyline.yawOffset)>.1);
      await page.screenshot({path:path.join(OUT,'desktop-orbit.png'),fullPage:true});
      await page.locator('canvas').dblclick();await page.waitForFunction(()=>Math.abs(window.__skyline.yawOffset)<.001);
    });
    await check('morph reverses continuously',async()=>{
      await frame(page,.6);const before=await page.evaluate(()=>window.__skyline.t);
      await page.locator('#grid-btn').click();
      await page.waitForFunction(()=>window.__skyline.t<.58);
      const after=await page.evaluate(()=>window.__skyline.t);assert.ok(after<before&&after>0);
      await page.waitForFunction(()=>window.__skyline.t===0);
    });
    await check('all palettes and dark theme render',async()=>{
      for(const palette of ['github','halloween','ocean','ember','grape','mono'])await page.selectOption('#palette',palette);
      await page.selectOption('#palette','github');await page.locator('#dark-btn').click();await frame(page,1);
      assert.equal(await page.getAttribute('html','data-theme'),'light');
      await page.locator('#dark-btn').click();await frame(page,1);
      await page.screenshot({path:path.join(OUT,'desktop-dark.png'),fullPage:true});
    });
    await check('reduced-motion toggles instantly including orbit',async()=>{
      await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForFunction(()=>window.__skyline?.cells.length>0);
      await page.locator('#grid-btn').click();assert.equal(await page.evaluate(()=>window.__skyline.t),0);
      await page.locator('#skyline-btn').click();assert.equal(await page.evaluate(()=>window.__skyline.t),1);
    });
    await check('missing HTTP data has an honest unavailable state',async()=>{
      servedData=null;await page.goto(origin+'/docs/');
      await page.waitForFunction(()=>document.documentElement.dataset.dataState==='error');
      assert.equal(await page.locator('#total').textContent(),'—');
      assert.equal(await page.locator('#sample-tag').isVisible(),false);
      await page.screenshot({path:path.join(OUT,'data-unavailable.png'),fullPage:true});
    });
    await check('HTTP sample JSON remains explicitly labelled',async()=>{
      servedData=sample;await page.reload();await page.waitForFunction(()=>window.__skyline?.cells.length>0);
      assert.equal(await page.locator('#sample-tag').isVisible(),true);
    });
    await check('wrong account or missing provenance cannot show authentic data',async()=>{
      for(const data of [{...sample,isDemo:false},{...sample,isDemo:undefined},{...sample,isDemo:false,username:'Title5656',stats:{total:99}}]){
        servedData=data;await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.dataState==='error');
        assert.equal(await page.locator('#total').textContent(),'—');
      }
    });
    await check('valid authentic-shaped zero data has matching stats (HTTP fixture only)',async()=>{
      servedData={username:'Title5656',generatedAt:'2026-10-20T12:00:00Z',isDemo:false,days:[{date:'2026-10-20',count:0}],stats:{total:0}};
      await page.reload();await page.waitForFunction(()=>document.documentElement.dataset.dataState==='ready');
      assert.equal(await page.locator('#sample-tag').isVisible(),false);assert.equal(await page.locator('#total').textContent(),'0');
      assert.equal(await page.locator('#busiest-date').textContent(),'—');
    });
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(OUT,'browser-results.json'),JSON.stringify({checks,errors,browser:browser.version(),transport:'real local HTTP; fixture datasets; not GitHub production'},null,2));
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
