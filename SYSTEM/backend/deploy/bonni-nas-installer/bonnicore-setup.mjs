import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual, createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline';

export const validPath = value => typeof value === 'string' && value.length <= 512
  && /^(\/[a-zA-Z0-9._-]+){2,}$/.test(value) && !value.split('/').some(part => part === '.' || part === '..');
export const validPassword = value => typeof value === 'string' && value.length >= 8 && value.length <= 512
  && /^[a-zA-Z0-9._@%+!:=-]+$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value)
  && /[0-9]/.test(value) && /[-._@%+!:=]/.test(value)
  && !/BITTE_|change.?me|replace|example|default|password|passwort|admin|postgres|placeholder/i.test(value);

const issues = Object.freeze({
  'not-installed':'An diesem Speicherort wurde keine bestehende Bonni-Installation erkannt. Wenn Bonni schon installiert ist, gib beim Start des Assistenten mit --ordner den bisherigen Datenpfad an.',
  'data-path':'Der ursprüngliche Bonni-Datenordner fehlt oder ist nicht sicher zugänglich. Prüfe den bisherigen Pfad und den appdata-Speicher.',
  'invalid-config':'Die gespeicherte Bonni-Konfiguration oder der Installationsbeleg fehlt, ist nicht lesbar oder passt nicht zur Installation. Prüfe den bisherigen Datenpfad und die Installation, ohne Konfigurationsdateien zu teilen.',
  'wrong-package':'Das Offline-Paket oder ein lokales Image passt nicht zur vorhandenen Installation. Nutze das ursprüngliche Offline-ZIP dieser Installation.',
  database:'Die ursprüngliche Bonni-Datenbank fehlt oder konnte dieser Installation nicht sicher zugeordnet werden. Prüfe das vorhandene Docker-Datenbankvolume. Es wird keine neue Datenbank angelegt.',
  'folder-in-use':'Ein Container verwendet den Bonni-Datenordner noch oder der Bonni-Haupteintrag existiert bereits. Prüfe die betreffenden Einträge in der Docker-Übersicht. Es wird kein Container automatisch entfernt.',
  'folder-mounted':'Im Bonni-Datenordner ist noch ein anderer Speicher eingebunden. Prüfe diese Einbindung am NAS. Der Ordner wird nicht geleert.',
  'existing-config':'Für diesen Ordner gibt es bereits eine Bonni-Konfiguration. Wähle die Reparatur oder einen anderen, leeren Zielordner.',
  'folder-not-empty':'Der Zielordner ist nicht leer. Wähle einen leeren Ordner oder prüfe, ob hier schon Bonni installiert ist.',
  'disk-space':'Auf dem Docker-Speicher ist zu wenig Platz. Prüfe den Docker-Speicher auf dem NAS; unter Unraid findest du ihn unter Einstellungen → Docker.',
  'disk-unreadable':'Bonni kann den freien Docker-Speicher nicht sicher bestimmen. Prüfe unter Einstellungen → Docker die Ablage und den Zustand des Docker-Speichers. Es werden keine Images geladen.',
  'docker-off':'Docker ist gestoppt oder nicht erreichbar. Öffne Einstellungen → Docker, aktiviere den Docker-Dienst und klicke hier auf „Erneut prüfen“.',
  'docker-missing':'Der Docker-Befehl ist auf dem NAS nicht verfügbar. Prüfe Einstellungen → Docker und wiederhole die Prüfung.',
  'compose-missing':'Docker läuft, aber Docker Compose v2 wurde nicht gefunden. Prüfe die Unraid-Docker-Einrichtung und wiederhole die Prüfung.',
  'port-used':'Einer der Bonni-Ports (4000, 4001 oder 4199) ist bereits belegt. Prüfe in der Docker-Übersicht, welcher Dienst ihn verwendet.',
  'image-import':'Das Datenbank-Image konnte nicht importiert werden. Prüfe den freien Docker-Speicher und ob das Offline-ZIP vollständig entpackt wurde.',
  'start-failed':'Der Bonni-Hauptcontainer konnte nicht gestartet oder geprüft werden. Prüfe in der Docker-Übersicht den Status von Bonni Core und die Meldung im NAS-Terminal.',
  'start-timeout':'Die Weboberfläche wurde nicht rechtzeitig bereit. Prüfe, ob Bonni Core in der Docker-Übersicht noch startet. Starte keine zweite Neuinstallation.',
  unknown:'Bonni konnte den Vorgang nicht sicher abschließen. Den genauen Grund findest du im NAS-Terminal. Teile keine Konfigurationsdateien oder Zugangsdaten.',
});
const issueText = code => Object.hasOwn(issues,code) ? issues[code] : issues.unknown;
const progressing = new Set(['starting','images','services','webui']);

