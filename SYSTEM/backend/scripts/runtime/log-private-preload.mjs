// Preserve the installed runtime and its signed/validated protocols. Only the
// detached diagnostic descriptor is mediated; CLI JSON, IPC and env stay intact.
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {cleanKnownDiagnosticTree} from './log-privacy-files.mjs';
const guard=Symbol.for('bonni.log.privacy.bootstrap.v1');
if(!globalThis[guard]){
 globalThis[guard]=true;
 const worker=process.argv.includes('__worker'),preload=import.meta.url;
 if(!worker&&/development-test-runtime-cli\.mjs$/.test(process.argv[1]||'')&&process.argv[2]==='start'){
  const index=process.argv.indexOf('--product-root');
  if(index<0||!process.argv[index+1])throw new Error('CORE_LOG_PRIVACY_FAILED');
  cleanKnownDiagnosticTree(process.argv[index+1]);
 }
 const spawn=childProcess.spawn;
 childProcess.spawn=function(command,args,options){
  let candidate=false;
  if(typeof command==='string'&&Array.isArray(args)&&path.resolve(command)===path.resolve(process.execPath)){
   const index=args.findIndex(value=>typeof value==='string'&&/(?:^|[/\\])development-test-runtime-cli\.mjs$/.test(value));
   const isWorker=index>=0&&args[index+1]==='__worker';
   candidate=worker&&args.some(value=>typeof value==='string'&&/(?:^|[/\\])(?:run-server|server|index)\.js$/.test(value));
   if(isWorker){
    const protectedArgs=args.some(value=>typeof value==='string'&&/[/\\]log-private-preload\.mjs$/.test(value))?args:['--import',preload,...args];
    args=[fileURLToPath(new URL('./log-private-worker.mjs',import.meta.url)),...protectedArgs];
   }else if(candidate){
    const stdio=Array.isArray(options?.stdio)?[...options.stdio]:['ignore','inherit','inherit','ipc'];
    if(stdio[1]==='inherit'||stdio[1]===1)stdio[1]='pipe';
    if(stdio[2]==='inherit'||stdio[2]===2)stdio[2]='pipe';
    options={...options,stdio};
   }
  }
  const child=Reflect.apply(spawn,this,[command,args,options]);
  if(candidate){
   child.stdout?.on('data',value=>process.stdout.write(value));
   child.stderr?.on('data',value=>process.stderr.write(value));
  }
  return child;
 };
 syncBuiltinESMExports();
}
