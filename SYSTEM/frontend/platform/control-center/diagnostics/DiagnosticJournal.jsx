import {useMemo,useState} from 'react';
import {catalog,groupedDiagnostics,stageLabel,diagnosticHint} from '../../../system/diagnostics/journalModel.js';
const STATUS={failed:'Fehler',succeeded:'Bestätigt',cancelled:'Abgebrochen',progress:'In Bearbeitung',log:'Meldung'};
const time=value=>new Date(value).toLocaleString('de-DE');
export default function DiagnosticJournal({journal,applications,searchLabel='Protokoll durchsuchen',onlyErrors=false,loading=false,onExport}){
 const [query,setQuery]=useState(''),[level,setLevel]=useState('all'),[limit,setLimit]=useState(50);
 const groups=useMemo(()=>groupedDiagnostics(journal?.entries||[],{query,level,onlyErrors}),[journal,query,level,onlyErrors]);
 const applicationNames=useMemo(()=>new Map(applications?.map(item=>[item.id,item.name])),[applications]);
 return <section className="cc-journal" aria-label={onlyErrors?'Fehlervorgänge':'Meldungen'}>
  {journal?.available===false&&<p className="cc-core-diagnostics-alert is-error" role="alert">Das Protokoll ist möglicherweise unvollständig.</p>}
  <div className="cc-journal-filters"><label>{searchLabel}<input type="search" value={query} onChange={e=>{setQuery(e.target.value);setLimit(50);}} placeholder="Meldung, Modul, Code oder Vorgangs-ID" /></label><label>Schweregrad<select value={level} onChange={e=>{setLevel(e.target.value);setLimit(50);}}><option value="all">Alle Meldungen</option><option value="error">Fehler</option><option value="warn">Warnungen</option><option value="info">Informationen</option></select></label></div>
  {journal?.truncated&&<p className="cc-journal-note">Die Suche erfasst die neuesten {journal.entries.length} von {journal.total} Meldungen. Der Export enthält alle verfügbaren Meldungen dieser Auswahl.</p>}
  {(query.trim()||level!=='all')&&groups.length>0&&<p className="cc-journal-count">{groups.length===1?'1 Ergebnis':`${groups.length} Ergebnisse`}</p>}
  {!groups.length&&<p className="cc-core-diagnostics-empty">{loading?'Protokoll wird geladen …':'Keine passenden Einträge im aktuellen Zeitraum.'}</p>}
  <div className="cc-journal-list">{groups.slice(0,limit).map(group=>{
   const hint=diagnosticHint(group),versions=group.entries.find(e=>e.appVersion),expected=group.entries.find(e=>e.expectedVersion)?.expectedVersion;
   const mismatch=versions?.appVersion&&expected&&versions.appVersion!==expected;
   const name=applicationNames.get(catalog.applicationAliases[group.moduleId]||group.moduleId)||group.moduleId;
   const stage=stageLabel(group.selected);
   return <details className={`cc-journal-item is-${group.status}`} key={group.key}>
    <summary><span className="cc-journal-time">{time(group.last.timestamp)}</span><span className="cc-journal-main"><strong>{name}{group.workflow?` · ${group.title}`:''}</strong><span>{stage}{group.selected.code&&stage!==group.selected.code?` · ${group.selected.code}`:''}</span></span><span className={`cc-journal-status is-${group.status}`}>{STATUS[group.status]}</span></summary>
    <div className="cc-journal-details">
     {name!==group.moduleId&&<p><b>Modul-ID</b> <code>{group.moduleId}</code></p>}
     {group.operationId&&<p><b>Vorgang:</b> <code>{group.operationId}</code></p>}
     {versions?.appVersion&&<p><b>Geladene Version:</b> {versions.appVersion}{expected?` · erwartet ${expected}`:''}</p>}
     {mismatch&&<p className="cc-journal-note">Die geladene Version weicht vom erwarteten Paket ab. Angezeigten Stand und Browser-Neuladen prüfen.</p>}
     {hint&&<p className="cc-journal-note">{hint}</p>}
     <p className="cc-journal-note">Zeitpunkte zeigen den Eingang im Core. Browsermeldungen können verzögert eintreffen.</p>
     <ol className="cc-journal-steps">{group.entries.map(entry=><li key={entry.id} className={entry.level==='error'||entry.level==='critical'?'is-error':''}><time>{time(entry.timestamp)}</time><div><strong>{stageLabel(entry)}</strong><small>{entry.source==='browser'?'Browsermeldung':'Servermeldung'}{entry.code?` · ${entry.code}`:''}{entry.statusCode?` · HTTP ${entry.statusCode}`:''}{entry.durationMs!==undefined?` · ${entry.durationMs} ms`:''}{entry.fileSize!==undefined?` · ${entry.fileSize} Bytes`:''}{entry.browser?` · ${entry.browser}`:''}</small>{entry.requestId&&<small>{entry.source==='browser'?'Meldeanfrage':'Anfrage'}: {entry.requestId}</small>}</div></li>)}</ol>
     {onExport&&group.operationId&&<button type="button" onClick={()=>onExport(group)}>Vorgang exportieren</button>}
    </div>
   </details>;
  })}</div>
  {groups.length>limit&&<button type="button" onClick={()=>setLimit(n=>n+50)}>Weitere 50 anzeigen</button>}
 </section>;
}
