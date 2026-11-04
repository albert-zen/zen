/** Harmless owned POSIX children only. No product app or native measurement. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stopOwnedProcess,delay} from './short-run-common.mjs';

// Minimal Linux containers may not reap orphans. This test-only supervisor
// adopts and reaps the sleep child, matching launchd's role on the Mac runner.
if(process.platform==='linux'&&process.env.OWNED_PG_TEST_REAPER!=='1'){
 const supervisor=String.raw`import ctypes,os,subprocess,sys
if ctypes.CDLL(None).prctl(36,1,0,0,0)!=0: raise RuntimeError('Cannot enable test subreaper')
p=subprocess.Popen(sys.argv[1:])
while True:
 try: pid,status=os.waitpid(-1,0)
 except InterruptedError: continue
 if pid==p.pid: sys.exit(os.waitstatus_to_exitcode(status))
`;
 execFileSync('python3',['-c',supervisor,process.execPath,fileURLToPath(import.meta.url)],{stdio:'inherit',env:{...process.env,OWNED_PG_TEST_REAPER:'1'}});
 process.exit(0);
}
assert.notEqual(process.platform,'win32');
const alive=pid=>{try{process.kill(-pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const start=command=>{const child=spawn('/bin/sh',['-c',command],{detached:true,stdio:'ignore'});const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});return {child,closed};};
const owned=[];
try{
 const orphan=start('sleep 60 >/dev/null 2>&1 & exit 0');owned.push(orphan);
 assert.deepEqual(await orphan.closed,{code:0,signal:null});
 assert.equal(orphan.child.exitCode,0);
 assert.equal(alive(orphan.child.pid),true,'Negative fixture requires a live group after leader exit');
 await assert.rejects(stopOwnedProcess(orphan.child,orphan.closed,null,null,null,{normalCloseOnly:true}),/Normal close left owned POSIX group alive/);
 assert.equal(alive(orphan.child.pid),true,'Rejected normal close must not disguise forced cleanup as normal exit');
 const cleaned=await stopOwnedProcess(orphan.child,orphan.closed,null,null,null);
 assert.equal(cleaned.processGroupDead,true);assert.deepEqual(cleaned.cleanupSignals,['SIGTERM']);
 assert.equal(alive(orphan.child.pid),false,'Cleanup must confirm whole group absent, not just leader closed');
 console.log('PASS: leader exit 0 + live child rejects normal close; bounded cleanup confirms owned group absent.');

 const normal=start('exit 0');owned.push(normal);assert.deepEqual(await normal.closed,{code:0,signal:null});
 const confirmed=await stopOwnedProcess(normal.child,normal.closed,null,null,null,{normalCloseOnly:true});
 assert.deepEqual(confirmed,{processGroupDead:true,cleanupSignals:[]});
 console.log('PASS: normal close succeeds only with an already absent owned group.');
}finally{
 for(const {child,closed} of owned){if(alive(child.pid)){try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}const end=Date.now()+5000;while(alive(child.pid)&&Date.now()<end)await delay(25);assert.equal(alive(child.pid),false,'Test cleanup failed');}await closed;}
}
