import http from 'node:http';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
// Same active/emergency contract as the development nginx topology. Baked into
// the Core image so ARMv7/offline installation needs no additional base image.
const sensitive=/^\/api\/(?:security\/(?:2fa|account-recovery)(?:\/|$)|(?:identity\/)?auth(?:\/|$)|apps\/kontorapp(?:\/|$)|modules\/app(?:\.|-)kontorapp(?:\/|$)|system\/(?:integrations\/jitsi|system)(?:\/|$)|(?:[^/?]+\/)*(?:user|users|members|accounts|password|privacy|dsgvo|protected|private|grant|recovery)(?:\/|$))/i;
function cleanHeaders(headers){
  const result={...headers};
  for(const key of [...String(headers.connection||'').split(',').map(v=>v.trim().toLowerCase()),'connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade'])delete result[key];
  return result;
}
function forwarded(req){
  const headers=cleanHeaders(req.headers);
  delete headers.forwarded;
  for(const key of Object.keys(headers))if(key.startsWith('x-forwarded-'))delete headers[key];
  return {...headers,'x-real-ip':req.socket.remoteAddress,'x-forwarded-for':req.socket.remoteAddress,'x-forwarded-proto':'http','x-runtime-proxy':'true'};
}
export function createRuntimeProxy({active={hostname:'backend-active',port:4000},emergency={hostname:'backend-emergency',port:4000},timeout=60000,connectTimeout=2000}={}){
  const server=http.createServer((req,res)=>{
    if(!req.url?.startsWith('/')){res.writeHead(400);res.end();return;}
    let pathname;try{pathname=decodeURIComponent(new URL(req.url,'http://proxy').pathname);}catch{res.writeHead(400);res.end();return;}
    if(pathname==='/runtime-proxy/status'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
      res.end(JSON.stringify({ok:true,mode:'runtime-proxy',active:active.hostname+':'+active.port,emergency:emergency.hostname+':'+emergency.port}));return;
    }
    const health=pathname==='/runtime-proxy/active-health'||pathname==='/runtime-proxy/emergency-health';
    const canFallback=!health&&['GET','HEAD'].includes(req.method)&&!sensitive.test(pathname)
      && !req.headers.authorization&&!req.headers.cookie&&!req.headers['transfer-encoding']&&Number(req.headers['content-length']||0)===0;
    let upstream,received,finished=false;
    const fail=()=>{if(finished)return;finished=true;if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','cache-control':'no-store'});res.end('{"error":"BACKEND_UNAVAILABLE"}');}else res.destroy();};
    const send=(target,fallback=false)=>{
      let handedOff=false;
      const retry=()=>{if(handedOff||finished||res.destroyed)return;handedOff=true;if(canFallback&&!fallback){upstream.destroy();send(emergency,true);}else fail();};
      upstream=http.request({...target,path:health?'/api/health/ready':req.url,method:req.method,headers:forwarded(req)},response=>{
        if(handedOff){response.destroy();return;}
        if(canFallback&&!fallback&&[502,503,504].includes(response.statusCode)){response.destroy();retry();return;}
        handedOff=true;received=response;
        res.writeHead(response.statusCode,{...cleanHeaders(response.headers),'x-runtime-proxy':'true','x-runtime-backend':target.hostname+':'+target.port,'x-runtime-upstream-status':String(response.statusCode)});
        response.on('error',()=>res.destroy());response.pipe(res);
      });
      const request=upstream;
      upstream.once('socket',socket=>{if(!socket.connecting)return;const timer=setTimeout(()=>request.destroy(Error('PROXY_CONNECT_TIMEOUT')),connectTimeout);socket.once('connect',()=>clearTimeout(timer));socket.once('close',()=>clearTimeout(timer));});
      upstream.setTimeout(timeout,()=>request.destroy(Error('PROXY_TIMEOUT')));
      upstream.on('error',retry);
      if(canFallback||fallback||req.method==='HEAD'){upstream.end();req.resume();}else req.pipe(upstream);
    };
    req.on('aborted',()=>{finished=true;upstream?.destroy();received?.destroy();});
    res.on('close',()=>{finished=true;upstream?.destroy();received?.destroy();});
    send(pathname==='/runtime-proxy/emergency-health'?emergency:active);
  });
  // Upgrade traffic is never replayed to Emergency.
  server.on('upgrade',(req,client,head)=>{
    if(!req.url?.startsWith('/')||String(req.headers.upgrade).toLowerCase()!=='websocket'){client.destroy();return;}
    const upstream=http.request({...active,path:req.url,method:req.method,headers:{...forwarded(req),connection:'Upgrade',upgrade:'websocket'}});
    const timer=setTimeout(()=>{upstream.destroy();client.destroy();},connectTimeout);
    upstream.on('upgrade',(response,socket,rest)=>{
      clearTimeout(timer);
      const headers={...cleanHeaders(response.headers),connection:'Upgrade',upgrade:'websocket'};
      client.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(headers).map(([k,v])=>k+': '+v).join('\r\n')+'\r\n\r\n');
      if(rest.length)client.write(rest);if(head.length)socket.write(head);
      client.on('error',()=>socket.destroy());socket.on('error',()=>client.destroy());
      client.on('close',()=>socket.destroy());socket.on('close',()=>client.destroy());
      client.on('end',()=>socket.end());socket.on('end',()=>client.end());
      client.pipe(socket).pipe(client);
    });
    upstream.on('response',response=>{response.destroy();client.destroy();});
    upstream.on('error',()=>{clearTimeout(timer);client.destroy();});
    client.on('error',()=>upstream.destroy());client.on('close',()=>{clearTimeout(timer);upstream.destroy();});
    upstream.end();
  });
  return server;
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const env=process.env;
  const server=createRuntimeProxy({active:{hostname:env.ACTIVE_BACKEND||'backend-active',port:Number(env.ACTIVE_BACKEND_PORT||4000)},emergency:{hostname:env.EMERGENCY_BACKEND||'backend-emergency',port:Number(env.EMERGENCY_BACKEND_PORT||4000)}});
  server.listen(8080,'0.0.0.0');
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
