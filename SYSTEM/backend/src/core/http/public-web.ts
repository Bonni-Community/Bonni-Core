import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

export type PublicWebResult = {url:string;contentType:string;text:string};
export type PublicWebPort = {contractVersion:'bonni.public-web/v1';readPage:(url:string)=>Promise<PublicWebResult>};
export class PublicWebError extends Error {
  constructor(public code:string, message:string){super(message);}
}
const blocked=new BlockList();
for(const [address,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const)blocked.addSubnet(address,bits,'ipv4');
for(const [address,bits] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const)blocked.addSubnet(address,bits,'ipv6');
const global6=new BlockList();global6.addSubnet('2000::',3,'ipv6');
export function isPublicWebAddress(address:string):boolean {
  const family=isIP(address);
  return family===4?!blocked.check(address,'ipv4'):family===6&&global6.check(address,'ipv6')&&!blocked.check(address,'ipv6');
}
export function publicWebUrl(value:unknown):URL {
  let url:URL;try{if(typeof value!=='string'||value.length>2000)throw new Error();url=new URL(value);}catch{throw new PublicWebError('PUBLIC_WEB_URL_INVALID','Eine vollständige http- oder https-Adresse eingeben.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||(url.port&&url.port!==(url.protocol==='https:'?'443':'80')))throw new PublicWebError('PUBLIC_WEB_URL_INVALID','Nur öffentliche Webseiten ohne Zugangsdaten und Sonderports sind erlaubt.');
  const host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!host||host==='localhost'||/\.(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)||(!isIP(host)&&!host.includes('.'))||(isIP(host)&&!isPublicWebAddress(host)))throw new PublicWebError('PUBLIC_WEB_DESTINATION_BLOCKED','Lokale und interne Adressen sind für den Webimport gesperrt.');
  url.hash='';return url;
}
export const PUBLIC_WEB_MAX_BYTES=750_000;
export const PUBLIC_WEB_TIMEOUT_MS=12_000;
/** No cookies, proxy environment, auth headers, scripts, image requests or arbitrary methods.
 * DNS results are checked as a set and pinned to the actual socket to prevent rebinding.
 */
export async function readPublicWebPage(value:string):Promise<PublicWebResult> {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),PUBLIC_WEB_TIMEOUT_MS);
  try{
    let url=publicWebUrl(value);
    for(let hop=0;hop<=4;hop++){
      controller.signal.throwIfAborted();
      const host=url.hostname.replace(/^\[|\]$/g,'');
      const answers=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([
        lookup(host,{all:true,verbatim:true}),
        new Promise<never>((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('ABORTED')),{once:true});}),
      ]);
      if(!answers.length||answers.length>32||answers.some(a=>!isPublicWebAddress(a.address)))throw new PublicWebError('PUBLIC_WEB_DESTINATION_BLOCKED','Die Webseite verweist auf eine gesperrte Netzwerkadresse.');
      const pinned=answers[0]!;
      const response=await new Promise<{status:number;location?:string;contentType:string;text:string}>((resolve,reject)=>{
        const request=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{
          method:'GET',agent:false,...{autoSelectFamily:false},signal:controller.signal,
          lookup:((_name:unknown,_options:unknown,callback:(error:null,address:string,family:number)=>void)=>callback(null,pinned.address,pinned.family)) as any,
          headers:{'User-Agent':'Bonni-PublicWeb/1.0','Accept':'text/html, application/xhtml+xml, text/plain;q=0.8','Accept-Encoding':'identity'},
        },res=>{
          const status=res.statusCode??0,location=res.headers.location,contentType=String(res.headers['content-type']??'').toLowerCase();
          if([301,302,303,307,308].includes(status)){res.destroy();resolve({status,location,contentType,text:''});return;}
          if(status!==200){res.destroy();reject(new PublicWebError('PUBLIC_WEB_HTTP_ERROR',`Die Webseite antwortet mit Status ${status}. Den Rezepttext gegebenenfalls einfügen.`));return;}
          if(!/^(text\/(?:html|plain)|application\/xhtml\+xml)(?:\s*;|$)/.test(contentType)){res.destroy();reject(new PublicWebError('PUBLIC_WEB_CONTENT_TYPE','Die Adresse liefert keine HTML- oder Textseite. PDFs bitte als Datei auswählen.'));return;}
          if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'){res.destroy();reject(new PublicWebError('PUBLIC_WEB_ENCODING','Die Webseite ignoriert das angeforderte Textformat. Bitte den Rezepttext einfügen.'));return;}
          const limit=()=>new PublicWebError('PUBLIC_WEB_TOO_LARGE','Die Webseite ist für den Import zu groß. Bitte nur den Rezepttext einfügen.');
          if(Number(res.headers['content-length']??0)>PUBLIC_WEB_MAX_BYTES){res.destroy();reject(limit());return;}
          let size=0;const chunks:Buffer[]=[];
          res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>PUBLIC_WEB_MAX_BYTES){reject(limit());res.destroy();}else chunks.push(chunk);});
          res.on('error',reject);res.on('aborted',()=>reject(new Error('RESPONSE_ABORTED')));
          res.on('end',()=>{
            try{const charset=/charset\s*=\s*["']?([^;\s"']+)/.exec(contentType)?.[1]??'utf-8';
              resolve({status,contentType,text:new TextDecoder(charset,{fatal:false}).decode(Buffer.concat(chunks))});
            }catch{reject(new PublicWebError('PUBLIC_WEB_ENCODING','Die Zeichenkodierung der Webseite wird nicht unterstützt.'));}
          });
        });
        request.on('error',reject);request.end();
      });
      if(![301,302,303,307,308].includes(response.status))return {url:url.href,contentType:response.contentType,text:response.text};
      if(!response.location||hop===4)throw new PublicWebError('PUBLIC_WEB_REDIRECT_LIMIT','Die Webseite leitet zu oft um. Bitte die endgültige Rezeptadresse verwenden.');
      const next=publicWebUrl(new URL(response.location,url).href);
      if(url.protocol==='https:'&&next.protocol!=='https:')throw new PublicWebError('PUBLIC_WEB_REDIRECT_BLOCKED','Eine unsichere Weiterleitung wurde blockiert.');
      url=next;
    }
    throw new Error('UNREACHABLE');
  }catch(error){
    if(error instanceof PublicWebError)throw error;
    throw new PublicWebError(controller.signal.aborted?'PUBLIC_WEB_TIMEOUT':'PUBLIC_WEB_UNAVAILABLE',controller.signal.aborted?'Die Webseite hat nicht rechtzeitig geantwortet.':'Die Webseite konnte nicht geladen werden. Bitte die Adresse prüfen oder den Rezepttext einfügen.');
  }finally{clearTimeout(timer);}
}
export function createModulePublicWebRuntime():PublicWebPort {
  return Object.freeze({contractVersion:'bonni.public-web/v1' as const,readPage:readPublicWebPage});
}
