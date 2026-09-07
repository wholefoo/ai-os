// Prove archived pipeline runs remain openable through HTTP, using only synthetic state.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const trail = require('../lib/pipeline-trail');
const root = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-history-test-'));
let child, port;
const get = p => new Promise(resolve => {
  const req = http.get({host:'127.0.0.1',port,path:p,headers:{Authorization:'Bearer synthetic-history-token'}}, res => {
    let data = '';
    res.on('data', chunk => { data += chunk; });
    res.on('end', () => { let body; try { body = JSON.parse(data); } catch {} resolve({status:res.statusCode,body}); });
  });
  req.on('error',()=>resolve({status:0}));
  req.setTimeout(2000,()=>req.destroy());
});
(async () => {
  for (const file of ['server.js','package.json','ecosystem.config.js']) fs.copyFileSync(path.join(root,file),path.join(tmp,file));
  for (const dir of ['lib','.claude','dashboard']) fs.cpSync(path.join(root,dir),path.join(tmp,dir),{recursive:true});
  fs.symlinkSync(path.join(root,'node_modules'),path.join(tmp,'node_modules'),'junction');
  const stateRoot = path.join(tmp,'.magent','runs');
  const run = {id:'run-fixture-1',pipeline:'security-sweep',status:'awaiting_approval',startedAt:new Date(0).toISOString(),params:{}};
  trail.writeStage(stateRoot,run,{id:'architecture',agent:'security-auditor',output:'synthetic output'},1);
  trail.writeManifest(stateRoot,run,[]);
  assert(trail.readManifest(stateRoot,run.id));
  const preload = path.join(tmp,'test-preload.cjs');
  fs.writeFileSync(preload, `global.fetch=async()=>{throw Error('Test: external network disabled');};
    for(const protocol of ['http','https'])require(protocol).request=()=>{throw Error('Test: external requests disabled');};
    const cp=require('child_process');for(const method of ['exec','execSync','execFile','execFileSync','spawn','spawnSync'])cp[method]=()=>{throw Error('Test: subprocess disabled');};`);
  const probe = http.createServer();
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  port = probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  const env = {NODE_ENV:'production',DEMO_MODE:'true',PORT:String(port),API_TOKEN:'synthetic-history-token',AIOS_SECRETS_KEY:'0'.repeat(64)};
  for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  let output = '';
  child=cp.spawn(process.execPath,['--require',preload,path.join(tmp,'server.js')],{cwd:tmp,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>{output+=b;}); child.stderr.on('data',b=>{output+=b;});
  let list;
  for(let n=0;n<100;n++) {
    list=await get('/api/pipelines/runs');
    if(list.status===200)break;
    if(child.exitCode!==null)throw Error(output);
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(list.status,200,output);
  assert(list.body.some(item=>item.id===run.id),'The synthetic archived run must actually appear in the list');
  for(const item of list.body) {
    const detail=await get('/api/pipelines/runs/'+encodeURIComponent(item.id));
    assert.equal(detail.status,200,'Listed run must be openable: '+item.id);
  }
  assert.equal((await get('/api/pipelines/runs/run-does-not-exist')).status,404);
  console.log('PASS: archived fixture appears in list, every listed run opens, unknown run returns 404');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,2000).unref();});}
  assert.equal(path.dirname(tmp),os.tmpdir());
  assert(path.basename(tmp).startsWith('aios-history-test-'));
  const deps=path.join(tmp,'node_modules');if(fs.existsSync(deps))fs.unlinkSync(deps);
  fs.rmSync(tmp,{recursive:true,force:true});
});
