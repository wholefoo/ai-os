// Boots a disposable source copy with synthetic credentials and outbound networking disabled.
// Never reads the real .env or .magent. Removes only its own checked temporary directory.
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),http=require('http'),assert=require('assert/strict');
const root=path.resolve(__dirname,'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'aios-audit-smoke-'));
let child;
function request(port,url,opts={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request({host:'127.0.0.1',port,path:url,method:opts.body?'POST':'GET',headers:{...(opts.body?{'Content-Type':'application/json'}:{}),...opts.headers}},res=>{
      let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text}));
    });req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('request timed out')));req.end(opts.body?JSON.stringify(opts.body):undefined);
  });
}
(async()=>{
  for(const file of ['server.js','package.json','ecosystem.config.js']) fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  for(const dir of ['lib','tools','.claude','dashboard']) fs.cpSync(path.join(root,dir),path.join(tmp,dir),{recursive:true});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'junction');
  const preload=path.join(tmp,'audit-preload.cjs');
  fs.writeFileSync(preload,`global.fetch=async()=>{throw Error('Audit: outbound networking disabled');};
require('https').request=()=>{throw Error('Audit: outbound HTTPS disabled');};
const h=require('http'),orig=h.request;h.request=function(u,...a){const host=typeof u==='string'?new URL(u).hostname:(u.hostname||u.host);if(host!=='127.0.0.1'&&host!=='localhost')throw Error('Audit: outbound HTTP disabled');return orig.call(this,u,...a);};
const cp=require('child_process');for(const k of ['exec','execSync','execFile','execFileSync','spawn','spawnSync'])cp[k]=()=>{throw Error('Audit: subprocess disabled');};`);
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={NODE_ENV:'production',DEMO_MODE:'true',PORT:String(port),API_TOKEN:'',ADMIN_EMAIL:'audit@example.invalid',
    ADMIN_PASSWORD_HASH:require(path.join(root,'node_modules/bcryptjs')).hashSync('Synthetic-audit-password-123',4),
    AIOS_SECRETS_KEY:'0'.repeat(64)};
  for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  let log='';
  child=cp.spawn(process.execPath,['--require',preload,path.join(tmp,'server.js')],{cwd:tmp,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  const until=Date.now()+15000;let health;
  while(Date.now()<until){try{health=await request(port,'/api/health');if(health.status===200)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  if(!health)throw Error('Boot failed: '+log.slice(-3000));
  assert.equal(health.status,200);console.log('PASS isolated production boot and health endpoint');
  const denied=await request(port,'/api/settings');assert.equal(denied.status,401);console.log('PASS anonymous private HTTP endpoint denied with API_TOKEN absent');
  const WebSocket=require(path.join(root,'node_modules/ws'));
  const anonymous=new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise((resolve,reject)=>{anonymous.once('open',()=>reject(Error('anonymous socket accepted')));anonymous.once('error',e=>{assert.match(e.message,/401/);resolve();});});
  console.log('PASS anonymous production WebSocket rejected');
  const login=await request(port,'/api/auth/login',{body:{email:env.ADMIN_EMAIL,password:'Synthetic-audit-password-123'}});
  assert.equal(login.status,200);const token=JSON.parse(login.text).token;
  const app=await request(port,'/app',{headers:{Cookie:'ai-os-session='+token}});assert.equal(app.status,200);assert.match(app.text,/<!doctype html/i);
  console.log('PASS synthetic admin login and dashboard HTML response');
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`,{headers:{Cookie:'ai-os-session='+token}});
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('revoked socket stayed open')),3000);ws.once('close',()=>{clearTimeout(timer);resolve();});});
  const logout=await request(port,'/api/auth/logout',{body:{},headers:{Cookie:'ai-os-session='+token}});
  assert.equal(logout.status,200);await closed;
  console.log('PASS logout disconnects authenticated WebSocket');

})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,2000).unref();});}
  const rel=path.relative(os.tmpdir(),tmp);
  if(!rel.startsWith('aios-audit-smoke-')||rel.includes(path.sep)||path.isAbsolute(rel))throw Error('Unsafe cleanup path');
  const deps=path.join(tmp,'node_modules');if(fs.existsSync(deps))fs.unlinkSync(deps);
  fs.rmSync(tmp,{recursive:true,force:true});
});
