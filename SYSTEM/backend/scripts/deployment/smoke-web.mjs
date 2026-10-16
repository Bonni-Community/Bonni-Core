import path from 'node:path';
import {pathToFileURL} from 'node:url';

// Only fixed diagnostic fields are logged, never response bodies or credentials.
export async function probeWeb({timeoutMs=5000,fetchImpl=fetch}={}) {
  let status=null;
  try {
    const response=await fetchImpl('http://127.0.0.1:4000/',{signal:AbortSignal.timeout(timeoutMs)});
    status=response.status;
    if(!response.ok){await response.body?.cancel();return {ready:false,reason:'HTTP_STATUS',status};}
    const html=await response.text();
    return html.includes('<html')?{ready:true,reason:'READY',status}:{ready:false,reason:'HTML_MISSING',status};
  }catch(error){
    return {ready:false,reason:['TimeoutError','AbortError'].includes(error?.name)?'REQUEST_TIMEOUT':'NETWORK_ERROR',status};
  }
}

export async function waitForWeb({phase,timeoutMs=120000,intervalMs=2000,
  probe=ms=>probeWeb({timeoutMs:ms}),now=()=>performance.now(),
  delay=ms=>new Promise(resolve=>setTimeout(resolve,ms)),log=console.log}={}) {
  if(!['initial','restart','recovery'].includes(phase)
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000
    ||!Number.isSafeInteger(intervalMs)||intervalMs<1)throw Error('SMOKE_WEB_OPTIONS_INVALID');
  const started=now(),deadline=started+timeoutMs;
  let attempts=0,last={reason:'NOT_CHECKED',status:null},previous='';
  while(now()<deadline){
    const budget=Math.max(1,Math.min(5000,Math.ceil(deadline-now())));
    const result=await probe(budget);attempts++;
    last=result;
    const key=result.reason+':'+result.status;
    if(result.ready||key!==previous){
      log('Web-Prüfung: '+JSON.stringify({phase,attempt:attempts,reason:result.reason,status:result.status,elapsedMs:Math.round(now()-started)}));
      previous=key;
    }
    if(result.ready)return;
    const remaining=deadline-now();
    if(remaining>0)await delay(Math.min(intervalMs,remaining));
  }
  throw Error(`SMOKE_WEB_NOT_READY: phase=${phase}; reason=${last.reason}; status=${last.status??'none'}; attempts=${attempts}`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  waitForWeb({phase:process.argv[2]}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
