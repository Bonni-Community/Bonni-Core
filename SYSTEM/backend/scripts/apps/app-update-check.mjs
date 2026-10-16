// Read-only app discovery. There is deliberately no install adapter here.
export function createAppUpdateChecker({list,settings,now=Date.now,intervalMs=6*60*60*1000}) {
  let pending=null,last=null,lastAttempt=0,attempted=false,timer=null,first=null;
  function check() {
    if(pending)return pending;
    attempted=true;lastAttempt=now();
    pending=Promise.resolve().then(()=>list({online:true})).then(result=>{
      last={...result,checkError:null};return last;
    }).catch(error=>{
      last={...(last||{local:[],remote:[]}),ok:false,checkError:error.code||'APP_CHECK_FAILED',
        failedAt:new Date(now()).toISOString()};
      throw error;
    }).finally(()=>{pending=null;});
    return pending;
  }
  async function tick() {
    if((await settings()).checkAutomatically===false)return;
    if(!attempted||now()-lastAttempt>=intervalMs)await check();
  }
  function start() {
    if(timer)return;
    const run=()=>{void tick().catch(()=>{});};
    first=setTimeout(run,30000);first.unref?.();
    timer=setInterval(run,60000);timer.unref?.();
  }
  function stop() {clearTimeout(first);clearInterval(timer);first=null;timer=null;}
  return {check,tick,start,stop,status:()=>({ok:true,checking:!!pending,result:last,intervalHours:intervalMs/3600000})};
}
