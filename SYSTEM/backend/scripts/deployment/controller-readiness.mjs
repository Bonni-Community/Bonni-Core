// A live, container-local socket binds readiness to this controller lifetime.
// Unlike persisted installation state, a crashed process cannot answer it.
import net from 'node:net';
import fs from 'node:fs/promises';
export const CONTROLLER_READY_SOCKET='/tmp/bonni-controller-ready.sock';

export function createControllerStartupState(){
  let ready=false,closed=false;
  return {
    isReady:()=>ready&&!closed,
    async start(work,isStopping=()=>false){
      ready=false;await work();
      if(!closed&&!isStopping())ready=true;
    },
    stop(){ready=false;},
    close(){ready=false;closed=true;}
  };
}

export async function createControllerReadiness(socketPath=CONTROLLER_READY_SOCKET) {
  // Called only after the deployment entrypoint acquired the instance flock.
  const old=await fs.lstat(socketPath).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
  if(old){
    if(!old.isSocket()||old.isSymbolicLink())throw Error('DEPLOYMENT_READINESS_PATH_UNSAFE');
    await fs.unlink(socketPath); // A Unix socket can remain after SIGKILL.
  }
  const startup=createControllerStartupState();let closed=false;
  const server=net.createServer(socket=>{
    socket.on('error',()=>{});
    socket.setTimeout(1000,()=>socket.destroy());
    socket.end(startup.isReady()?'ready\n':'starting\n');
  });
  server.maxConnections=8;
  server.on('error',()=>startup.stop());
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(socketPath,()=>{server.removeListener('error',reject);resolve();});
  });
  try{await fs.chmod(socketPath,0o600);}
  catch(error){await new Promise(resolve=>server.close(resolve));throw error;}
  return {
    start:startup.start,
    stop:startup.stop,
    async close(){
      startup.close();if(closed)return;closed=true;
      await new Promise(resolve=>server.close(resolve));
    }
  };
}

export function controllerStartupReady(socketPath=CONTROLLER_READY_SOCKET,timeoutMs=2000) {
  return new Promise(resolve=>{
    let finished=false,text='';
    const socket=net.createConnection(socketPath);
    const finish=value=>{
      if(finished)return;finished=true;clearTimeout(timer);socket.destroy();resolve(value);
    };
    const timer=setTimeout(()=>finish(false),timeoutMs);
    socket.setEncoding('utf8');
    socket.on('data',chunk=>{text+=chunk;if(text.length>32)finish(false);});
    socket.on('end',()=>finish(text==='ready\n'));
    socket.on('error',()=>finish(false));
    socket.on('close',()=>finish(false));
  });
}
