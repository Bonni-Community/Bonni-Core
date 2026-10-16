import {forwardRef,useEffect,useImperativeHandle,useState} from 'react';
import {apiRequest} from '../../../system/api/apiClient.js';
const base='/api/update/apps';
const errors={APP_SIGNATURE_INVALID:'Signatur ungültig oder App-Schlüssel unbekannt',APP_CORE_TOO_OLD:'Neuere Core-Version erforderlich',APP_RELEASE_REPLAY:'Diese oder eine neuere Ausgabe wurde bereits installiert',APP_GITHUB_ACCESS_UNAVAILABLE:'GitHub-Repository nicht öffentlich zugänglich oder nicht erreichbar',APP_PAYLOAD_CHANGED:'Paket beschädigt oder verändert',APP_INBOX_TOO_MANY_PACKAGES:'Mehr als 40 App-Pakete im UPDATE-Ordner. Bitte ältere Pakete aus dem Ordner nehmen.'};
const empty={local:[],remote:[]};
export default forwardRef(function AppInstallPanel({token,onInstalled,onChecked,onOperation,onRefresh},ref) {
  const [data,setData]=useState(empty),[repo,setRepo]=useState(''),[automatic,setAutomatic]=useState(true);
  const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const blocked=busy||checking;
  useEffect(()=>{onChecked?.(data);},[data,onChecked]);
  useEffect(()=>{onOperation?.({busy:blocked,message,error});},[blocked,message,error,onOperation]);
  useImperativeHandle(ref,()=>({refresh:load,install}));
  async function load() {
    setBusy(true);setError('');setMessage('UPDATE-Ordner und anschließend GitHub werden geprüft …');
    try {const next=await apiRequest(base+'/check',{token,method:'POST',allowFailover:false});setData(next);await onRefresh?.();setMessage('Prüfung abgeschlossen.');}
    catch(e){setError(e.message||'App-Pakete konnten nicht geprüft werden.');setMessage('');}
    finally {setBusy(false);}
  }
  useEffect(()=>{
    let alive=true;
    async function status(initial=false) {
      try {
        const next=await apiRequest(base+'/check-status',{token});if(!alive)return;
        setChecking(next.checking);
        if(initial){setRepo(next.repository||'');setAutomatic(next.checkAutomatically!==false);}
        if(next.result)setData(next.result);
        else setData(previous=>({...previous,inbox:next.inbox,repository:next.repository}));
      } catch(e){if(alive)setError(e.message||'Prüfstatus konnte nicht geladen werden.');}
    }
    void status(true);const timer=setInterval(()=>void status(),15000);
    return ()=>{alive=false;clearInterval(timer);};
  },[token]);
  async function save() {
    setBusy(true);setError('');
    try {await apiRequest(base+'/settings',{token,method:'PUT',body:{repository:repo.trim(),checkAutomatically:automatic}});setMessage('Einstellungen gespeichert.');}
    catch(e){setError(e.message||'Einstellungen konnten nicht gespeichert werden.');}
    finally {setBusy(false);}
  }
  async function install(item,source) {
    const acceptDevRisk=item.channel==='dev'&&window.confirm('DEV-Version '+item.version+' installieren? Diese Entwicklungsversion ist noch nicht abschließend geprüft und kann Fehler enthalten.');
    if(item.channel==='dev'&&!acceptDevRisk)return;
    setBusy(true);setError('');setMessage('App wird geprüft, gesichert und installiert …');
    try {
      const result=await apiRequest(base+'/install',{token,allowFailover:false,method:'POST',body:{source,acceptDevRisk,appId:item.appId,version:item.version,filename:item.filename,sha256:item.sha256}});
      if(result.ok!==true)throw new Error(result.message||'Installation nicht bestätigt.');
      await onInstalled?.();await load();
      setMessage(result.alreadyInstalled?'Diese Ausgabe ist bereits installiert.':item.appId+' '+item.version+' wurde installiert und aktiviert.');
    } catch(e){setMessage('');setError(e.message||'Die App konnte nicht installiert werden.');}
    finally {setBusy(false);}
  }
  function rows(items,source) {
    return items.length?<ul style={{listStyle:'none',padding:0}}>{items.map(item=><li key={item.sha256||item.filename} style={{display:'flex',gap:16,alignItems:'center',margin:'12px 0'}}>
      <span style={{flex:1}}><strong>{item.appId||item.filename}</strong>{item.version?' · '+item.version:''}
        {item.installedVersion?<small style={{display:'block'}}>Installiert: {item.installedVersion}{item.updateAvailable?' · Neue Version vorhanden':''}</small>:null}
        {!item.error?<small style={{display:'block',color:item.channel==='dev'?'#f5bb63':undefined}}>{item.channel==='dev'?'DEV – Entwicklungsversion, noch nicht abschließend geprüft':'Stabile Version'}</small>:null}
        {item.minimumCoreVersion?<small style={{display:'block'}}>Ab Bonni Core {item.minimumCoreVersion}</small>:null}
        {source==='online'&&!item.error?<small style={{display:'block'}}>GitHub-Meldung; Paketsignatur wird vor der Installation geprüft.</small>:null}
        {item.versionStatus==='unknown'?<small style={{display:'block'}}>Installierte Version konnte nicht verglichen werden.</small>:null}
        {item.error?<small style={{display:'block',color:'#ff8478'}}>{errors[item.error]||item.error}</small>:null}</span>
      <button type="button" disabled={blocked||!!item.error||item.alreadyInstalled||item.versionStatus==='older'||item.versionStatus==='unknown'} onClick={()=>install(item,source)}>{item.alreadyInstalled?'Installiert':item.versionStatus==='older'?'Ältere Version':item.updateAvailable?'Aktualisieren':'Installieren'}</button>
    </li>)}</ul>:<p>{source==='offline'?(data.checkedAt?'Keine App-Pakete im UPDATE-Ordner gefunden.':'Ordner noch nicht geprüft.'):(data.onlineState==='reachable'?'Keine App-Pakete auf GitHub gefunden.':'Keine Online-Ergebnisse verfügbar.')}</p>;
  }
  return <section className="store-detail-block" aria-label="Apps und Aktualisierungen" aria-busy={blocked}>
    <h2>Apps und Aktualisierungen</h2>
    <p>Die Prüfung sucht zuerst im UPDATE-Ordner und anschließend auf GitHub. Sie installiert nichts automatisch.</p>
    <button type="button" disabled={blocked} onClick={load} title="Aktualisieren" aria-label="Aktualisieren" style={{width:44,height:44,borderRadius:'50%',display:'inline-flex',alignItems:'center',justifyContent:'center'}}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" /></svg>
    </button>
    {blocked?<span role="status" style={{marginLeft:12}}>Bitte warten …</span>:null}
    {data.checkedAt?<p role="status">Letzte Prüfung: {new Date(data.checkedAt).toLocaleString('de-DE')} · {data.updateCount||0} App(s) mit neuerer Version{data.checkError?' · Ergebnis einer früheren Prüfung':''}</p>:null}
    {data.checkError?<p role="alert">Die letzte Prüfung ist fehlgeschlagen. Bitte erneut prüfen.</p>:null}
    <details><summary>Prüfung und GitHub-Quelle einstellen</summary>
      <p><label><input type="checkbox" checked={automatic} disabled={blocked} onChange={e=>setAutomatic(e.target.checked)} /> Automatisch nach Aktualisierungen suchen (alle 6 Stunden)</label></p>
      <div style={{display:'flex',gap:12,margin:'12px 0',flexWrap:'wrap'}}>
        <label>Repository <input value={repo} disabled={blocked} onChange={e=>setRepo(e.target.value)} placeholder="Besitzer/Repository" /></label>
        <button type="button" disabled={blocked} onClick={save}>Speichern</button>
      </div><small>Ohne GitHub-Quelle wird nur der UPDATE-Ordner geprüft. Die Quelle muss öffentlich erreichbar sein. Private Pakete kannst du angemeldet herunterladen und offline einspielen.</small>
    </details>
    <details><summary>Gefundene Pakete und Offline-Ordner</summary>
    <h3>Pakete im UPDATE-Ordner</h3>
    <p>Signiertes App-ZIP unverändert in <code>{data.inbox||'UPDATE'}</code> ablegen und die Prüfung starten.</p>
    {data.localError?<p role="alert">{errors[data.localError]||'UPDATE-Ordner konnte nicht vollständig geprüft werden.'}</p>:rows(data.local,'offline')}
    <h3>Pakete auf GitHub</h3>
    {data.onlineState==='not_configured'?<p>Keine GitHub-Quelle eingestellt. Der UPDATE-Ordner wurde geprüft.</p>:null}
    {data.onlineState==='unavailable'?<p role="status">GitHub-Prüfung nicht möglich: keine Verbindung, Quelle nicht zugänglich oder Anfrage fehlgeschlagen. Offline-Pakete bleiben verfügbar.</p>:null}
    {rows(data.remote,'online')}
    </details>
    {data.installedError?<p role="alert">Installierte App-Versionen konnten nicht gelesen werden. Bitte erneut prüfen.</p>:null}
    {message?<p role="status">{message}</p>:null}{error?<p role="alert" style={{color:'#ff8478'}}>{error}</p>:null}
  </section>;
});
