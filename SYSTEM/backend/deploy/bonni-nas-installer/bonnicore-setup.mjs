import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

export const validPath = value => typeof value === 'string' && value.length <= 512
  && /^(\/[a-zA-Z0-9._-]+){2,}$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
export const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 512
  && /^[a-zA-Z0-9._@%+!:=-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value)
  && /[0-9]/.test(value) && /[-._@%+!:=]/.test(value)
  && !/BITTE_|change.?me|replace|example|default|password|passwort|admin|postgres|placeholder/i.test(value);

export async function startWizard({nas,arch,suggestion,version,port=4180, lifetime=600_000, onAccepted=()=>{}, onExpired=()=>{}}) {
  if (!['Unraid','Synology DSM','QNAP QTS / QuTS hero','TrueNAS','Linux (NAS-Software nicht erkannt)'].includes(nas)
    || !['AMD64','ARM64','ARMv7'].includes(arch) || (suggestion!=='' && !validPath(suggestion))
    || typeof version!=='string' || !/^\d{1,8}\.\d{1,8}\.\d{1,8}(?:[+-][a-z])?$/.test(version)) throw Error('SETUP_CONFIG_INVALID');
  const html=await readFile(new URL('./bonnicore-setup.html',import.meta.url),'utf8');
  const access=randomBytes(32).toString('hex');
  const inline=id=>`'sha256-${createHash('sha256').update(html.match(new RegExp(`<${id}>([\\s\\S]*?)</${id}>`))[1]).digest('base64')}'`;
  const common={
    'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
    'Connection':'close','X-Frame-Options':'DENY',
    'Content-Security-Policy':`default-src 'none'; script-src ${inline('script')}; style-src ${inline('style')}; img-src data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'`,
  };
  let active=true, timeout;
  const json=(res,status,value)=>{res.writeHead(status,{...common,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const server=createServer({requestTimeout:8_000,headersTimeout:8_000,keepAliveTimeout:1_000,maxHeaderSize:8192},async(req,res)=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${server.address()?.port}`){json(res,403,{ok:false});return;}
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{...common,'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
    if(req.url!=='/api/setup'||!['GET','POST'].includes(req.method)){json(res,404,{ok:false});return;}
    const sent=req.headers['x-bonni-setup'];
    if(!active||typeof sent!=='string'||!/^[a-f0-9]{64}$/.test(sent)||!timingSafeEqual(Buffer.from(sent),Buffer.from(access))){json(res,403,{ok:false});return;}
    if(req.method==='GET'){json(res,200,{nas,arch,suggestion,version});return;}
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['content-type']!=='application/json') {json(res,403,{ok:false});return;}
    try{
      let body='',bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>4096){json(res,413,{ok:false});return;}body+=chunk.toString('utf8');}
      const data=JSON.parse(body);
      if(!data||Object.keys(data).sort().join(',')!=='confirm,folder,password'||!validPath(data.folder)||!validPassword(data.password)||data.password!==data.confirm){json(res,400,{ok:false});return;}
      if(!active){json(res,409,{ok:false});return;}
      active=false;clearTimeout(timeout);
      res.writeHead(200,{...common,'Content-Type':'application/json; charset=utf-8'});
      res.end('{"ok":true}',()=>{server.close();onAccepted({folder:data.folder,password:data.password});});
    } catch {if(!res.headersSent)json(res,400,{ok:false});}
  });
  server.maxConnections=12;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  timeout=setTimeout(()=>{active=false;server.close();server.closeAllConnections();onExpired();},lifetime);
  const close=()=>{active=false;clearTimeout(timeout);server.close();server.closeAllConnections();};
  return {url:`http://127.0.0.1:${server.address().port}/#${access}`,close};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [nas,arch,suggestion,version]=process.argv.slice(2);
  try{
    const wizard=await startWizard({nas,arch,suggestion,version,
      onAccepted:({folder,password})=>{process.stdout.write(`${folder}\t${password}\n`);},
      onExpired:()=>{process.stderr.write('[Bonni] Der Setup-Link ist abgelaufen.\n');process.exitCode=1;},
    });
    process.stderr.write(`[Bonni] Einrichtungslink (privat): ${wizard.url}\n`);
  }catch{process.stderr.write('[Bonni] Browser-Assistent konnte nicht gestartet werden (Port 4180 oder Paketdateien prüfen).\n');process.exitCode=1;}
}
