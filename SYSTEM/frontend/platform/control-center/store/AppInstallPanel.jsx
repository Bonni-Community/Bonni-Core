import {useEffect,useState} from 'react';
import {apiRequest} from '../../../system/api/apiClient.js';
const base='/api/update/apps';
const errors={APP_SIGNATURE_INVALID:'Signatur ungültig oder App-Schlüssel unbekannt',APP_CORE_TOO_OLD:'Neuere Core-Version erforderlich',APP_RELEASE_REPLAY:'Diese oder eine neuere Ausgabe wurde bereits installiert',APP_GITHUB_ACCESS_UNAVAILABLE:'GitHub-Repository nicht öffentlich zugänglich oder nicht erreichbar',APP_PAYLOAD_CHANGED:'Paket beschädigt oder verändert'};
export default function AppInstallPanel({token,onInstalled}) {
  const [data,setData]=useState({local:[],remote:[]});
  const [repo,setRepo]=useState('');const [busy,setBusy]=useState(false);const [message,setMessage]=useState('');const [error,setError]=useState('');
  async function load(online=false) {
    setBusy(true);setError('');
    try {const next=await apiRequest(base+'/packages'+(online?'?online=true':''),{token});setData(next);setRepo(next.repository||'');}
    catch(e){setError(e.message||'App-Pakete konnten nicht geladen werden.');}
    finally {setBusy(false);}
  }
  useEffect(()=>{load(false);},[token]);
  async function save() {
    setBusy(true);setError('');
    try {await apiRequest(base+'/settings',{token,method:'PUT',body:{repository:repo.trim()}});setMessage('GitHub-Quelle gespeichert.');}
    catch(e){setError(e.message||'Quelle konnte nicht gespeichert werden.');}
    finally {setBusy(false);}
  }
  async function install(item,source) {
    const acceptDevRisk=item.channel==='dev'&&window.confirm('DEV-Version '+item.version+' installieren? Diese Entwicklungsversion ist noch nicht abschließend geprüft und kann Fehler enthalten.');
    if(item.channel==='dev'&&!acceptDevRisk)return;
    setBusy(true);setError('');setMessage('App wird geprüft, gesichert und installiert …');
    try {
      const result=await apiRequest(base+'/install',{token,allowFailover:false,method:'POST',body:{source,acceptDevRisk,appId:item.appId,version:item.version,filename:item.filename,sha256:item.sha256}});
      if(result.ok!==true)throw new Error(result.message||'Installation nicht bestätigt.');
      setMessage(result.alreadyInstalled?'Diese Ausgabe ist bereits installiert.':item.appId+' '+item.version+' wurde installiert und aktiviert.');
      await onInstalled?.();await load(source==='online');
    } catch(e){setMessage('');setError(e.message||'Die App konnte nicht installiert werden.');}
    finally {setBusy(false);}
  }
  function rows(items,source) {
    return items.length?<ul style={{listStyle:'none',padding:0}}>{items.map(item=><li key={item.sha256||item.filename} style={{display:'flex',gap:16,alignItems:'center',margin:'12px 0'}}>
      <span style={{flex:1}}><strong>{item.appId||item.filename}</strong>{item.version?' · '+item.version:''}
        {!item.error?<small style={{display:'block',color:item.channel==='dev'?'#f5bb63':undefined}}>{item.channel==='dev'?'DEV – Entwicklungsversion, noch nicht abschließend geprüft':'Stabile Version'}</small>:null}
        {item.minimumCoreVersion?<small style={{display:'block'}}>Ab Bonni Core {item.minimumCoreVersion}</small>:null}
        {item.error?<small style={{display:'block',color:'#ff8478'}}>{errors[item.error]||item.error}</small>:null}</span>
      <button type="button" disabled={busy||!!item.error||item.alreadyInstalled} onClick={()=>install(item,source)}>{item.alreadyInstalled?'Installiert':'Installieren'}</button>
    </li>)}</ul>:<p>{source==='offline'?'Keine App-Pakete im Eingangsordner gefunden.':'Noch keine Online-Pakete geladen.'}</p>;
  }
  return <section className="store-detail-block" aria-label="Apps installieren" aria-busy={busy}>
    <h2>Apps installieren</h2>
    <p>Online geladene und manuell abgelegte App-ZIPs verwenden denselben festen UPDATE-Ordner.</p>
    <details><summary>GitHub-Quelle</summary><div style={{display:'flex',gap:12,margin:'12px 0',flexWrap:'wrap'}}>
      <label>Repository <input value={repo} disabled={busy} onChange={e=>setRepo(e.target.value)} placeholder="Besitzer/Repository" /></label>
      <button type="button" disabled={busy} onClick={save}>Speichern</button>
    </div><small>Die Quelle muss für den direkten Download öffentlich erreichbar sein. Private Pakete kannst du angemeldet auf GitHub herunterladen und offline einspielen.</small></details>
    <h3>Offline-Pakete</h3>
    <p>Heruntergeladenes App-ZIP unverändert in <code>{data.inbox||'UPDATE'}</code> ablegen.</p>
    <button type="button" disabled={busy} onClick={()=>load(false)}>Ordner prüfen</button>
    {rows(data.local,'offline')}
    <h3>Online-Pakete</h3>
    <button type="button" disabled={busy||!data.repository} onClick={()=>load(true)}>GitHub prüfen</button>
    {rows(data.remote,'online')}
    {data.onlineError?<p role="alert">{errors[data.onlineError]||'Online-Quelle konnte nicht geladen werden. Offline-Pakete bleiben verfügbar.'}</p>:null}
    {message?<p role="status">{message}</p>:null}{error?<p role="alert" style={{color:'#ff8478'}}>{error}</p>:null}
  </section>;
}