export async function startWizard({nas,arch,suggestion,version,menu=null,hostSetup=false,port=4180, lifetime=600_000, onAccepted=()=>{}, onRepair=()=>{}, onRecheck=()=>{}, onExpired=()=>{}}) {
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
  const validMenu=value=>value&&['menu','repair'].includes(value.mode)&&(!value.deletePath||validPath(value.deletePath))
    && typeof value.repair==='boolean'&&[value.repairIssue,value.deleteIssue].every(code=>!code||Object.hasOwn(issues,code));
  if ((menu&&!validMenu(menu))||(hostSetup&&(!menu||nas!=='Unraid'))) throw Error('SETUP_MENU_INVALID');
  const menuToInfo=value=>value?{mode:value.mode,repair:value.repair,deletePath:value.deletePath,
    ...(value.repairIssue&&!value.repair?{repairHint:issueText(value.repairIssue)}:{}),
    ...(value.deleteIssue&&!value.deletePath?{deleteHint:issueText(value.deleteIssue)}:{})}:null;
  let activeMenu=menu, menuInfo=menuToInfo(menu), preflight='checking', preflightHint='';
  let active=true, timeout, submitted=false, phase='waiting', failure=null;
  const json=(res,status,value)=>{res.writeHead(status,{...common,'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  const server=createServer({requestTimeout:8_000,headersTimeout:8_000,keepAliveTimeout:1_000,maxHeaderSize:8192},async(req,res)=>{
    if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${server.address()?.port}`){json(res,403,{ok:false});return;}
    if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{...common,'Content-Type':'text/html; charset=utf-8'});res.end(html);return;}
    const statusRoute=menu && req.url==='/api/setup/status' && req.method==='GET';
    if(!statusRoute && (req.url!=='/api/setup'||!['GET','POST'].includes(req.method))){json(res,404,{ok:false});return;}
    const sent=req.headers['x-bonni-setup'];
    if(!active||typeof sent!=='string'||!/^[a-f0-9]{64}$/.test(sent)||!timingSafeEqual(Buffer.from(sent),Buffer.from(access))){json(res,403,{ok:false});return;}
    if(statusRoute){json(res,200,{phase,...(failure?{message:failure}:{})});return;}
    if(req.method==='GET'){json(res,200,{nas,arch,suggestion,version,...(menu?{menu:menuInfo}:{}),
      ...(hostSetup?{preflight,...(preflightHint?{preflightHint}:{})}:{})});return;}
    if(req.headers.origin!==`http://${req.headers.host}`||req.headers['content-type']!=='application/json') {json(res,403,{ok:false});return;}
    try{
      let body='',bytes=0;
      for await(const chunk of req){bytes+=chunk.length;if(bytes>4096){json(res,413,{ok:false});return;}body+=chunk.toString('utf8');}
      const data=JSON.parse(body);
      if(menu){
        if(!data||typeof data!=='object'||submitted){json(res,409,{ok:false});return;}
        const keys=Object.keys(data).sort().join(',');
        if(hostSetup&&keys==='action'&&data.action==='recheck'&&preflight==='blocked'){
          preflight='checking';preflightHint='';
          res.writeHead(200,{...common,'Content-Type':'application/json; charset=utf-8'});
          res.end('{"ok":true}',onRecheck);return;
        }
        if(hostSetup&&preflight!=='ready'){json(res,409,{ok:false});return;}
        const repair=keys==='action'&&data.action==='repair'&&activeMenu.repair;
        const create=activeMenu.mode==='menu'&&keys==='action,confirm,deleteExisting,folder,password'&&data.action==='install'
          && validPath(data.folder)&&validPassword(data.password)&&data.password===data.confirm
          && typeof data.deleteExisting==='boolean'&&data.deleteExisting===Boolean(activeMenu.deletePath&&data.folder===activeMenu.deletePath)
          && !(menuInfo.deleteHint&&data.folder===suggestion);
        if(!repair&&!create){json(res,400,{ok:false});return;}
        submitted=true;phase='starting';clearTimeout(timeout);
        res.writeHead(200,{...common,'Content-Type':'application/json; charset=utf-8'});
        res.end('{"ok":true}',()=>{if(repair)onRepair();else onAccepted({folder:data.folder,password:data.password,deleteExisting:data.deleteExisting});});
        return;
      }
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
  const setPhase=value=>{
    if(!submitted||!progressing.has(phase))return false;
    if(progressing.has(value)){phase=value;return false;}
    if(value==='ready'){phase=value;return true;}
    if(typeof value==='string'&&/^failed:[a-z-]{1,32}$/.test(value)){phase='failed';failure=issueText(value.slice(7));return true;}
    return false;
  };
  const setPreflight=line=>{
    if(!hostSetup||submitted||preflight!=='checking'||typeof line!=='string')return;
    const [message,result,repair,deletePath,repairIssue,deleteIssue,...extra]=line.split('\t');
    if(message!=='preflight'||extra.length)return;
    if(result==='ready'&&['yes','no'].includes(repair)&&typeof deleteIssue==='string'){
      const next={mode:menu.mode,repair:repair==='yes',deletePath,repairIssue,deleteIssue};
      if(!validMenu(next)|| (deletePath&&deletePath!==suggestion))return;
      activeMenu=next;menuInfo=menuToInfo(next);preflight='ready';preflightHint='';return;
    }
    if(repair===undefined&&['docker-off','docker-missing','compose-missing','disk-space','disk-unreadable','unknown'].includes(result)){
      preflight='blocked';preflightHint=issueText(result);
    }
  };
  return {url:`http://127.0.0.1:${server.address().port}/#${access}`,close,setPhase,setPreflight};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [nas,arch,suggestion,version,mode,canRepair,deletePath='',repairIssue='',deleteIssue='',hostSetup='false']=process.argv.slice(2);
  try{
    const menu=mode?{mode,repair:canRepair==='yes',deletePath,repairIssue,deleteIssue}:null;
    let reader, finishTimer;
    const wizard=await startWizard({nas,arch,suggestion,version,
      menu,hostSetup:hostSetup==='true',
      onAccepted:({folder,password,deleteExisting})=>{process.stdout.write(menu?`${folder}\t${password}\t${deleteExisting?'loeschen':'neu'}\n`:`${folder}\t${password}\n`);},
      onRepair:()=>{process.stdout.write('WIEDER-STARTEN\n');},
      onRecheck:()=>{process.stdout.write('PRUEFEN\n');},
      onExpired:()=>{reader?.close();process.stdin.pause();process.stderr.write('[Bonni] Der Setup-Link ist abgelaufen.\n');process.exitCode=1;},
    });
    if(menu){
      reader=createInterface({input:process.stdin,crlfDelay:Infinity});
      reader.on('line',line=>{
        if(line.startsWith('preflight\t')){wizard.setPreflight(line);return;}
        if(wizard.setPhase(line)&&!finishTimer) finishTimer=setTimeout(()=>{wizard.close();reader.close();process.stdin.pause();},15_000);
      });
      reader.on('close',()=>{if(!finishTimer)wizard.close();});
    }
    process.stderr.write(`[Bonni] Einrichtungslink (privat): ${wizard.url}\n`);
  }catch{process.stderr.write('[Bonni] Browser-Assistent konnte nicht gestartet werden (Port 4180 oder Paketdateien prüfen).\n');process.exitCode=1;}
}
