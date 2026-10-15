import {chromium,expect} from '@playwright/test';
import {mkdirSync} from 'node:fs';
mkdirSync('artifacts', {recursive:true});
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.BASE_URL || 'http://localhost:5173');await page.waitForTimeout(800);
for(const label of ['Posts','Audience','Grow','Monetize','Automations','Website','Analytics','Settings']){
 await page.locator('.sidebar').getByRole('button',{name:label,exact:true}).click();
 await page.locator('.page-loading').waitFor({state:'hidden'});await page.waitForTimeout(200);
 const size=await page.evaluate(()=>({width:document.body.scrollWidth,viewport:innerWidth}));
 console.log(label,JSON.stringify(size));
 if(['Posts','Audience','Website','Automations'].includes(label))await page.screenshot({path:`artifacts/${label.toLowerCase()}-desktop.png`,fullPage:true});
}
await page.setViewportSize({width:390,height:844});
for(const label of ['Home','Posts','Audience','Grow','Monetize','Automations','Website','Analytics','Settings']){
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.locator('.sidebar').getByRole('button',{name:label,exact:true}).click();
 await page.waitForTimeout(120);
 const size=await page.evaluate(()=>({width:document.body.scrollWidth,viewport:innerWidth}));
 console.log('mobile '+label,JSON.stringify(size));
 if(size.width>size.viewport)console.log('OVERFLOW',await page.evaluate(()=>[...document.querySelectorAll('*')].filter(x=>x.getBoundingClientRect().right>innerWidth+1).map(x=>({tag:x.tagName,cls:x.className,width:x.getBoundingClientRect().width})).slice(0,10)));
}
console.log('errors',errors);
await browser.close();
