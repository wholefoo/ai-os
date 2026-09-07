'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const noop = () => {};
const rootRequire = require('module').createRequire(path.join(root, 'server.js'));
function context(extra = {}) {
  return vm.createContext({ console, Date, Math, JSON, Set, Map, URL, path, fs, require: rootRequire,
    process: { env: { NODE_ENV: 'production' } }, logActivity: noop, broadcast: noop,
    saveState: () => true, sendNotification: noop, appendLog: noop, ...extra });
}
function load(c, ...names) {
  for (const name of names) {
    const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert(start >= 0, name);
    vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), c);
  }
}
function executor(c, name) {
  const start = source.indexOf(`  '${name}': async`);
  vm.runInContext('var executor = ({' + source.slice(start, source.indexOf('\n  },', start) + 5) + `})['${name}'];`, c);
  return c.executor;
}
function response() { return { code: 200, status(n) { this.code=n; return this; }, json(v) { this.value=v; }, redirect(v) {this.location=v;} }; }
let count = 0;
async function check(label, fn) { if (/^A(13|15|17) /.test(label) && !fs.existsSync(path.join(root, 'commercial/modules/self-improving/index.js'))) { console.log('SKIP commercial module unavailable: '+label); return; } await fn(); count++; console.log('ok : '+label); }
(async () => {
  await check('A01 editor blocks executable config roots and traversal', () => {
    const c=context({ wsWorkspaceDir: () => path.join(root,'synthetic-workspace') }); load(c,'wsResolveFile');
    for (const rel of ['package.json','astro.config.mjs','../.env','src/file:stream']) assert.equal(c.wsResolveFile('test',rel),null);
    assert(c.wsResolveFile('test','src/pages/index.astro'));
  });
  await check('A01 builds fail closed without an isolated worker; artifacts reject links', async () => {
    const old=process.env.AIOS_BUILD_IMAGE; delete process.env.AIOS_BUILD_IMAGE;
    try { await assert.rejects(require('../lib/web-studio/isolated-build').isolatedBuild(root,100),/not configured/); }
    finally { if(old !== undefined) process.env.AIOS_BUILD_IMAGE=old; }
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aios-artifact-test-'));
    try {
      const header=Buffer.alloc(1024); header.write('../escape'); header.write('00000000000',124); header.write('0',156);
      assert.throws(()=>require('../lib/web-studio/isolated-build').extractArtifacts(header,dir),/Unsafe/);
      header.fill(0); header.write('link'); header.write('00000000000',124); header.write('2',156);
      assert.throws(()=>require('../lib/web-studio/isolated-build').extractArtifacts(header,dir),/Unsafe/);
      header.fill(0);header.write('index.html');header.write('00000000002',124);header.write('0',156);header.write('ok',512);
      require('../lib/web-studio/isolated-build').extractArtifacts(header,dir); assert.equal(fs.readFileSync(path.join(dir,'index.html'),'utf8'),'ok');
    } finally { assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true}); }
  });
  await check('A02 production rejects anonymous WebSocket upgrades without API_TOKEN', () => {
    let options;const c=context({ API_TOKEN:null,server:{},WebSocketServer:class{constructor(o){options=o;}},wsCredential:()=>null });load(c,'wsHasQueryToken');
    const start=source.indexOf('const wss = new WebSocketServer(');vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),c);
    let accepted;options.verifyClient({req:{url:'/',headers:{host:'test'}}},v=>accepted=v);assert.equal(accepted,false);
  });
  await check('A01 configured builds use only the constrained worker and validate its output', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aios-worker-test-'));const calls=[];
    const archive=Buffer.alloc(2048);archive.write('index.html');archive.write('00000000002',124);archive.write('0',156);archive.write('ok',512);
    fs.writeFileSync(path.join(dir,'package.json'),'{}');fs.mkdirSync(path.join(dir,'src'));
    const c=context({module:{exports:{}},process:{env:{AIOS_BUILD_IMAGE:'reviewed-image',SECRET_CANARY:'must-not-reach-worker'}},
      require:name=>name==='child_process'?{execFile:(command,args,opts,done)=>{calls.push({command,args,opts});done(null,archive,Buffer.from('built'));}}:require(name)});
    try {
      vm.runInContext(fs.readFileSync(path.join(root,'lib/web-studio/isolated-build.js'),'utf8'),c);
      await c.module.exports.isolatedBuild(dir,1000);assert.equal(fs.readFileSync(path.join(dir,'dist/index.html'),'utf8'),'ok');
      const run=calls[0];assert.equal(run.command,'docker');for(const flag of ['--network=none','--read-only','--user=1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges','--pull=never'])assert(run.args.includes(flag));
      const mounts=run.args.filter(arg=>arg.startsWith('type=bind'));assert.equal(mounts.length,1);assert(mounts[0].endsWith(',readonly'));
      assert(!JSON.stringify(run.args).includes('SECRET_CANARY'));assert(!run.args.some(arg=>arg.includes('docker.sock')));assert.equal(calls[1].args[0],'rm');
    } finally {assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
  });
  await check('A03 read service keys cannot execute A2A work', () => {
    const c=context({serviceKeyFor:()=>({scope:'read'}),serviceKeys:require('../lib/security/service-keys'),resolveSession:()=>{throw Error('must not resolve privileged principal');}});
    load(c,'a2aAuth');const res=response();c.a2aAuth({method:'POST',originalUrl:'/api/a2a',headers:{authorization:'Bearer read'}},res,()=>assert.fail());assert.equal(res.code,403);
  });
  await check('A04 first publish and republish preserve TLS and complete', async () => {
    for (const initial of ['http','tls']) {
      let scheme=initial,done;const wait=new Promise(r=>done=r);const site={id:'s',domain:'site.test'};
      const c=context({webStudioSites:[site],wsWorkspaceDir:()=>'/test',fs:{existsSync:()=>true},deployWithGate:async()=>{},saveState:()=>{done();return true;},
        webStudioHosting:{createVhost:async(d,o)=>{if(o.preserveExisting)return;if(o.tls && scheme==='http')assert(o.allowSchemeChange);scheme=o.tls?'tls':'http';},issueCert:async()=>{}}});
      load(c,'startPublishBackground');c.startPublishBackground(site,site.domain);await wait;assert.equal(site.published,true);assert.equal(scheme,'tls');
    }
  });
  await check('A05 concurrent approval calls execute once and refuse unpersisted claims', async () => {
    let calls=0,release;const wait=new Promise(r=>release=r);
    const c=context({ACTION_EXECUTORS:{test:async()=>{calls++;await wait;return{};}},pendingApprovals:[]});load(c,'executeApprovedAction');
    const a={type:'test',status:'pending'};const first=c.executeApprovedAction(a,{},'human');assert.equal(a.status,'executing');
    assert.equal((await c.executeApprovedAction(a,{},'human')).code,409);release();await first;assert.equal(calls,1);
    c.saveState=()=>false;assert.equal((await c.executeApprovedAction({type:'test',status:'pending'},{},'human')).code,503);assert.equal(calls,1);
  });
  await check('A06 all non-Anthropic branches retain context and untrusted guard', async () => {
    for(const provider of ['openai','gemini','deepseek','grok','perplexity']) {
      let captured;const keys={openai:'openai_api_key',gemini:'gemini_api_key',deepseek:'deepseek_api_key',grok:'xai_api_key',perplexity:'perplexity_api_key'};
      const capture=async(system)=>{captured=system;return{content:'ok'};};
      const c=context({AGENT_MAX_TOKENS_CEILING:8192,getAgentEffort:()=>({tier:'professional',model:'test'}),hardBudgetTrippedPeriod:()=>null,loadAgentPrompt:async()=>'base',settings:{ai:{[keys[provider]]:'synthetic'}},
        fenceUntrusted:()=>({blocks:'DATA',guard:'GUARD'}),acquireAgentSlot:async()=>{},releaseAgentSlot:noop,CONSULTANT_PROVIDER:{test:provider},
        callOpenAI:capture,callGemini:capture,callDeepSeek:capture,callGrok:capture,callPerplexity:capture,costRateFor:()=>({}),promptCache:{priceUsage:()=>({cost:1})},costLedger:[],uuidv4:()=>provider});
      load(c,'executeAgent','attributeUsage');const result=await c.executeAgent('test','task',{context:'CONTEXT',untrusted:{text:'x'}});assert.equal(result.ok,true);assert.match(captured,/CONTEXT/);assert.match(captured,/GUARD/);
      c.attributeUsage(result,{clientId:'owner',skill:'clone-draft'});assert.equal(c.costLedger.length,1);assert.equal(c.costLedger[0].cost,1);assert.equal(c.costLedger[0].clientId,'owner');
    }
  });
  await check('A07 redirect cannot issue a credential or fulfill a purchase', async () => {
    let handler;const c=context({stripe:{},app:{get:(p,h)=>handler=h},fulfillCheckoutSession:()=>assert.fail(),sessions:{set:()=>assert.fail()}});
    const start=source.indexOf("app.get('/api/stripe/success'");vm.runInContext(source.slice(start,source.indexOf('\n});',start)+4),c);
    const res=response();await handler({query:{session_id:'old-paid'}},res);assert.equal(res.location,'/login?checkout=received');
  });
  await check('A08 completed and canceled receipts cannot restore entitlements', () => {
    const receipts=new Set(),canceled=new Set();const history={fulfilled:id=>receipts.has(id),cancelled:id=>canceled.has(id),recordFulfillment:id=>receipts.add(id)};
    const user={email:'client@test',role:'client',passwordHash:'synthetic',plan:'free',managedPurchases:[]};
    const c=context({MAGENT_DIR:'/unused',require:()=>({openBillingHistory:()=>history}),users:[user],findUserByEmail:()=>user,crm:null,generateToken:()=>assert.fail()});load(c,'fulfillCheckoutSession');
    const paid={id:'paid',subscription:'sub',payment_status:'paid',customer_details:{email:user.email},metadata:{account:'client',plan:'business'}};
    c.fulfillCheckoutSession(paid,'webhook');assert.equal(user.plan,'business');assert.equal(user.managedPurchases.length,1);
    user.plan='free';user.managedPurchases=[];c.fulfillCheckoutSession(paid,'webhook');assert.equal(user.plan,'free');assert.equal(user.managedPurchases.length,0);
    canceled.add('sub');c.fulfillCheckoutSession({...paid,id:'out-of-order'},'webhook');assert.equal(user.plan,'free');
  });
  await check('A09 session and paid-route guards use current account entitlements', () => {
    const user={email:'client@test',role:'client',plan:'free'},sessions=new Map([['token',{email:user.email,plan:'business',role:'admin'}]]);
    const c=context({sessions,findUserByEmail:()=>user,orgMembership:{orgKeyFor:u=>u.email}});load(c,'isValidSession');assert.equal(c.isValidSession('token').plan,'free');assert.equal(c.isValidSession('token').role,'client');
    c.resolveSession=()=>c.isValidSession('token');load(c,'requireClientOrAdmin');const res=response();c.requireClientOrAdmin({},res,()=>assert.fail());assert.equal(res.code,403);
    user.disabled=true;assert.equal(c.isValidSession('token'),false);
  });
  await check('A08 fulfillment history and cancellation tombstones survive restart', () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aios-billing-test-'));
    const {openBillingHistory}=require('../lib/billing-history');let store;
    try {const file=path.join(dir,'history.sqlite');store=openBillingHistory(file);store.recordFulfillment('paid');store.recordCancellation('cancelled');store.close();store=openBillingHistory(file);assert(store.fulfilled('paid'));assert(store.cancelled('cancelled'));assert(!store.fulfilled('new'));}
    finally {store?.close();assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
  });
  await check('A10 organization ownership is consistent for created and imported sites', () => {
    const c=context();load(c,'wsIsClient','wsOwns');const session={role:'client',email:'employee',ownerEmail:'owner'};
    assert(c.wsOwns(session,{ownerEmail:session.ownerEmail}));assert(c.wsOwns(session,{ownerEmail:session.email}));assert(!c.wsOwns(session,{ownerEmail:'other'}));
    assert(!source.includes('wsIsClient(req.session) ? req.session.email : null'));
  });
  await check('A11 real executor plus sequence engine advances one step per send', async () => {
    const sequencesLib=require('../lib/sequences');const en={id:'e',email:'test',sequenceId:'s',step:0,status:'active',nextAt:new Date(0).toISOString(),history:[]};
    const seq={id:'s',enabled:true,steps:[1,2,3].map(n=>({subject:String(n),body:String(n),delayHours:0}))};let sends=0;
    const c=context({emailEnrollments:[en],emailSequences:[seq],emailSuppression:[],sequencesLib,emailLib:{send:async()=>{sends++;return{ok:true};}},settings:{email:{}},persistEnrollments:noop,unsubscribeUrlFor:()=>null});
    const run=executor(c,'email.sequence-send');for(let i=0;i<3;i++)await sequencesLib.tick({sequences:[seq],enrollments:[en],suppression:[]},{dispatchSend:async p=>{await run({enrollmentId:'e',subject:p.subject,body:p.body});return{sent:true};}},Date.now()+1000);
    assert.equal(sends,3);assert.equal(en.step,3);assert.equal(en.history.length,3);assert.equal(en.status,'completed');
  });
  await check('A12 invalid UTF8 campaign tags cannot poison ingestion', () => {
    const {parseLine}=require('../lib/analytics/ingest-logs');assert.doesNotThrow(()=>parseLine('203.0.113.1 - - [06/Sep/2026:04:05:01 +0000] "GET /?utm_source=%FF HTTP/1.1" 200 123 "-" "Mozilla/5.0"',{secret:'test'}));
  });
  await check('A13 commercial proposal decisions reject service principals', () => {
    const routes=new Map(),app=Object.fromEntries(['get','post','put','delete'].map(m=>[m,(p,...h)=>routes.set(m+p,h)]));
    const c=context();load(c,'requireHuman');require('../commercial/modules/self-improving').registerRoutes(app,{features:{selfImproving:true},requireAdmin:noop,requireHuman:c.requireHuman});
    for(const key of ['put/api/platform/proposals/:id','post/api/platform/proposals/:id/apply']){const res=response();routes.get(key)[1]({session:{role:'admin',service:true}},res,()=>assert.fail());assert.equal(res.code,403);}
    const res=response();routes.get('post/api/platform/telegram-webhook')[0]({},res);assert.equal(res.code,403);
  });
  await check('A14/A21 domain reservation is exclusive and performs no publication', async () => {
    const sites=[{id:'a'},{id:'b'}];const c=context({webStudioSites:sites,webStudioHosting:{normalizeDomain:d=>d,createVhost:()=>assert.fail()},deployWithGate:()=>assert.fail()});load(c,'wsSetupHosting');
    const results=await Promise.allSettled(sites.map(s=>c.wsSetupHosting(s,'same.test')));assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(sites[0].hostingSetup,undefined);
  });
  await check('A15 production browser and 3D routes report unavailable', () => {
    for(const [moduleName,route,feature] of [['browser-agent','/api/browser/execute','browserAgent'],['creative-studio','/api/3d/scenes','creativeStudio']]) {
      const routes=new Map(),app=Object.fromEntries(['get','post','put','delete'].map(m=>[m,(p,...h)=>routes.set(p,h)]));
      require('../commercial/modules/'+moduleName).registerRoutes(app,{features:{[feature]:true},DEMO_MODE:false,loadState:(k,d)=>d});
      const res=response();routes.get(route).at(-1)({},res);assert.equal(res.code,501);
    }
  });
  await check('A16 private runtime material is inaccessible to repository tools', () => {
    const policy=require('../lib/self-improve/plan-store');for(const rel of ['.magent/provenance/ed25519-priv.pem','.magent/sessions.json','.MAGENT/other-secret','.env'])assert.equal(policy.isReadPathAllowed(rel),false);assert(policy.isReadPathAllowed('package-lock.json'));
  });
  await check('A17 restored paused routines stay stopped with installed node-cron', () => {
    const cron=require('node-cron'),jobs=[];const original=cron.schedule;cron.schedule=(...args)=>{const task=original(...args);jobs.push(task);return task;};
    const routine={id:'r',cron:'0 0 1 1 *',enabled:false,rateLimit:{currentHour:0,maxPerHour:1}};
    try {require('../commercial/modules/hermes-advanced').registerRoutes(Object.fromEntries(['get','post','put','delete'].map(m=>[m,noop])),{features:{hermesAdvanced:true,batchQueue:true},routines:[routine],executeAgent:()=>assert.fail()});assert.equal(routine._job.getStatus(),'stopped');}
    finally {cron.schedule=original;for(const job of jobs)job.destroy();routine._job?.destroy();}
  });
  await check('A18 complete-body deadline and streaming byte ceiling are enforced', async () => {
    const http=require('http'),{boundedFetch}=require('../lib/net/bounded-fetch');
    const server=http.createServer((req,res)=>{res.writeHead(200);res.flushHeaders();if(req.url==='/large')res.end('x'.repeat(2048));else setTimeout(()=>res.end('late'),100);});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
    try {await assert.rejects(boundedFetch(base,{},30),e=>e.timedOut===true);await assert.rejects(boundedFetch(base+'/large',{},1000,1024),/exceeds/);}
    finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
  });
  await check('A20 revoked and changed principals cannot retain administrative pushes', () => {
    let sent=0,closed=0;const sessions=new Map([['token',{email:'operator'}]]);const socket={authToken:'token',authRequest:{},readyState:1,role:'admin',close:()=>closed++,send:()=>sent++};
    const c=context({API_TOKEN:null,_sessionMap:sessions,_persistSessions:noop,wss:{clients:new Set([socket])},wsCredential:()=>sessions.has('token')?{session:{role:'admin',email:'operator'}}:null,maybeDispatchOnEvent:noop});
    load(c,'closeSessionSockets','revokeSessionsFor','refreshSocketPrincipal','broadcast');c.revokeSessionsFor('operator');c.broadcast({event:'private'});assert(closed>0);assert.equal(sent,0);
  });
  await check('A19 actual clone executor attributes the provider row without charging twice', async () => {
    const c=context({costLedger:[{id:'usage',cost:1}],executeAgent:async()=>({ok:true,usageId:'usage',cost:1}),
      cloneDispatches:[{id:'dispatch',cloneId:'clone',clientId:'owner',status:'pending'}],businessClones:[{id:'clone',clientId:'owner'}],
      cloneEffective:()=>({}),cloneCompanyBoundaries:()=>({}),cloneDispatchLib:{screenDispatch:()=>({allow:true}),buildDispatchPrompt:()=>({task:'test'}),recordResult:noop},saveCloneDispatches:noop});
    load(c,'attributeUsage');await executor(c,'clone.dispatch-agent')({dispatchId:'dispatch'});assert.equal(c.costLedger.length,1);assert.equal(c.costLedger[0].clientId,'owner');assert.equal(c.costLedger[0].cost,1);
  });
  await check('A22/A23 microphone policy and container bind are configured', () => {
    assert.match(fs.readFileSync(path.join(root,'deploy/nginx.conf'),'utf8'),/microphone=\(self\)/);
    assert.match(fs.readFileSync(path.join(root,'docker-compose.yml'),'utf8'),/HOST=0.0.0.0/);
    assert.match(source,/const HOST = process.env.HOST/);
  });
  console.log(`ALL TESTS PASSED (${count} audit regression groups; deployment isolation tested separately)`);
})().catch(e=>{console.error(e);process.exitCode=1;});
