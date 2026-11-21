// Owns the diagnostic descriptor. No application code runs in this collector.
// Native fatal output and fs.writeSync(1/2) in a child still pass through pipes.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
let child;
try {
 const {createPrivateErrorStream}=await import('./log-private-stream.mjs');
 const started=Date.now();let resetAt=started;
 const sink=createPrivateErrorStream(value=>{
  const state=fs.fstatSync(1);
  if(state.isFile()&&(state.size>8*1024*1024||Date.now()-resetAt>3*60*60*1000)){fs.ftruncateSync(1,0);resetAt=Date.now();}
  process.stdout.write(value);
 });
 const out=sink.channel(),err=sink.channel();
 child=spawn(process.execPath,process.argv.slice(2),{env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
 child.stdout.on('data',chunk=>out.write(chunk));child.stderr.on('data',chunk=>err.write(chunk));
 child.once('error',()=>{process.stderr.write('CORE_LOG_PRIVACY_FAILED\n');process.exitCode=1;});
 child.once('close',(code,signal)=>{out.end();err.end();process.exitCode=code===null?1:code;});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{try{child.kill(signal);}catch{}});
}catch{process.stderr.write('CORE_LOG_PRIVACY_FAILED\n');process.exitCode=1;try{child?.kill();}catch{}}
