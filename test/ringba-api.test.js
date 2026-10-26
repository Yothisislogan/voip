import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import { config } from '../src/config.js';
import { createRingbaRouter } from '../src/routes/ringba.js';
import { apiLimiter } from '../src/middleware/rateLimit.js';
test('Ringba requires a dedicated bearer token, supports GET/POST, fails closed and has a separate rate bucket',async t=>{
  const saved={...config.ringba};Object.assign(config.ringba,{token:'test-only-token-'.repeat(3),requestsPerMinute:4});t.after(()=>Object.assign(config.ringba,saved));
  const app=express();app.use(express.json());app.use('/api',apiLimiter);app.get('/api/browser',(_q,res)=>res.json({ok:true}));
  app.use(createRingbaRouter({read:async campaign=>{if(campaign==='broken')throw new Error('private DB detail');return{response:{available:1,active:1,accept:true,status:'green'},campaign};}}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
  const send=async(method,campaign,auth=true)=>{
    const response=await fetch(`${base}/integrations/ringba/availability${method==='GET'?`?campaign=${campaign}`:''}`,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${config.ringba.token}`}:{Cookie:'wit_session=not-accepted'})},...(method==='POST'?{body:JSON.stringify({campaign})}:{})});
    return{response,body:await response.json()};
  };
  const noAuth=await send('GET','auto',false);assert.equal(noAuth.response.status,401);assert.equal(noAuth.body.response.available,0);
  assert.equal((await fetch(base+'/integrations/ringba/availability?campaign=auto',{headers:{Authorization:config.ringba.token}})).status,401);
  for(const method of ['GET','POST']){const result=await send(method,'auto');assert.equal(result.response.status,200);assert.equal(result.body.response.accept,true);assert.equal(result.response.headers.get('cache-control'),'no-store');}
  assert.equal((await send('POST',['auto'])).response.status,400);
  const failed=await send('GET','broken');assert.equal(failed.response.status,503);assert.equal(failed.body.response.available,0);assert.ok(!JSON.stringify(failed.body).includes('private DB'));
  const limited=await send('GET','auto');assert.equal(limited.response.status,429);assert.equal(limited.body.response.accept,false);assert.ok(limited.response.headers.get('retry-after'));
  assert.equal((await fetch(base+'/api/browser')).status,200);
});
