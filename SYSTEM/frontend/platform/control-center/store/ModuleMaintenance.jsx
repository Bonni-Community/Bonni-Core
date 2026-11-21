import {useState} from 'react';
import {apiRequest} from '../../../system/api/apiClient.js';

/** The extension owns the data and actions. Core offers only authenticated administration. */
export default function ModuleMaintenance({moduleKey,token}){
 const [state,setState]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const path='/api/system/runtime/modules/'+encodeURIComponent(moduleKey)+'/maintenance';
 async function run(action){setBusy(true);setError('');setMessage('');try{await action();}catch(e){setError(e.message||'Verwaltung konnte nicht geladen werden.');}finally{setBusy(false);}}
 async function status(){const result=await apiRequest(path,{token});if(result.schema!=='bonni.module-maintenance/v1')throw Error('Diese Verwaltung wird nicht unterstützt.');setState(result);}
 const invoke=(operation,body)=>apiRequest(path+'/'+operation,{token,method:'POST',body});
 async function download(){
  const file=await invoke('export',{});
  if(file.mimeType!=='application/zip'||typeof file.contentBase64!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64))throw Error('Ungültige Exportdatei.');
  const bytes=Uint8Array.from(atob(file.contentBase64),c=>c.charCodeAt(0)),url=URL.createObjectURL(new Blob([bytes],{type:file.mimeType}));
  const a=document.createElement('a');a.href=url;a.download=String(file.name||'Bonni-Wissen.zip').replace(/[^a-zA-Z0-9._-]/g,'_');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);await status();setMessage('Wissenspaket exportiert.');
 }
 return <section className="store-detail-block" aria-label="Erweiterte Modulverwaltung">
  <h3>{state?.title||'Erweiterte Verwaltung'}</h3>
  {!state?<button className="store-module-maintenance__load" type="button" disabled={busy} onClick={()=>void run(status)}>Verwaltung laden</button>:<>
   <p>{state.description}</p>
   {state.bonniId&&<p>Bonni-ID: <strong>{state.bonniId}</strong> · {state.addonId}</p>}
   {state.profiles?.map(profile=><div key={profile.id}>
    <label><input type="checkbox" disabled={busy} checked={profile.enabled} onChange={event=>{const enabled=event.target.checked;void run(async()=>{await invoke('configure',{profileId:profile.id,enabled});await status();});}}/>{profile.label}</label>
    <p>{profile.references} Referenzen · Lernstand {profile.revision}</p>
    {!!profile.examples?.length&&<details><summary>Lernbeispiele prüfen</summary><ul>{profile.examples.map(example=><li key={example.id}>{example.label} · {example.selected?'Referenz':example.status}{example.quality!==null?' · Qualität '+Math.round(example.quality*100)+' %':''}<p>{example.reason}</p>{example.status!=='withdrawn'&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await invoke('configure',{profileId:profile.id,exampleId:example.id});await status();})}>Lernbeispiel zurücknehmen</button>}</li>)}</ul></details>}
   </div>)}
   {!!state.origins?.length&&<table><thead><tr><th>Bonni-ID</th><th>Erweiterung</th><th>Wissensrevision</th></tr></thead><tbody>{state.origins.map(origin=><tr key={origin.bonniId+'|'+origin.addonId}><td>{origin.bonniId}</td><td>{origin.addonId}</td><td>{origin.revision}</td></tr>)}</tbody></table>}
   {state.canExport&&<><p>Exportiert die bestätigten Lebensmittelreferenzen dieser Installation als Bildmerkmale und Bezeichnungen.</p><button type="button" disabled={busy} onClick={()=>void run(download)}>Wissen als ZIP exportieren</button></>}
   <button type="button" disabled={busy} onClick={()=>void run(status)}>Lernstand aktualisieren</button>
  </>}
  {busy&&<p role="status">Bitte warten …</p>}{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}
 </section>;
}
